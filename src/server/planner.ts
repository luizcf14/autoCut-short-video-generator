import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {z} from 'zod';
import {
  EditPlanSchema, expand, fmtTime, TEASER_SEC,
  type Analysis, type EditPlan, type Marker, type Segment, type Style, type VideoPlan,
} from '../shared/types';
import {ffmpeg} from './ffmpeg';
import {config} from './config';
import {findPeaks} from './analyze';

const SYSTEM = `Você é editor de vídeo de um canal do YouTube. Recebe a análise de uma gravação bruta
(quadros com o tempo em que foram tirados, volume do áudio ao longo do tempo, picos de som,
mudanças de cena e, se houver, a transcrição da fala) e devolve um plano de edição.

Monte três tipos de vídeo a partir da MESMA gravação:
1. "highlights": um vídeo 16:9 de melhores momentos. Duração alvo de 3 a 8 minutos, nunca mais
   que 40% da gravação. Trechos de 4 a 30 segundos, em ordem que conte uma história
   (começo, desenvolvimento, melhor momento perto do fim).
2. "short": de 2 a 4 Shorts verticais (9:16), cada um com 15 a 55 segundos no total, focado em
   UM momento forte, começando já na ação.
3. "long": o vídeo longo 16:9, mantendo quase tudo e cortando só partes paradas, repetitivas,
   câmera sendo ajustada, espera etc.

Regras:
- Todos os tempos são segundos da gravação original e devem ficar entre 0 e a duração.
- Você só viu alguns quadros. Use o áudio para estimar onde a ação começa e termina, e deixe
  margem de 2 a 3 segundos antes de cada momento.
- "caption" é um letreiro curto em português do Brasil (até 40 caracteres), só onde ajuda.
  Não invente fatos que não dá para ver ou ouvir (posições, tempos de volta, nomes).
- "speed" 0.5 (câmera lenta) só em trechos curtos de até 4 segundos e no máximo 2 por vídeo.
  "speed" 2 serve para acelerar trechos de transição no vídeo longo.
- "zoom": true dá um zoom lento; use com moderação.
- "transition" é como o trecho entra: "fade" (fusão, o padrão), "flash" (clarão, para momentos
  de impacto), "slide" (desliza, para mudar de assunto ou de lugar), "zoom" ou "cut" (corte seco).
  Use "fade" na maioria e varie só onde combina com o ritmo.
- "impactAt" é o segundo exato (da gravação original, dentro do trecho) de um momento de impacto
  ou revelação: dá um soco de zoom com tremida. No máximo 1 a cada 30 segundos de vídeo final.
- "replay": true repete o ponto alto do trecho em câmera lenta logo depois. No máximo 2 por
  vídeo, nunca em Shorts com menos de 25 segundos.
- "fit" vale para os Shorts: "cover" preenche a tela cortando as laterais (padrão); se a
  gravação já tem legendas ou textos gravados na imagem, ou o assunto ocupa a largura toda,
  use "wide" (mais aberto, com fundo desfocado) ou "contain" (imagem inteira) para não cortar.
- "introTitle" é o título que aparece nos primeiros segundos; "outroText" é a chamada final.
- Em "youtube", escreva título, descrição, tags e uma ideia de thumbnail para o vídeo de
  melhores momentos.`;

const segmentSchema = {
  type: 'object',
  properties: {
    start: {type: 'number'},
    end: {type: 'number'},
    caption: {type: 'string'},
    speed: {type: 'number'},
    zoom: {type: 'boolean'},
    transition: {type: 'string', enum: ['fade', 'flash', 'slide', 'zoom', 'cut']},
    impactAt: {type: 'number'},
    replay: {type: 'boolean'},
  },
  required: ['start', 'end'],
};

