import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {ensureBrowser, RenderInternals, renderMedia, selectComposition} from '@remotion/renderer';
import {
  buildProps, expand, extrasFrom, FPS, layout, MUSIC_FADE_IN, MUSIC_FADE_OUT,
  type Quality, type Style,
  type Analysis, type AutoCutProps, type EditPlan, type VideoPlan,
} from '../shared/types';
import {config, slug} from './config';
import {encode, ffmpeg} from './ffmpeg';

type Progress = (fraction: number, message: string) => void;

let bundled: Promise<string> | null = null;
const getBundle = () => {
  bundled ??= bundle({entryPoint: path.resolve('src/remotion/index.ts')}).catch((e) => {
    bundled = null;
    throw e;
  });
  return bundled;
};

/**
 * Algumas falhas internas do Remotion (como o download do navegador sem internet) viram
 * rejeições sem tratamento, e a promessa original nunca termina. Isto transforma essas
 * falhas em erro da própria tarefa.
 */
const catchStray = <T,>(p: Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    const onStray = (e: unknown) => {
      process.off('unhandledRejection', onStray);
      reject(e);
    };
    process.on('unhandledRejection', onStray);
    p.then(
      (v) => { process.off('unhandledRejection', onStray); resolve(v); },
      (e) => { process.off('unhandledRejection', onStray); reject(e); },
    );
  });

let browserReady = false;
const prepareBrowser = async (progress: Progress) => {
  if (browserReady || config.browserExecutable) return;
  try {
    await catchStray(ensureBrowser({
      onBrowserDownload: () => {
        progress(0.3, 'Baixando o navegador de renderização (só na primeira vez, cerca de 100 MB)');
        return {version: null, onProgress: ({percent}) => progress(0.3, `Baixando o navegador de renderização: ${Math.round(percent * 100)}%`)};
      },
    }));
    browserReady = true;
  } catch (e) {
    throw new Error(`Não consegui baixar o navegador de renderização. A primeira exportação precisa de internet. (${e instanceof Error ? e.message : e})`);
  }
};

let nvencOk: boolean | null = null;

/**
 * Testa uma vez se o ffmpeg do Remotion consegue codificar com a placa NVIDIA,
 * convertendo alguns quadros de um trecho já recortado. Sem esse teste, uma falha
 * da placa no meio da renderização derrubaria o programa.
 */
const nvencAvailable = async (sample: string) => {
  if (nvencOk === null) {
    try {
      await RenderInternals.callFf({
        bin: 'ffmpeg',
        args: ['-hide_banner', '-i', sample, '-frames:v', '10', '-an', '-c:v', 'h264_nvenc', '-f', 'null', '-'],
        indent: false,
        logLevel: 'error',
        binariesDirectory: null,
        cancelSignal: undefined,
      });
      nvencOk = true;
      console.log('NVENC disponível: codificando o vídeo final com a placa NVIDIA.');
    } catch (e) {
      nvencOk = false;
      console.warn('NVENC indisponível; codificando o vídeo final pelo processador.');
    }
  }
  return nvencOk;
};

/** atempo só aceita de 0,5 a 2 por vez; encadeia para chegar em 0,25x ou 4x. */
const atempo = (speed: number) => {
  const parts: string[] = [];
  let s = speed;
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  while (s > 2) { parts.push('atempo=2.0'); s /= 2; }
  if (Math.abs(s - 1) > 0.001) parts.push(`atempo=${s.toFixed(4)}`);
  return parts;
};

/**
 * Monta a trilha de áudio inteira com o ffmpeg, com fusão curta entre os trechos,
 * nas mesmas posições que o Remotion usa para a imagem. Assim o som do vídeo final
 * é contínuo e não depende do áudio gerado pelo navegador durante a renderização.
 */
const buildAudio = async (props: AutoCutProps, clipFiles: string[], musicFile: string | null, out: string) => {
  const {frames, trans, starts, total} = layout(props);
  const sec = (f: number) => (f / FPS).toFixed(4);
  const stereo = 'aresample=48000,aformat=channel_layouts=stereo';
  const chains = clipFiles.map((_, i) => {
    const clip = props.clips[i];
    const fadeOut = trans[i + 1] ?? 0;
    const f = [
      stereo, ...atempo(clip.speed), 'apad', `atrim=0:${sec(frames[i])}`, 'asetpts=PTS-STARTPTS',
      // Rampa mínima de 2 quadros evita estalo mesmo sem sobreposição.
      `afade=t=in:st=0:d=${sec(Math.max(trans[i], 2))}`,
      `afade=t=out:st=${sec(frames[i] - Math.max(fadeOut, 2))}:d=${sec(Math.max(fadeOut, 2))}`,
      `adelay=delays=${Math.round((starts[i] / FPS) * 1000)}:all=1`,
    ];
    return `[${i}:a]${f.join(',')}[a${i}]`;
  });
  const n = clipFiles.length;
  const labels = clipFiles.map((_, i) => `[a${i}]`);
  const inputs = clipFiles.flatMap((f) => ['-i', f]);
  if (musicFile && props.music) {
    // Música em laço, no volume escolhido, entrando e saindo com rampa.
    const totalSec = total / FPS;
    const fadeOut = Math.min(MUSIC_FADE_OUT, totalSec / 3);
    inputs.push('-stream_loop', '-1', '-i', musicFile);
    chains.push(
      `[${n}:a]${stereo},volume=${props.music.volume.toFixed(3)},afade=t=in:st=0:d=${MUSIC_FADE_IN},` +
      `afade=t=out:st=${(totalSec - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[bg]`,
    );
    labels.push('[bg]');
  }
  const mix = labels.length > 1
    ? `${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,apad[out]`
    : `${labels[0]}apad[out]`;
  await ffmpeg([
    '-y', ...inputs,
    '-filter_complex', [...chains, mix].join(';'), '-map', '[out]',
    '-t', sec(total), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', out,
  ]);
};

