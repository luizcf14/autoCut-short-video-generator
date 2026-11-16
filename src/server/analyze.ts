import fs from 'node:fs/promises';
import path from 'node:path';
import type {Analysis, Subtitle} from '../shared/types';
import {config} from './config';
import {encode, ffmpeg, probe, run} from './ffmpeg';

type Progress = (fraction: number, message: string) => void;

/** Volume (dB) por segundo, lendo o áudio como PCM mono de 8 kHz. */
const loudnessPerSecond = async (file: string) => {
  const RATE = 8000;
  const out: number[] = [];
  let sum = 0;
  let n = 0;
  let leftover: Buffer | null = null;
  await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], {
    onStdout: (chunk) => {
      const buf: Buffer = leftover ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const v = buf.readInt16LE(i) / 32768;
        sum += v * v;
        if (++n === RATE) {
          out.push(Math.round(10 * Math.log10(sum / n + 1e-10) * 10) / 10);
          sum = 0;
          n = 0;
        }
      }
      leftover = usable < buf.length ? buf.subarray(usable) : null;
    },
  });
  return out;
};

/** Momentos mais barulhentos em relação à média, separados por `gap` segundos. */
export const findPeaks = (loud: number[], count: number, gap = 10) => {
  const smooth = loud.map((_, i) => {
    const w = loud.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
  const order = smooth.map((db, t) => ({t, db})).sort((a, b) => b.db - a.db);
  const peaks: {t: number; db: number}[] = [];
  for (const c of order) {
    if (peaks.length >= count) break;
    if (peaks.every((p) => Math.abs(p.t - c.t) >= gap)) peaks.push({t: c.t, db: Math.round(c.db * 10) / 10});
  }
  return peaks.sort((a, b) => a.t - b.t);
};

const sceneChanges = async (proxy: string) => {
  const err = await ffmpeg(['-i', proxy, '-vf', "select='gt(scene,0.35)',showinfo", '-an', '-f', 'null', '-']);
  return [...err.matchAll(/pts_time:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 10) / 10);
};

const transcribe = async (proxy: string, dir: string): Promise<Subtitle[]> => {
  const wav = path.join(dir, 'audio.wav');
  try {
    await ffmpeg(['-y', '-i', proxy, '-vn', '-ac', '1', '-ar', '16000', wav]);
    await run(config.whisperCmd, [
      wav, '--model', config.whisperModel, '--language', 'pt',
      '--output_format', 'json', '--output_dir', dir,
    ]);
    const json = JSON.parse(await fs.readFile(path.join(dir, 'audio.json'), 'utf8'));
    return (json.segments as any[])
      .filter((s) => (s.no_speech_prob ?? 0) < 0.6 && String(s.text).trim().length > 1)
      .map((s) => ({start: s.start, end: s.end, text: String(s.text).trim()}));
  } catch {
    return []; // Whisper não instalado ou sem fala: segue sem transcrição.
  } finally {
    await fs.rm(wav, {force: true});
  }
};

export const analyze = async (file: string, dir: string, progress: Progress): Promise<Analysis> => {
  await fs.mkdir(path.join(dir, 'frames'), {recursive: true});
  const info = await probe(file);
  const proxy = path.join(dir, 'proxy.mp4');

  progress(0.02, 'Criando versão leve para prévia');
  await encode(
    (codec) => ['-y', '-i', file, '-vf', 'fps=30,scale=-2:540', ...codec,
      '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      '-movflags', '+faststart', proxy],
    26,
    {onTime: (t) => progress(0.02 + 0.68 * Math.min(1, t / info.duration), 'Criando versão leve para prévia')},
  );

  progress(0.72, 'Medindo o áudio');
  const loudness = info.hasAudio ? await loudnessPerSecond(proxy) : [];
  const peaks = findPeaks(loudness, 14);

  progress(0.78, 'Detectando mudanças de cena');
  const scenes = await sceneChanges(proxy);

  progress(0.84, 'Extraindo quadros');
  const nPeak = Math.min(peaks.length, Math.floor(config.maxFrames / 4));
  const nUniform = Math.max(4, Math.min(config.maxFrames - nPeak, Math.ceil(info.duration / 4)));
  const times = new Set<number>();
  for (let i = 0; i < nUniform; i++) times.add(Math.round(((i + 0.5) * info.duration) / nUniform));
  [...peaks].sort((a, b) => b.db - a.db).slice(0, nPeak).forEach((p) => times.add(p.t));
  const frames: Analysis['frames'] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const name = `f_${String(t).padStart(6, '0')}.jpg`;
    await ffmpeg(['-y', '-ss', String(t), '-i', proxy, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '6',
      path.join(dir, 'frames', name)]);
    frames.push({t, file: name});
  }

  progress(0.92, 'Procurando fala para transcrever');
  const transcript = info.hasAudio ? await transcribe(proxy, dir) : [];

  const analysis: Analysis = {file: path.basename(file), ...info, loudness, peaks, scenes, frames, transcript};
  await fs.writeFile(path.join(dir, 'analysis.json'), JSON.stringify(analysis));
  return analysis;
};