const TOOL = {
  name: 'enviar_plano',
  description: 'Envia o plano de edição completo.',
  input_schema: {
    type: 'object' as const,
    properties: {
      youtube: {
        type: 'object',
        properties: {
          title: {type: 'string'},
          description: {type: 'string'},
          tags: {type: 'array', items: {type: 'string'}},
          thumbnailIdea: {type: 'string'},
        },
        required: ['title', 'description', 'tags', 'thumbnailIdea'],
      },
      videos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {type: 'string', description: 'Identificador curto, ex.: highlights, short-1, long'},
            kind: {type: 'string', enum: ['highlights', 'short', 'long']},
            title: {type: 'string'},
            introTitle: {type: 'string'},
            outroText: {type: 'string'},
            fit: {type: 'string', enum: ['cover', 'wide', 'contain']},
            segments: {type: 'array', items: segmentSchema},
          },
          required: ['id', 'kind', 'title', 'segments'],
        },
      },
    },
    required: ['youtube', 'videos'],
  },
};

/** Resumo em texto da análise (sem as imagens). */
const describe = (a: Analysis) => {
  const buckets: string[] = [];
  for (let t = 0; t < a.loudness.length; t += 5) {
    const w = a.loudness.slice(t, t + 5);
    buckets.push(`${t}:${Math.round(w.reduce((x, y) => x + y, 0) / w.length)}`);
  }
  return [
    `Arquivo: ${a.file}`,
    `Duração: ${a.duration.toFixed(1)} s (${fmtTime(a.duration)}), ${a.width}x${a.height}`,
    a.hasAudio
      ? `Volume médio em dB a cada 5 s (formato segundo:dB): ${buckets.join(' ')}`
      : 'A gravação não tem áudio.',
    `Picos de som (segundo, dB): ${a.peaks.map((p) => `${p.t}s ${p.db}`).join('; ') || 'nenhum'}`,
    `Mudanças de cena (s): ${a.scenes.slice(0, 200).join(', ') || 'nenhuma (plano contínuo)'}`,
    a.transcript.length
      ? `Transcrição da fala:\n${a.transcript.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n')}`
      : 'Sem fala detectada (só som ambiente).',
  ].join('\n\n');
};

/** Garante que o plano respeita a duração do vídeo e tem ids únicos. */
export const sanitize = (raw: unknown, a: Analysis, source: EditPlan['source']): EditPlan => {
  const plan = EditPlanSchema.parse(raw);
  const seen = new Set<string>();
  plan.videos = plan.videos
    .map((v, i) => {
      let id = v.id.replace(/[^\w-]+/g, '-') || `${v.kind}-${i + 1}`;
      while (seen.has(id)) id += '-b';
      seen.add(id);
      const segments = v.segments
        .map((s) => ({
          ...s,
          start: Math.max(0, Math.min(s.start, a.duration)),
          end: Math.max(0, Math.min(s.end, a.duration)),
          speed: s.speed && s.speed !== 1 ? Math.max(0.25, Math.min(4, s.speed)) : undefined,
        }))
        .map((s) => ({...s, impactAt: s.impactAt !== undefined && s.impactAt > s.start && s.impactAt < s.end ? s.impactAt : undefined}))
        .filter((s) => s.end - s.start >= 0.5);
      return {...v, id, segments};
    })
    .filter((v) => v.segments.length > 0);
  if (plan.videos.length === 0) throw new Error('O plano veio sem nenhum trecho válido.');
  plan.markers = (plan.markers ?? []).filter((m) => m.end > m.start && m.start < a.duration);
  plan.source = source;
  return plan;
};

export type Tool = {name: string; description: string; input_schema: {type: 'object'; [k: string]: unknown}};

/**
 * Chama o Claude pedindo a resposta por uma ferramenta e devolve o JSON enviado.
 * Streaming evita o limite de tempo em respostas longas. Este modelo não aceita
 * forçar a ferramenta (tool_choice "tool"), então ela é pedida nas instruções.
 */
export const callTool = async (system: string, tool: Tool, content: Anthropic.ContentBlockParam[]): Promise<unknown> => {
  const client = new Anthropic({apiKey: config.apiKey});
  const res = await client.messages
    .stream({
      model: config.model,
      max_tokens: 16000,
      system: `${system}\n\nResponda SEMPRE chamando a ferramenta ${tool.name}, uma única vez.`,
      tools: [tool],
      tool_choice: {type: 'auto'},
      messages: [{role: 'user', content}],
    })
    .finalMessage();
  if (res.stop_reason === 'max_tokens') throw new Error('A resposta do Claude foi cortada por tamanho. Tente de novo.');
  const block = res.content.find((b) => b.type === 'tool_use');
  if (block && block.type === 'tool_use') return block.input;
  // Reserva: o modelo respondeu em texto; tenta achar o JSON.
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('O Claude não devolveu uma resposta utilizável.');
  return JSON.parse(json[0]);
};