/**
 * Codec e qualidade de cada opção de saída. `crf` vale para o processador (menor = melhor);
 * `bitrate` vale para a placa NVIDIA, que não aceita crf e, sem um valor, usaria uma taxa
 * muito baixa. Os valores são para 1080p a 30 quadros por segundo.
 */
const QUALITY: Record<Quality, {codec: 'h264' | 'h265'; crf: number; bitrate: string}> = {
  alta: {codec: 'h264', crf: 18, bitrate: '12M'},
  equilibrada: {codec: 'h264', crf: 23, bitrate: '6M'},
  compacta: {codec: 'h265', crf: 26, bitrate: '4M'},
};

export const renderVideo = async (
  projectId: string,
  original: string,
  analysis: Analysis,
  plan: EditPlan,
  video: VideoPlan,
  style: Style,
  quality: Quality,
  progress: Progress,
) => {
  const dir = path.join(config.workDir, projectId);
  const clipsDir = path.join(dir, 'clips', video.id);
  await fs.rm(clipsDir, {recursive: true, force: true});
  await fs.mkdir(clipsDir, {recursive: true});
  await fs.mkdir(config.outputDir, {recursive: true});

  // 1. Recorta do arquivo original só os trechos usados (em qualidade alta).
  // (um trecho com replay vira dois pedaços; a lista é a mesma usada na prévia)
  const extras = extrasFrom(analysis, plan, style, `http://127.0.0.1:${config.port}/music`);
  const segs = expand(video, extras.fx);
  const totalSec = segs.reduce((n, s) => n + (s.end - s.start), 0);
  let doneSec = 0;
  for (const [i, s] of segs.entries()) {
    const dur = s.end - s.start;
    const padDur = Math.min(dur + 0.15 * (s.speed ?? 1), Math.max(0.1, analysis.duration - s.start));
    await encode(
      (codec) => ['-y', '-ss', s.start.toFixed(3), '-i', original, '-t', padDur.toFixed(3),
        '-vf', "fps=30,scale=-2:'min(1080,ih)'", ...codec,
        '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart', path.join(clipsDir, `${i}.mp4`)],
      18,
      {onTime: (t) => progress(0.3 * ((doneSec + Math.min(t, dur)) / totalSec), `Recortando trecho ${i + 1} de ${segs.length}`)},
    );
    doneSec += dur;
  }

  // 2. Renderiza com o Remotion.
  await prepareBrowser(progress);
  progress(0.3, 'Preparando o Remotion');
  const serveUrl = await getBundle();
  const base = `http://127.0.0.1:${config.port}/media/${projectId}/clips/${video.id}`;
  const inputProps = buildProps(video, extras, (i) => ({
    src: `${base}/${i}.mp4`,
    offsetSec: 0,
  }));
  const chromiumOptions = config.gl ? {gl: config.gl} : undefined;
  const composition = await selectComposition({
    serveUrl,
    id: 'AutoCut',
    inputProps,
    chromiumOptions,
    browserExecutable: config.browserExecutable,
  });
  const output = path.join(config.outputDir, `${slug(analysis.file)}_${video.id}.mp4`);
  const silent = path.join(clipsDir, 'video.mp4');
  // path.basename impede que o nome da música aponte para fora da pasta de músicas.
  const musicPath = video.music ? path.join(config.musicDir, path.basename(video.music)) : null;
  const musicFile = musicPath && existsSync(musicPath) ? musicPath : null;
  if (video.music && !musicFile) throw new Error(`Música não encontrada: ${video.music}`);
  const hasSound = analysis.hasAudio || Boolean(musicFile);
  const q = QUALITY[quality];
  const render = (gpuEncode: boolean) =>
    renderMedia({
      composition,
      serveUrl,
      codec: q.codec,
      ...(gpuEncode ? {videoBitrate: q.bitrate} : {crf: q.crf}),
      outputLocation: hasSound ? silent : output,
      inputProps,
      muted: true, // o som é montado à parte, logo abaixo
      chromiumOptions, // RENDER_GL=angle: o Chrome desenha os quadros usando a placa de vídeo
      hardwareAcceleration: gpuEncode ? 'if-possible' : 'disable', // RENDER_NVENC=1: codifica com NVIDIA
      concurrency: config.concurrency ? (/%$/.test(config.concurrency) ? config.concurrency : Number(config.concurrency)) : undefined,
      browserExecutable: config.browserExecutable,
      onProgress: ({progress: p}) => progress(0.3 + 0.65 * p, 'Renderizando'),
    });
  await render(config.nvenc && (await nvencAvailable(path.join(clipsDir, '0.mp4'))));

  // 3. Monta o áudio com o ffmpeg e junta com a imagem (sem recomprimir o vídeo).
  if (hasSound) {
    progress(0.96, 'Montando o áudio');
    const audio = path.join(clipsDir, 'audio.m4a');
    const clipFiles = analysis.hasAudio ? segs.map((_, i) => path.join(clipsDir, `${i}.mp4`)) : [];
    await buildAudio(inputProps, clipFiles, musicFile, audio);
    await ffmpeg(['-y', '-i', silent, '-i', audio, '-map', '0:v', '-map', '1:a', '-c', 'copy',
      ...(q.codec === 'h265' ? ['-tag:v', 'hvc1'] : []), // para o H.265 abrir em aparelhos Apple
      '-movflags', '+faststart', output]);
  }
  await fs.rm(clipsDir, {recursive: true, force: true});
  return {output};
};
