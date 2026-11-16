import fs from 'node:fs/promises';
import path from 'node:path';
import {expand, layout, buildProps, FPS, type Analysis, type EditPlan, type Style, type VideoPlan} from '../shared/types';
import {config} from './config';
import {callTool, styleBrief} from './planner';

type Progress = (fraction: number, message: string) => void;

export type MusicProvider = 'gemini' | 'elevenlabs';

/** Qual serviço de música usar: MUSIC_PROVIDER, ou o primeiro que tiver chave no .env. */
export const musicProvider = (): MusicProvider | null => {
  const wanted = (process.env.MUSIC_PROVIDER || '').toLowerCase();
  if (wanted === 'gemini' && config.geminiKey) return 'gemini';
  if (wanted === 'elevenlabs' && config.elevenKey) return 'elevenlabs';
  if (config.geminiKey) return 'gemini';
  if (config.elevenKey) return 'elevenlabs';
  return null;
};

export const PROVIDER_LABEL: Record<MusicProvider, string> = {
  gemini: 'Google Lyria (Gemini API)',
  elevenlabs: 'ElevenLabs Music',
};

// ---------------------------------------------------------------------------
// 1. Descrição da música (o que pedir ao serviço)
// ---------------------------------------------------------------------------

const MUSIC_SYSTEM = `Você escolhe a trilha de fundo de um vídeo de YouTube e escreve o pedido para
um gerador de música por IA.

Regras do pedido ("prompt"):
- Em INGLÊS (os geradores entendem melhor), até 400 caracteres.
- Sempre instrumental: termine com "Instrumental only, no vocals."
- Descreva gênero, clima, andamento (BPM aproximado) e instrumentos principais.
- Música de FUNDO: sem solos chamativos nem viradas bruscas, mix discreto que não brigue com a fala.
- Nunca cite artistas, bandas, músicas ou marcas reais.
Em "resumo", explique em português, numa frase curta, a música escolhida.`;

const MUSIC_TOOL = {
  name: 'descrever_musica',
  description: 'Envia o pedido para o gerador de música.',
  input_schema: {
    type: 'object' as const,
    properties: {prompt: {type: 'string'}, resumo: {type: 'string'}},
    required: ['prompt', 'resumo'],
  },
};

const INSTRUMENTAL = 'Instrumental only, no vocals.';

/** Pedido montado sem o Claude, quando não há chave da Anthropic. */
const fallbackPrompt = (video: VideoPlan) => {
  const mood = video.kind === 'short' || video.kind === 'teaser'
    ? 'Upbeat, punchy modern electronic rock groove, 120 BPM, tight drums, muted electric guitar riffs'
    : 'Laid-back modern lo-fi groove, 90 BPM, soft drums, warm bass, light electric guitar';
  return {prompt: `${mood}. Background music for a YouTube video, unobtrusive mix. ${INSTRUMENTAL}`,
    resumo: video.kind === 'short' ? 'Rock eletrônico animado (pedido padrão, sem o Claude).' : 'Lo-fi tranquilo (pedido padrão, sem o Claude).'};
};

const describeAuto = async (video: VideoPlan, plan: EditPlan, style: Style, seconds: number) => {
  if (!config.apiKey) return fallbackPrompt(video);
  const captions = video.segments.map((s) => s.caption).filter(Boolean).join(' | ');
  const raw = (await callTool(MUSIC_SYSTEM, MUSIC_TOOL, [{
    type: 'text',
    text: [
      styleBrief(style),
      `Tipo de vídeo: ${video.kind === 'short' ? 'Short vertical' : video.kind === 'long' ? 'vídeo longo' : video.kind === 'teaser' ? 'vinheta de abertura de 10 segundos, enérgica e marcante' : 'melhores momentos'}`,
      `Título: ${video.title}${plan.youtube.title ? ` (vídeo: ${plan.youtube.title})` : ''}`,
      plan.youtube.description ? `Descrição: ${plan.youtube.description.slice(0, 600)}` : '',
      captions ? `Letreiros: ${captions}` : '',
      `Duração: ${Math.round(seconds)} segundos. Intensidade dos efeitos: ${['nenhuma', 'normal', 'alta'][plan.fx ?? 1]}.`,
    ].filter(Boolean).join('\n'),
  }])) as {prompt?: string; resumo?: string};
  if (!raw.prompt) return fallbackPrompt(video);
  return {prompt: raw.prompt, resumo: raw.resumo ?? ''};
};

/** O usuário descreveu a música; o Claude (se houver chave) só traduz e completa. */
const describeUser = async (text: string, seconds: number) => {
  if (!config.apiKey) {
    return {prompt: `${text.trim()}. Background music, unobtrusive mix. ${INSTRUMENTAL}`, resumo: text.trim()};
  }
  const raw = (await callTool(MUSIC_SYSTEM, MUSIC_TOOL, [{
    type: 'text',
    text: `O dono do canal descreveu a música que quer (siga o pedido dele fielmente, só traduza e ` +
      `complete o que faltar): "${text.trim()}"\nDuração do vídeo: ${Math.round(seconds)} segundos.`,
  }])) as {prompt?: string; resumo?: string};
  return {prompt: raw.prompt || `${text.trim()}. ${INSTRUMENTAL}`, resumo: raw.resumo || text.trim()};
};