const callClaude = async (content: Anthropic.ContentBlockParam[], a: Analysis) =>
  sanitize(await callTool(SYSTEM, TOOL, content), a, 'claude');

/** Orientação de estilo do canal, repetida em todo pedido ao Claude. */
export const styleBrief = (style: Style) =>
  `Estilo "${style.name}"${style.channelName ? ` (canal: ${style.channelName})` : ''}: ` +
  (style.prompt.trim() || 'sem orientação específica; use o bom senso para o tipo de conteúdo.');

export const planWithClaude = async (a: Analysis, dir: string, notes: string, style: Style) => {
  const content: Anthropic.ContentBlockParam[] = [{type: 'text', text: describe(a)}];
  for (const f of a.frames) {
    const data = await fs.readFile(path.join(dir, 'frames', f.file));
    content.push({type: 'text', text: `Quadro em ${fmtTime(f.t)} (t=${f.t}s):`});
    content.push({type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: data.toString('base64')}});
  }
  content.push({
    type: 'text',
    text: `${styleBrief(style)}\n\nOrientações para este vídeo: ${notes.trim() || '(nenhuma)'}\n\n` +
      'Monte o plano de edição seguindo o estilo acima; ele tem prioridade sobre as durações e quantidades padrão.',
  });
  return callClaude(content, a);
};

export const refineWithClaude = async (a: Analysis, plan: EditPlan, instruction: string, style: Style) =>
  callClaude(
    [{
      type: 'text',
      text: `${describe(a)}\n\n${styleBrief(style)}\n\nPlano de edição atual (JSON):\n${JSON.stringify({youtube: plan.youtube, videos: plan.videos})}\n\n` +
        `O dono do canal pediu esta alteração: ${instruction}\n\n` +
        'Devolva o plano completo já alterado, mantendo igual tudo o que não foi pedido para mudar.',
    }],
    a,
  );

/** Plano sem IA: usa só os picos de áudio. Serve de reserva quando não há chave da API. */
export const planHeuristic = (a: Analysis): EditPlan => {
  const D = a.duration;
  const win = (t: number, before: number, after: number): Segment => ({
    start: Math.max(0, t - before),
    end: Math.min(D, t + after),
  });
  const merge = (segs: Segment[]) => {
    const out: Segment[] = [];
    for (const s of [...segs].sort((x, y) => x.start - y.start)) {
      const last = out[out.length - 1];
      if (last && s.start <= last.end + 1) last.end = Math.max(last.end, s.end);
      else out.push({...s});
    }
    return out;
  };
  const target = Math.min(480, D * 0.4);
  const n = Math.max(1, Math.min(30, Math.round(target / 12)));
  const peaks = a.loudness.length ? findPeaks(a.loudness, n, 14) : [];
  const moments = peaks.length
    ? peaks
    : Array.from({length: n}, (_, i) => ({t: ((i + 0.5) * D) / n, db: 0}));
  const top = [...moments].sort((x, y) => y.db - x.db).slice(0, Math.min(3, Math.max(1, Math.floor(D / 40))));
  const name = a.file.replace(/\.[^.]+$/, '');
  return sanitize(
    {
      youtube: {title: name, description: '', tags: [], thumbnailIdea: ''},
      videos: [
        {id: 'highlights', kind: 'highlights', title: 'Melhores momentos', introTitle: name,
          outroText: 'Inscreva-se no canal', segments: merge(moments.map((p) => win(p.t, 6, 6)))},
        ...top.map((p, i) => ({id: `short-${i + 1}`, kind: 'short' as const, title: `Short ${i + 1}`,
          segments: [win(p.t, 10, 14)]})),
        {id: 'long', kind: 'long', title: 'Vídeo completo', introTitle: name,
          outroText: 'Inscreva-se no canal', segments: [{start: 0, end: D}]},
      ],
    },
    a,
    'heuristic',
  );
};

