import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {config, DEFAULT_MODEL, envFile, reloadConfig, root} from './config';

/**
 * Configurações editáveis pela tela. Cada uma corresponde a uma variável do .env.
 * As chaves de API nunca voltam inteiras para o navegador: só os últimos caracteres.
 */
export const SETTINGS = {
  ANTHROPIC_API_KEY: {secret: true},
  CLAUDE_MODEL: {},
  GEMINI_API_KEY: {secret: true},
  ELEVENLABS_API_KEY: {secret: true},
  MUSIC_PROVIDER: {choices: ['', 'gemini', 'elevenlabs']},
  CHANNEL_NAME: {},
  VIDEOS_DIR: {dir: true},
  OUTPUT_DIR: {dir: true},
  WORK_DIR: {dir: true},
  MUSIC_DIR: {dir: true},
  RENDER_NVENC: {choices: ['', '1']},
  RENDER_GL: {choices: ['', 'angle']},
  RENDER_CONCURRENCY: {choices: ['', '50%', '75%', '100%']},
  MAX_FRAMES: {number: [16, 150]},
} as const satisfies Record<string, {secret?: boolean; dir?: boolean; choices?: readonly string[]; number?: readonly [number, number]}>;

export type SettingKey = keyof typeof SETTINGS;
const KEYS = Object.keys(SETTINGS) as SettingKey[];

const mask = (v: string) => (v ? `••••${v.slice(-4)}` : '');

