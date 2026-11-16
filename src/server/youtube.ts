import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {config, root, slug, VIDEO_EXT} from './config';

export type YoutubeQuality = 'max' | '1080';
type Progress = (fraction: number, message: string) => void;

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'www.youtu.be',
]);

/** Valida e normaliza um link de vídeo do YouTube (evita links de canais vazios ou injeção de flags). */
export const validateYoutubeUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Cole o link do vídeo do YouTube.');
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withProto);
  } catch {
    throw new Error('Link inválido. Use um endereço completo do YouTube (ex.: https://www.youtube.com/watch?v=...).');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('Link inválido: protocolo não suportado.');
  }
  const host = u.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) {
    throw new Error('Informe um link do YouTube (youtube.com ou youtu.be).');
  }
  const hasVideo = host.endsWith('youtu.be')
    ? u.pathname.replace(/^\/+/, '').split('/')[0].length >= 6
    : (u.searchParams.get('v') ?? '').length >= 6 || /^\/(shorts|live|embed|v)\/[\w-]{6,}/.test(u.pathname);
  if (!hasVideo) {
    throw new Error('Esse link não aponta para um vídeo específico do YouTube.');
  }
  return u.toString();
};

const platformBinary = () => {
  if (process.platform === 'win32') return {exe: 'yt-dlp.exe', asset: 'yt-dlp.exe'};
  if (process.platform === 'darwin') return {exe: 'yt-dlp', asset: 'yt-dlp_macos'};
  return {exe: 'yt-dlp', asset: process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'};
};

const downloadYtDlpBinary = async (dest: string, asset: string, progress: Progress) => {
  progress(0.02, 'Baixando extrator oficial do YouTube (só na primeira vez)...');
  await fs.mkdir(path.dirname(dest), {recursive: true});
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  const res = await fetch(url, {redirect: 'follow'});
  if (!res.ok) throw new Error(`Não consegui baixar o extrator yt-dlp (HTTP ${res.status}). Verifique a conexão com a internet.`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${dest}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, buf);
  if (process.platform !== 'win32') await fs.chmod(tmp, 0o755);
  await fs.rename(tmp, dest);
  return dest;
};

const resolveYtDlp = async (progress: Progress): Promise<{bin: string; isBundled: boolean}> => {
  if (process.env.YTDLP_PATH && existsSync(process.env.YTDLP_PATH)) {
    return {bin: process.env.YTDLP_PATH, isBundled: false};
  }
  const {exe, asset} = platformBinary();
  const workBin = path.join(config.workDir, 'bin', exe);
  if (existsSync(workBin)) return {bin: workBin, isBundled: false};
  const bundledBin = path.join(root, 'node', exe);
  if (existsSync(bundledBin)) return {bin: bundledBin, isBundled: true};
  return {bin: await downloadYtDlpBinary(workBin, asset, progress), isBundled: false};
};

const moveAcrossDisks = async (src: string, dest: string) => {
  try {
    await fs.rename(src, dest);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EXDEV') throw e;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
};

const uniqueDestPath = (dir: string, fileName: string) => {
  const ext = path.extname(fileName) || '.mp4';
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, `${base}${ext}`);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n++})${ext}`);
  }
  return candidate;
};

const runYtDlpOnce = (
  bin: string,
  cleanUrl: string,
  quality: YoutubeQuality,
  tmpDir: string,
  useJsRuntime: boolean,
  progress: Progress,
) =>
  new Promise<void>((resolve, reject) => {
    const formatExpr = quality === '1080' ? 'bv*[height<=1080]+ba/b[height<=1080]/b' : 'bv*+ba/b';
    const formatSort = quality === '1080'
      ? 'res:1080,fps,vcodec:h264:vp9:av01,acodec:m4a'
      : 'res,fps,vcodec:h264:vp9:av01,acodec:m4a';
    const args = [
      '--no-playlist',
      '--no-part',
      '--windows-filenames',
      '--newline',
      '--no-warnings',
      ...(existsSync(config.ffmpeg) ? ['--ffmpeg-location', config.ffmpeg] : []),
      ...(useJsRuntime ? ['--js-runtimes', `node:${process.execPath}`] : []),
      '-f', formatExpr,
      '-S', formatSort,
      '--merge-output-format', 'mp4',
      '--remux-video', 'mp4',
      '--progress-template', 'download:[autocut] %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
      '-o', path.join(tmpDir, '%(title).80B [%(id)s].%(ext)s'),
      '--',
      cleanUrl,
    ];

    const p = spawn(bin, args, {windowsHide: true});
    let errLog = '';
    let streamIdx = 0;

    const handleChunk = (chunk: Buffer, isErr: boolean) => {
      const text = chunk.toString();
      if (isErr) errLog = (errLog + text).slice(-30_000);
      for (const line of text.split(/[\r\n]+/)) {
        if (!line) continue;
        if (/^\[download\] Destination:/i.test(line)) {
          streamIdx += 1;
          continue;
        }
        const m = line.match(/\[autocut\]\s*([\d.]+)%\|([^|]*)\|(.*)/);
        if (m) {
          const pct = Math.min(100, Math.max(0, Number(m[1])));
          const speed = m[2].trim();
          const eta = m[3].trim();
          const frac = streamIdx <= 1 ? 0.06 + 0.74 * (pct / 100) : 0.80 + 0.14 * (pct / 100);
          const stage = streamIdx <= 1 ? 'Baixando vídeo em alta definição' : 'Baixando faixa de áudio';
          const details = [
            `${Math.round(pct)}%`,
            speed && !/NA|Unknown/i.test(speed) ? speed : '',
            eta && !/NA|Unknown/i.test(eta) ? `ETA ${eta}` : '',
          ].filter(Boolean).join(' · ');
          progress(frac, `${stage} (${details})`);
          continue;
        }
        if (/^\[(Merger|Fixup|VideoRemuxer)/i.test(line)) {
          progress(0.96, 'Unindo vídeo e áudio em MP4 de alta definição...');
        }
      }
    };

    p.stdout.on('data', (d: Buffer) => handleChunk(d, false));
    p.stderr.on('data', (d: Buffer) => handleChunk(d, true));
    p.on('error', (e) => reject(new Error(`Não consegui executar o extrator yt-dlp: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0) return resolve();
      const errLine = errLog
        .split(/[\r\n]+/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('ERROR:'))
        .pop();
      const detail = errLine ? errLine.replace(/^ERROR:\s*(\[[^\]]+\]\s*[^:]+:\s*)?/, '') : errLog.trim().split(/[\r\n]+/).pop() || `código ${code}`;
      reject(Object.assign(new Error(`Falha ao baixar do YouTube: ${detail}`), {rawStderr: errLog}));
    });
  });