// ---------------------------------------------------------------------------
// Marcadores: acha os momentos em que alguém aponta para algo e onde está o alvo.
// ---------------------------------------------------------------------------

const POINT_SYSTEM = `Você analisa quadros de um vídeo (por exemplo, um mecânico mostrando peças) para
colocar uma seta sobre aquilo que a pessoa está apontando.

Para cada quadro em que alguém aponta CLARAMENTE para um objeto ou parte específica (com o dedo,
a mão ou uma ferramenta), devolva um item com:
- "frame": o número do quadro, como informado antes da imagem;
- "x" e "y": a posição do ALVO apontado (a peça ou o ponto para onde o dedo aponta, não a mão),
  de 0 a 1 dentro da imagem, com (0,0) no canto superior esquerdo e (1,1) no inferior direito;
- "label": nome curto do alvo em português (até 22 caracteres), só se der para identificar
  com segurança pela imagem ou pela fala transcrita; caso contrário, omita.

Não marque gestos vagos, mãos apenas segurando ou trabalhando em algo, nem quadros em que você
está em dúvida. Se ninguém aponta para nada, devolva a lista vazia. É melhor deixar de marcar
do que marcar errado.`;

const POINT_TOOL: Tool = {
  name: 'marcar_apontamentos',
  description: 'Envia os quadros em que alguém aponta para algo e a posição do alvo.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {frame: {type: 'integer'}, x: {type: 'number'}, y: {type: 'number'}, label: {type: 'string'}},
          required: ['frame', 'x', 'y'],
        },
      },
    },
    required: ['items'],
  },
};

const PointItems = z.object({
  items: z.array(z.object({frame: z.number(), x: z.number(), y: z.number(), label: z.string().optional()})),
});

type Detection = {t: number; x: number; y: number; label?: string};

/**
 * Junta detecções de quadros vizinhos que apontam para a mesma região em um só
 * marcador, que acompanha o alvo de um ponto ao outro.
 */
export const mergeDetections = (detections: Detection[], step: number, duration: number): Marker[] => {
  const markers: Marker[] = [];
  for (const d of [...detections].sort((a, b) => a.t - b.t)) {
    const last = markers[markers.length - 1];
    const prev = last?.points[last.points.length - 1];
    if (last && prev && d.t - prev.t <= step * 1.5 && Math.hypot(d.x - prev.x, d.y - prev.y) < 0.3) {
      last.points.push({t: d.t, x: d.x, y: d.y});
      last.label ??= d.label;
    } else {
      markers.push({start: 0, end: 0, label: d.label, points: [{t: d.t, x: d.x, y: d.y}]});
    }
  }
  return markers.map((m) => ({
    ...m,
    start: Math.max(0, m.points[0].t - 0.4),
    end: Math.min(duration, m.points[m.points.length - 1].t + Math.max(1.4, step * 0.6)),
  }));
};