/** Espaço livre (GB) no disco de uma pasta, ou da pasta-mãe mais próxima que exista. */
const freeGB = async (dir: string) => {
  let d = path.resolve(dir);
  while (!existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try {
    const s = await fs.statfs(d);
    return Math.round(((s.bavail * s.bsize) / 1e9) * 10) / 10;
  } catch {
    return null;
  }
};

export const readSettings = async () => {
  const values: Record<string, string> = {};
  for (const k of KEYS) {
    const v = process.env[k] ?? '';
    values[k] = 'secret' in SETTINGS[k] ? mask(v) : v;
  }
  const folders = {
    VIDEOS_DIR: config.videosDir,
    OUTPUT_DIR: config.outputDir,
    WORK_DIR: config.workDir,
    MUSIC_DIR: config.musicDir,
  };
  const info: Record<string, {path: string; exists: boolean; freeGB: number | null}> = {};
  for (const [k, p] of Object.entries(folders)) info[k] = {path: p, exists: existsSync(p), freeGB: await freeGB(p)};
  return {values, folders: info, defaultModel: DEFAULT_MODEL, envFile, root};
};

/** Escreve um valor no .env, preservando comentários e a ordem das linhas. */
const quote = (v: string) => (/[#'"\s]/.test(v) || v !== v.trim() ? `'${v.replace(/'/g, '')}'` : v);

const writeEnv = async (changes: Partial<Record<SettingKey, string>>) => {
  let text = existsSync(envFile) ? await fs.readFile(envFile, 'utf8') : '';
  if (!text && existsSync(path.join(root, '.env.example'))) text = await fs.readFile(path.join(root, '.env.example'), 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  for (const [key, value] of Object.entries(changes) as [SettingKey, string][]) {
    const active = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    // O último exemplo comentado (os primeiros costumam ser linhas de explicação).
    let commented = -1;
    lines.forEach((l, i) => {
      if (new RegExp(`^\\s*#\\s*${key}\\s*=`).test(l)) commented = i;
    });
    const line = `${key}=${quote(value)}`;
    if (active >= 0) {
      lines[active] = value ? line : `# ${key}=`;
    } else if (value && commented >= 0) {
      lines.splice(commented + 1, 0, line); // logo abaixo do exemplo comentado
    } else if (value) {
      lines.push(line);
    }
  }
  await fs.writeFile(envFile, lines.join(eol));
};

export class SettingsError extends Error {}

/**
 * Salva as configurações recebidas da tela. Chaves vazias ou mascaradas mantêm o valor atual;
 * `clear` lista as chaves que devem ser apagadas.
 */
export const saveSettings = async (body: Record<string, unknown>, clear: string[] = []) => {
  const changes: Partial<Record<SettingKey, string>> = {};
  const warnings: string[] = [];
  for (const k of KEYS) {
    const spec = SETTINGS[k] as {secret?: boolean; dir?: boolean; choices?: readonly string[]; number?: readonly [number, number]};
    if (clear.includes(k)) {
      changes[k] = '';
      continue;
    }
    if (!(k in body)) continue;
    let v = String(body[k] ?? '').trim();
    if (/[\r\n]/.test(v)) throw new SettingsError(`Valor inválido em ${k}.`);
    if (spec.secret) {
      if (!v || v.startsWith('••••')) continue; // não mexe na chave já salva
    }
    if (spec.choices && !spec.choices.includes(v)) throw new SettingsError(`Valor inválido em ${k}.`);
    if (spec.number && v) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < spec.number[0] || n > spec.number[1]) {
        throw new SettingsError(`${k} deve ficar entre ${spec.number[0]} e ${spec.number[1]}.`);
      }
      v = String(Math.round(n));
    }
    if (spec.dir && v) {
      v = path.resolve(v);
      if (k === 'VIDEOS_DIR' && !existsSync(v)) throw new SettingsError(`A pasta de vídeos não existe: ${v}`);
      if (!existsSync(v)) {
        try {
          await fs.mkdir(v, {recursive: true});
          warnings.push(`Pasta criada: ${v}`);
        } catch {
          throw new SettingsError(`Não consegui criar a pasta: ${v}`);
        }
      }
    }
    if (v !== (process.env[k] ?? '')) changes[k] = v;
  }
  if (Object.keys(changes).length === 0) return {changed: [], warnings};
  await writeEnv(changes);
  for (const [k, v] of Object.entries(changes)) {
    if (v) process.env[k] = v;
    else delete process.env[k];
  }
  reloadConfig();
  return {changed: Object.keys(changes), warnings};
};

// ---------------------------------------------------------------------------
// Testes de chave e lista de modelos
// ---------------------------------------------------------------------------

const keyFor = (k: SettingKey, typed: unknown) => {
  const t = String(typed ?? '').trim();
  return t && !t.startsWith('••••') ? t : process.env[k] ?? '';
};

/** Lista os modelos do Claude disponíveis para a chave (digitada ou salva). */
export const listModels = async (typedKey?: unknown) => {
  const apiKey = keyFor('ANTHROPIC_API_KEY', typedKey);
  if (!apiKey) throw new SettingsError('Informe a chave do Claude primeiro.');
  const client = new Anthropic({apiKey});
  const models: {id: string; name: string}[] = [];
  try {
    for await (const m of client.models.list({limit: 100})) models.push({id: m.id, name: m.display_name});
  } catch (e) {
    const status = (e as {status?: number}).status;
    throw new SettingsError(status === 401 ? 'Chave do Claude inválida.' : `Não consegui falar com a Anthropic: ${e instanceof Error ? e.message : e}`);
  }
  return models;
};

/** fetch com mensagem compreensível quando não há conexão. */
const reach = async (url: string, headers: Record<string, string>, who: string) => {
  try {
    return await fetch(url, {headers, signal: AbortSignal.timeout(15000)});
  } catch {
    throw new SettingsError(`Não consegui falar com ${who}. Verifique a internet.`);
  }
};

export const testKey = async (service: string, typedKey?: unknown) => {
  if (service === 'anthropic') {
    const models = await listModels(typedKey);
    return {ok: true, message: `Chave válida. ${models.length} modelos disponíveis.`, models};
  }
  if (service === 'gemini') {
    const key = keyFor('GEMINI_API_KEY', typedKey);
    if (!key) throw new SettingsError('Informe a chave do Gemini primeiro.');
    const res = await reach('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {'x-goog-api-key': key}, 'o Google');
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new SettingsError('Chave do Gemini inválida ou sem permissão.');
    if (!res.ok) throw new SettingsError(`O Google respondeu com erro ${res.status}.`);
    const data = (await res.json()) as {models?: {name: string}[]};
    const lyria = (data.models ?? []).filter((m) => m.name.includes('lyria')).map((m) => m.name.replace('models/', ''));
    return {
      ok: true,
      message: lyria.length ? `Chave válida. Modelos de música: ${lyria.join(', ')}.` : 'Chave válida, mas nenhum modelo Lyria apareceu na lista desta conta.',
    };
  }
  if (service === 'elevenlabs') {
    const key = keyFor('ELEVENLABS_API_KEY', typedKey);
    if (!key) throw new SettingsError('Informe a chave da ElevenLabs primeiro.');
    const res = await reach('https://api.elevenlabs.io/v1/user/subscription', {'xi-api-key': key}, 'a ElevenLabs');
    if (res.status === 401) throw new SettingsError('Chave da ElevenLabs inválida.');
    if (!res.ok) return {ok: true, message: `A ElevenLabs respondeu ${res.status}; a chave pode não ter permissão de leitura da conta, mas ainda assim gerar música.`};
    const sub = (await res.json()) as {tier?: string};
    return {ok: true, message: `Chave válida (plano ${sub.tier ?? 'desconhecido'}).`};
  }
  throw new SettingsError('Serviço desconhecido.');
};
