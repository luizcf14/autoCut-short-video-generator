import dotenv from 'dotenv';
import {mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

dotenv.config({path: path.join(process.cwd(), '.env')});

export const root = process.cwd();
export const envFile = path.join(root, '.env');

/** Lê as configurações do ambiente (.env já carregado em process.env). */
const compute = () => {
  const videosDir = path.resolve(process.env.VIDEOS_DIR || path.join(root, 'videos'));
  return {
    port: Number(process.env.PORT || 3001),
    videosDir,
    workDir: path.resolve(process.env.WORK_DIR || path.join(root, 'work')),
    outputDir: path.resolve(process.env.OUTPUT_DIR || path.join(videosDir, 'prontos')),
    musicDir: path.resolve(process.env.MUSIC_DIR || path.join(videosDir, 'musicas')),
    stylesDir: path.resolve(process.env.STYLES_DIR || path.join(root, 'estilos')),
    geminiKey: process.env.GEMINI_API_KEY || '',
    elevenKey: process.env.ELEVENLABS_API_KEY || '',
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
    channelName: process.env.CHANNEL_NAME || '',
    ffmpeg: process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string) || 'ffmpeg',
    whisperCmd: process.env.WHISPER_CMD || 'whisper',
    whisperModel: process.env.WHISPER_MODEL || 'small',
    maxFrames: Number(process.env.MAX_FRAMES || 48),
    // Aceleração por placa de vídeo (opcional, desligada por padrão).
    gl: (process.env.RENDER_GL || undefined) as 'angle' | 'egl' | 'vulkan' | 'swangle' | undefined,
    nvenc: /^(1|true|sim)$/i.test(process.env.RENDER_NVENC || ''),
    concurrency: process.env.RENDER_CONCURRENCY || undefined,
    browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE || undefined,
  };
};

export const DEFAULT_MODEL = 'claude-fable-5-2';
export const config = compute();

// O Remotion, o Chrome que ele usa e o empacotador gravam arquivos temporários grandes
// na pasta TEMP do sistema (no Windows, o disco C). Redireciona para dentro de WORK_DIR.
let tmpDir = '';
const pointTmp = () => {
  tmpDir = path.join(config.workDir, 'tmp');
  mkdirSync(tmpDir, {recursive: true});
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = tmpDir;
};
pointTmp();

/** Relê as configurações depois que a tela de Configurações salvou o .env. */
export const reloadConfig = () => {
  Object.assign(config, compute());
  pointTmp();
};

/** Apaga as sobras da execução anterior. Só é chamado depois que o servidor abriu a porta,
 * para uma segunda janela aberta por engano não apagar os arquivos de uma exportação em andamento. */
export const cleanTmp = () => {
  rmSync(tmpDir, {recursive: true, force: true});
  mkdirSync(tmpDir, {recursive: true});
};

export const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|flac)$/i;
export const VIDEO_EXT = /\.(mp4|mov|mkv|m4v|avi|webm)$/i;

export const slug = (file: string) =>
  file
    .replace(/\.[^.]+$/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // tira os acentos
    .replace(/[^\w-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'video';