export const detectPointing = async (
  a: Analysis,
  dir: string,
  video: VideoPlan,
  progress: (fraction: number, message: string) => void,
) => {
  const ranges = expand(video, 0).map((s) => ({start: s.start, end: s.end}));
  const total = ranges.reduce((n, r) => n + (r.end - r.start), 0);
  // Um quadro a cada 2 s, ou mais espaçado se passar do limite de quadros.
  const maxFrames = Number(process.env.MAX_POINT_FRAMES || 240);
  const step = Math.max(2, Math.ceil(total / maxFrames));
  const times = [...new Set(ranges.flatMap((r) => {
    const ts: number[] = [];
    for (let t = r.start + Math.min(1, (r.end - r.start) / 2); t < r.end; t += step) ts.push(Math.round(t * 10) / 10);
    return ts;
  }))].sort((x, y) => x - y);

  const framesDir = path.join(dir, 'point');
  await fs.rm(framesDir, {recursive: true, force: true});
  await fs.mkdir(framesDir, {recursive: true});
  const proxy = path.join(dir, 'proxy.mp4');
  const files: string[] = [];
  for (const [i, t] of times.entries()) {
    progress(0.3 * (i / times.length), `Extraindo quadros (${i + 1} de ${times.length})`);
    const file = path.join(framesDir, `${i}.jpg`);
    await ffmpeg(['-y', '-ss', String(t), '-i', proxy, '-frames:v', '1', '-vf', 'scale=768:-2', '-q:v', '5', file]);
    files.push(file);
  }

  const BATCH = 20;
  const detections: Detection[] = [];
  for (let b = 0; b < times.length; b += BATCH) {
    progress(0.3 + 0.7 * (b / times.length), `Claude procurando apontamentos (quadros ${b + 1} a ${Math.min(b + BATCH, times.length)} de ${times.length})`);
    const slice = times.slice(b, b + BATCH);
    const speech = a.transcript.filter((s) => s.end >= slice[0] - 3 && s.start <= slice[slice.length - 1] + 3);
    const content: Anthropic.ContentBlockParam[] = [{
      type: 'text',
      text: speech.length
        ? `Fala transcrita neste intervalo:\n${speech.map((s) => `[${s.start.toFixed(1)}s] ${s.text}`).join('\n')}`
        : 'Sem fala transcrita neste intervalo.',
    }];
    for (const [k, t] of slice.entries()) {
      const data = await fs.readFile(files[b + k]);
      content.push({type: 'text', text: `Quadro ${b + k} (t=${t}s):`});
      content.push({type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: data.toString('base64')}});
    }
    const {items} = PointItems.parse(await callTool(POINT_SYSTEM, POINT_TOOL, content));
    for (const it of items) {
      const t = times[Math.round(it.frame)];
      if (t === undefined || it.x < 0 || it.x > 1 || it.y < 0 || it.y > 1) continue;
      detections.push({t, x: it.x, y: it.y, label: it.label?.slice(0, 24)});
    }
  }
  await fs.rm(framesDir, {recursive: true, force: true});
  return {markers: mergeDetections(detections, step, a.duration), ranges};
};

// ---------------------------------------------------------------------------
// Vinheta: cortes rápidos dos momentos mais importantes, 10 s no total,
// em duas versões (horizontal e vertical) com os mesmos momentos.
// ---------------------------------------------------------------------------

const TEASER_SYSTEM = `Você monta a vinheta de abertura de um vídeo de YouTube: uma sequência de cortes
rápidos com os momentos mais importantes, que somados dão ${TEASER_SEC} segundos.

Você recebe o plano de edição já feito (trechos com letreiros e instantes de impacto) e o áudio.
Escolha de 5 a 8 momentos, cada um com 1 a 2,5 segundos, somando ${TEASER_SEC} segundos:
- "t" é o segundo da gravação original em que o momento COMEÇA; "duration" é quanto dura.
- Prefira instantes de impacto, revelações, resultados e imagens fortes; pegue momentos de partes
  diferentes do vídeo, sem repetir a mesma cena.
- Fique dentro dos trechos do plano (o que está fora deles foi descartado por ser parado).
- "order": "story" mantém a ordem do vídeo; "best-last" guarda o momento mais forte para o fim.
- "title" é um título curtíssimo (até 28 caracteres) que aparece sobre a vinheta.`;

const TEASER_TOOL: Tool = {
  name: 'montar_vinheta',
  description: 'Envia os momentos da vinheta.',
  input_schema: {
    type: 'object',
    properties: {
      title: {type: 'string'},
      moments: {
        type: 'array',
        items: {type: 'object', properties: {t: {type: 'number'}, duration: {type: 'number'}}, required: ['t', 'duration']},
      },
    },
    required: ['moments'],
  },
};

const TeaserReply = z.object({
  title: z.string().optional(),
  moments: z.array(z.object({t: z.number(), duration: z.number()})),
});

type Moment = {t: number; duration: number};