export const downloadYoutubeVideo = async (
  rawUrl: string,
  quality: YoutubeQuality,
  progress: Progress,
): Promise<{id: string; file: string; sizeMB: number}> => {
  const cleanUrl = validateYoutubeUrl(rawUrl);
  await fs.mkdir(config.videosDir, {recursive: true});
  const tmpDir = path.join(config.workDir, 'tmp', `yt-${randomUUID()}`);
  await fs.mkdir(tmpDir, {recursive: true});

  try {
    let {bin, isBundled} = await resolveYtDlp(progress);
    progress(0.05, 'Consultando formatos de alta definição no YouTube...');

    const attempt = async (binary: string) => {
      try {
        await runYtDlpOnce(binary, cleanUrl, quality, tmpDir, true, progress);
      } catch (e: unknown) {
        const raw = (e as {rawStderr?: string})?.rawStderr ?? '';
        if (raw.includes('no such option: --js-runtimes')) {
          await runYtDlpOnce(binary, cleanUrl, quality, tmpDir, false, progress);
        } else {
          throw e;
        }
      }
    };

    try {
      await attempt(bin);
    } catch (firstErr) {
      // Se o binário embutido do instalador ficou desatualizado frente ao YouTube, baixa a versão mais nova e tenta mais uma vez.
      if (!isBundled) throw firstErr;
      const {exe, asset} = platformBinary();
      const updatedBin = await downloadYtDlpBinary(path.join(config.workDir, 'bin', exe), asset, progress);
      await fs.rm(tmpDir, {recursive: true, force: true});
      await fs.mkdir(tmpDir, {recursive: true});
      progress(0.05, 'Tentando novamente com o extrator atualizado...');
      await attempt(updatedBin);
    }

    const produced = (await fs.readdir(tmpDir))
      .filter((f) => VIDEO_EXT.test(f) && !f.endsWith('.part') && !/\.f\d+\./i.test(f));
    const chosen = produced.find((f) => f.toLowerCase().endsWith('.mp4')) ?? produced[0];
    if (!chosen) throw new Error('O download terminou, mas nenhum arquivo MP4 foi encontrado.');

    const destPath = uniqueDestPath(config.videosDir, chosen);
    const finalFile = path.basename(destPath);
    progress(0.99, 'Salvando MP4 na pasta de vídeos brutos...');
    await moveAcrossDisks(path.join(tmpDir, chosen), destPath);
    const stat = await fs.stat(destPath);
    return {
      id: slug(finalFile),
      file: finalFile,
      sizeMB: Math.max(1, Math.round(stat.size / 1e6)),
    };
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true}).catch(() => undefined);
  }
};
