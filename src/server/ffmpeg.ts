import {spawn} from 'node:child_process';
import {config} from './config';

export const parseClock = (s: string) => {
  const [h, m, sec] = s.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(sec);
};

type RunOpts = {
  /** Chamado com o tempo (s) já processado, lido do progresso do ffmpeg. */
  onTime?: (sec: number) => void;
  onStdout?: (chunk: Buffer) => void;
  allowFail?: boolean;
};

/** Roda o ffmpeg e devolve o stderr completo. */
export const ffmpeg = (args: string[], opts: RunOpts = {}) =>
  new Promise<string>((resolve, reject) => {
    const p = spawn(config.ffmpeg, ['-hide_banner', ...args], {windowsHide: true});
    let err = '';
    p.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      err = (err + s).slice(-400_000);
      const m = [...s.matchAll(/time=(\d+:\d+:\d+\.\d+)/g)].pop();
      if (m && opts.onTime) opts.onTime(parseClock(m[1]));
    });
    p.stdout.on('data', (d: Buffer) => opts.onStdout?.(d));
    p.on('error', (e) => reject(new Error(`Não consegui executar o ffmpeg: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0 || opts.allowFail) resolve(err);
      else reject(new Error(`ffmpeg falhou (${code}): ${err.split('\n').slice(-4).join(' ')}`));
    });
  });

export const run = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, {windowsHide: true, stdio: 'ignore'});
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} saiu com ${code}`))));
  });

export const probe = async (file: string) => {
  const out = await ffmpeg(['-i', file], {allowFail: true});
  const dur = out.match(/Duration: (\d+:\d+:\d+\.\d+)/);
  const vid = out.match(/Stream #.*Video:.*?(\d{2,5})x(\d{2,5})/);
  const fps = out.match(/Stream #.*Video:.*?([\d.]+) fps/);
  if (!dur || !vid) throw new Error('Não consegui ler o vídeo (arquivo inválido ou corrompido).');
  const rotated = /rotation of -?(90|270)/.test(out);
  const [w, h] = [Number(vid[1]), Number(vid[2])];
  return {
    duration: parseClock(dur[1]),
    width: rotated ? h : w,
    height: rotated ? w : h,
    fps: fps ? Number(fps[1]) : 30,
    hasAudio: /Stream #.*Audio:/.test(out),
  };
};

let nvencWorks = config.nvenc;

/**
 * Roda um comando de conversão escolhendo o codificador de vídeo: a placa NVIDIA (NVENC)
 * quando RENDER_NVENC=1, ou o processador (libx264). Se a placa falhar uma vez, volta
 * para o processador e não tenta mais nesta execução.
 * `quality` segue a escala do x264 (menor = melhor): 18 para o vídeo final, 26 para a prévia.
 */
export const encode = async (build: (videoCodec: string[]) => string[], quality: number, opts: RunOpts = {}) => {
  const x264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(quality)];
  if (nvencWorks) {
    try {
      return await ffmpeg(build(['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(quality + 2), '-b:v', '0']), opts);
    } catch (e) {
      nvencWorks = false;
      console.warn('NVENC falhou; usando o processador para codificar.', e instanceof Error ? e.message : e);
    }
  }
  return ffmpeg(build(x264), opts);
};