/** Sem o Claude: o segundo mais barulhento (ou o impacto) de cada trecho dos melhores momentos. */
const teaserHeuristic = (a: Analysis, base: VideoPlan): Moment[] => {
  const scored = base.segments.map((s) => {
    let best = s.start + (s.end - s.start) / 2;
    let db = -Infinity;
    for (let t = Math.ceil(s.start); t < Math.floor(s.end); t++) {
      if ((a.loudness[t] ?? -99) > db) { db = a.loudness[t] ?? -99; best = t; }
    }
    const center = s.impactAt ?? best;
    return {t: Math.max(s.start, Math.min(center - 0.5, s.end - 1.6)), db: s.impactAt !== undefined ? db + 6 : db};
  });
  const n = Math.max(1, Math.min(7, scored.length));
  const picked = [...scored].sort((x, y) => y.db - x.db).slice(0, n).sort((x, y) => x.t - y.t);
  // Poucos trechos: completa com momentos espalhados por todos eles, longe dos já escolhidos.
  const total = base.segments.reduce((n, s) => n + (s.end - s.start), 0);
  const at = (offset: number) => {
    let left = offset;
    for (const s of base.segments) {
      if (left <= s.end - s.start) return s.start + left;
      left -= s.end - s.start;
    }
    return base.segments[base.segments.length - 1].end - 2;
  };
  for (let k = 0; k < 40 && picked.length < 5; k++) {
    const t = Math.max(0, at(((k * 0.618 + 0.3) % 1) * total));
    if (picked.every((m) => Math.abs(m.t - t) >= 2.6)) picked.push({t, db: 0});
  }
  return picked.sort((x, y) => x.t - y.t).map((m) => ({t: m.t, duration: TEASER_SEC / picked.length}));
};

/** Ajusta os momentos para caberem na gravação e somarem exatamente a duração da vinheta. */
export const fitTeaser = (moments: Moment[], duration: number): Segment[] => {
  let ms = moments
    .map((m) => ({t: Math.max(0, Math.min(m.t, duration - 0.6)), duration: Math.max(0.6, Math.min(3, m.duration))}))
    .map((m) => ({...m, duration: Math.min(m.duration, duration - m.t)}))
    .filter((m) => m.duration >= 0.5)
    .slice(0, 10);
  if (ms.length === 0) ms = [{t: 0, duration: Math.min(TEASER_SEC, duration)}];
  const total = ms.reduce((n, m) => n + m.duration, 0);
  const scale = Math.min(TEASER_SEC, duration) / total;
  // Arredonda para quadros inteiros (30 por segundo) e põe a sobra no último corte.
  const frames = ms.map((m) => Math.max(15, Math.round(m.duration * scale * 30)));
  frames[frames.length - 1] += Math.round(Math.min(TEASER_SEC, duration) * 30) - frames.reduce((n, f) => n + f, 0);
  return ms.map((m, i) => {
    const d = Math.max(0.5, frames[i] / 30);
    const start = Math.max(0, Math.min(m.t, duration - d));
    return {
      start, end: start + d,
      transition: 'cut' as const,
      // Um soco de zoom logo depois de cada corte dá o ritmo da vinheta.
      impactAt: i > 0 ? start + 0.04 : undefined,
    };
  });
};

export const buildTeaser = async (a: Analysis, plan: EditPlan, style: Style): Promise<VideoPlan[]> => {
  const base = plan.videos.find((v) => v.kind === 'highlights') ?? plan.videos.find((v) => v.kind !== 'teaser');
  if (!base) throw new Error('O plano não tem nenhum vídeo para tirar os momentos.');
  let moments = teaserHeuristic(a, base);
  let title = plan.youtube.title.length <= 28 ? plan.youtube.title : style.channelName;
  if (config.apiKey) {
    const reply = TeaserReply.parse(await callTool(TEASER_SYSTEM, TEASER_TOOL, [{
      type: 'text',
      text: `${describe(a)}\n\n${styleBrief(style)}\n\nTítulo do vídeo: ${plan.youtube.title}\n\n` +
        `Trechos do plano (JSON):\n${JSON.stringify(base.segments)}\n\nMonte a vinheta.`,
    }]));
    if (reply.moments.length) moments = reply.moments;
    if (reply.title) title = reply.title.slice(0, 40);
  }
  const segments = fitTeaser(moments, a.duration);
  const short = plan.videos.find((v) => v.kind === 'short');
  return [
    {id: 'vinheta-horizontal', kind: 'teaser', format: 'landscape', title: 'Horizontal', introTitle: title || undefined, segments},
    {id: 'vinheta-vertical', kind: 'teaser', format: 'portrait', title: 'Vertical', introTitle: title || undefined,
      fit: short?.fit, segments},
  ];
};