// ---------------------------------------------------------------------------
// 2. Chamada ao serviço de música
// ---------------------------------------------------------------------------

/** Procura, em qualquer nível da resposta, um bloco de áudio em base64. */
const findAudio = (node: unknown): {data: string; mime?: string} | null => {
  if (!node || typeof node !== 'object') return null;
  const o = node as Record<string, unknown>;
  if (o.type === 'audio' && typeof o.data === 'string') {
    return {data: o.data, mime: typeof o.mime_type === 'string' ? o.mime_type : typeof o.mimeType === 'string' ? o.mimeType : undefined};
  }
  for (const v of Object.values(o)) {
    const found = findAudio(v);
    if (found) return found;
  }
  return null;
};

const errorText = async (res: Response) => {
  const body = await res.text();
  try {
    const j = JSON.parse(body);
    return j.error?.message || j.detail?.message || JSON.stringify(j.detail ?? j).slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
};

const generateGemini = async (prompt: string, seconds: number) => {
  // O modelo "clip" sempre gera 30 s (a música fica em laço); o 3.5 gera faixas longas,
  // com a duração pedida no texto.
  const long = seconds > 32;
  const model = long ? process.env.LYRIA_MODEL_LONG || 'lyria-3.5' : process.env.LYRIA_MODEL || 'lyria-3-clip-preview';
  const input = long ? `${prompt} Length: about ${Math.min(240, Math.ceil(seconds))} seconds.` : prompt;
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Api-Revision': '2026-05-20', 'x-goog-api-key': config.geminiKey},
    body: JSON.stringify({model, input}),
  });
  if (!res.ok) throw new Error(`Lyria (${model}) recusou o pedido: ${await errorText(res)}`);
  const audio = findAudio(await res.json());
  if (!audio) throw new Error('A resposta do Lyria não trouxe áudio.');
  const ext = audio.mime?.includes('wav') ? 'wav' : 'mp3';
  return {bytes: Buffer.from(audio.data, 'base64'), ext};
};

const generateEleven = async (prompt: string, seconds: number) => {
  const ms = Math.max(10_000, Math.min(600_000, Math.round((seconds + 2) * 1000)));
  const res = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'xi-api-key': config.elevenKey},
    body: JSON.stringify({
      prompt,
      music_length_ms: ms,
      force_instrumental: true,
      model_id: process.env.ELEVENLABS_MUSIC_MODEL || 'music_v1',
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs recusou o pedido: ${await errorText(res)}`);
  return {bytes: Buffer.from(await res.arrayBuffer()), ext: 'mp3'};
};

// ---------------------------------------------------------------------------

export const generateMusic = async (
  analysis: Analysis,
  plan: EditPlan,
  video: VideoPlan,
  style: Style,
  mode: 'auto' | 'describe',
  description: string,
  progress: Progress,
) => {
  const provider = musicProvider();
  if (!provider) throw new Error('Nenhum gerador de música configurado: coloque GEMINI_API_KEY ou ELEVENLABS_API_KEY no .env.');
  if (mode === 'describe' && !description.trim()) throw new Error('Descreva a música que você quer.');

  // Duração final do vídeo, com os mesmos cálculos da exportação.
  const props = buildProps(video, {
    transcript: [], markers: [], sourceAspect: analysis.width / analysis.height, fx: plan.fx ?? 1,
    channelName: '', theme: style, musicBase: '',
  }, () => ({src: '', offsetSec: 0}));
  const seconds = expand(video, plan.fx ?? 1).length ? layout(props).total / FPS : 30;

  progress(0.1, config.apiKey ? 'Claude está escolhendo o estilo da música' : 'Montando o pedido da música');
  const {prompt, resumo} = mode === 'auto'
    ? await describeAuto(video, plan, style, seconds)
    : await describeUser(description, seconds);

  progress(0.35, `Gerando a música no ${PROVIDER_LABEL[provider]} (pode levar até um minuto)`);
  const {bytes, ext} = provider === 'gemini' ? await generateGemini(prompt, seconds) : await generateEleven(prompt, seconds);
  if (bytes.length < 1000) throw new Error('O gerador devolveu um arquivo de áudio vazio.');

  await fs.mkdir(config.musicDir, {recursive: true});
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const file = `gerada_${video.id}_${stamp}.${ext}`;
  await fs.writeFile(path.join(config.musicDir, file), bytes);
  // Guarda o pedido ao lado, para saber depois o que foi gerado.
  await fs.writeFile(path.join(config.musicDir, `${file}.txt`), `${resumo}\n\n${prompt}\n\n${PROVIDER_LABEL[provider]}\n`);
  return {file, prompt, resumo, provider};
};
