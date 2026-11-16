import {z} from 'zod';

export const TRANSITIONS = ['fade', 'flash', 'slide', 'zoom', 'cut'] as const;
export type Transition = (typeof TRANSITIONS)[number];

/** Um trecho do vídeo bruto (tempos em segundos do arquivo original). */
export const SegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  caption: z.string().optional(),
  speed: z.number().min(0.25).max(4).optional(),
  zoom: z.boolean().optional(),
  /** Como este trecho entra na tela. */
  transition: z.enum(TRANSITIONS).optional(),
  /** Instante (s do vídeo bruto) de um "soco" de zoom com tremida. */
  impactAt: z.number().optional(),
  /** Repete o melhor momento do trecho em câmera lenta logo depois. */
  replay: z.boolean().optional(),
});
export type Segment = z.infer<typeof SegmentSchema>;

/**
 * Marcador (seta + círculo) sobre algo que está sendo apontado.
 * x e y vão de 0 a 1 dentro do quadro original (0,0 = canto superior esquerdo).
 */
export const MarkerSchema = z.object({
  start: z.number(),
  end: z.number(),
  label: z.string().optional(),
  points: z.array(z.object({t: z.number(), x: z.number(), y: z.number()})).min(1),
});
export type Marker = z.infer<typeof MarkerSchema>;

export const FITS = ['cover', 'wide', 'contain'] as const;
export type Fit = (typeof FITS)[number];

export const VideoPlanSchema = z.object({
  id: z.string(),
  kind: z.enum(['highlights', 'short', 'long', 'teaser']),
  /** Formato da tela; sem isto, Shorts são verticais e o resto horizontal. */
  format: z.enum(['landscape', 'portrait']).optional(),
  title: z.string(),
  introTitle: z.string().optional(),
  outroText: z.string().optional(),
  /** Enquadramento quando o vídeo bruto é mais largo que a tela (Shorts). */
  fit: z.enum(FITS).optional(),
  /** Arquivo da pasta de músicas tocado ao fundo, e o volume dele (0 a 1). */
  music: z.string().optional(),
  musicVolume: z.number().min(0).max(1).optional(),
  /** Resumo da última música gerada para este vídeo. */
  musicNote: z.string().optional(),
  segments: z.array(SegmentSchema),
});
export type VideoPlan = z.infer<typeof VideoPlanSchema>;

/**
 * Estilo de um canal ou cliente: identidade visual (cores e fontes) e a orientação
 * de edição passada ao Claude. Cada estilo é um arquivo JSON na pasta `estilos`.
 */
export const StyleSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  channelName: z.string(),
  /** Cor de destaque (faixas, setas, selos), em #rrggbb. */
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Cor das letras dos títulos e letreiros. */
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Cor do fundo dos letreiros. */
  captionBg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Fontes instaladas no computador. */
  titleFont: z.string(),
  textFont: z.string(),
  /** Como o Claude deve editar: tipo de vídeo, ritmo, tom dos textos. */
  prompt: z.string(),
});
export type Style = z.infer<typeof StyleSchema>;
export type Theme = Pick<Style, 'accent' | 'textColor' | 'captionBg' | 'titleFont' | 'textFont'>;

export const DEFAULT_STYLE: Style = {
  id: '',
  name: 'Padrão',
  channelName: '',
  accent: '#ffd400',
  textColor: '#ffffff',
  captionBg: '#000000',
  titleFont: 'Arial Black',
  textFont: 'Segoe UI',
  prompt: '',
};

/** Fontes que já vêm com o Windows; outras funcionam se estiverem instaladas. */
export const FONT_SUGGESTIONS = [
  'Arial Black', 'Impact', 'Bahnschrift', 'Segoe UI', 'Segoe UI Black', 'Arial', 'Verdana', 'Tahoma',
  'Trebuchet MS', 'Franklin Gothic Medium', 'Georgia', 'Times New Roman', 'Consolas', 'Comic Sans MS',
];

/** Pontos de partida para a orientação de estilo. */
export const STYLE_PRESETS: {label: string; prompt: string}[] = [
  {
    label: 'Tutorial passo a passo',
    prompt: 'Vídeo de tutorial. Mantenha a ordem real dos passos e não corte etapas necessárias para entender o procedimento. Use letreiros para nomear cada etapa ("Passo 1: ..."). Ritmo calmo, entradas em fusão, sem replays e com poucos impactos. Use zoom lento quando algo é mostrado de perto.',
  },
  {
    label: 'Explicativo rápido',
    prompt: 'Vídeo explicativo curto e direto. Comece pelo problema ou pela conclusão, corte pausas e repetições, use trechos de 3 a 8 segundos. Cada letreiro resume uma ideia-chave em poucas palavras. Ritmo ágil, mas sem efeitos chamativos.',
  },
  {
    label: 'Esportes e ação',
    prompt: 'Vídeo de ação. Comece pelo momento mais forte, ritmo acelerado, trechos curtos. Use impactos nos momentos decisivos, replays em câmera lenta nos melhores lances e entradas em flash. Letreiros curtos e enérgicos.',
  },
  {
    label: 'Bastidores do dia a dia',
    prompt: 'Vídeo de bastidores. Conte o dia em ordem cronológica, com tom leve e próximo. Mantenha falas e reações espontâneas, corte esperas e tempos mortos. Letreiros situam o que está acontecendo, sem exagero de efeitos.',
  },
  {
    label: 'Antes e depois / resultado',
    prompt: 'Vídeo de antes e depois. Mostre rapidamente o problema, acelere o trabalho do meio (velocidade 2x nos trechos longos) e dê destaque ao resultado final, com zoom lento e um letreiro de conclusão.',
  },
];

/** Preto ou branco, o que tiver mais contraste sobre a cor dada. */
export const contrastOn = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.55 ? '#000000' : '#ffffff';
};

export const EditPlanSchema = z.object({
  youtube: z.object({
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    thumbnailIdea: z.string(),
  }),
  videos: z.array(VideoPlanSchema),
  markers: z.array(MarkerSchema).optional(),
  /** Intensidade dos efeitos: 0 = sem efeitos, 1 = normal, 2 = intenso. */
  fx: z.number().int().min(0).max(2).optional(),
  /** Estilo (arquivo da pasta `estilos`) usado neste vídeo. */
  styleId: z.string().optional(),
  source: z.enum(['claude', 'heuristic']).optional(),
});
export type EditPlan = z.infer<typeof EditPlanSchema>;

export type Subtitle = {start: number; end: number; text: string};

export type Analysis = {
  file: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  /** Volume médio (dB) por segundo. */
  loudness: number[];
  peaks: {t: number; db: number}[];
  scenes: number[];
  frames: {t: number; file: string}[];
  transcript: Subtitle[];
};

export type Job = {
  id: string;
  status: 'running' | 'done' | 'error';
  progress: number;
  message: string;
  error?: string;
  result?: unknown;
};

/** Props do template Remotion. */
export type ClipProps = {
  src: string;
  /** Onde o trecho começa dentro de `src`. */
  offsetSec: number;
  /** Onde o trecho começa no vídeo bruto (para alinhar legendas, marcadores e impacto). */
  sourceStart: number;
  durationSec: number;
  speed: number;
  caption?: string;
  zoom?: boolean;
  transition: Transition;
  impactAt?: number;
  badge?: string;
};

export type AutoCutProps = {
  format: 'landscape' | 'portrait';
  clips: ClipProps[];
  introTitle?: string;
  /** Mostra o título nos últimos segundos em vez de nos primeiros (vinheta). */
  titleAtEnd?: boolean;
  outroText?: string;
  channelName?: string;
  subtitles: Subtitle[];
  markers: Marker[];
  theme: Theme;
  fit: Fit;
  music?: {src: string; volume: number};
  /** Largura / altura do vídeo bruto. */
  sourceAspect: number;
  fx: number;
};

export const QUALITIES = ['alta', 'equilibrada', 'compacta'] as const;
export type Quality = (typeof QUALITIES)[number];
export const QUALITY_LABEL: Record<Quality, string> = {
  alta: 'Alta (H.264, arquivo maior)',
  equilibrada: 'Equilibrada (H.264, cerca de metade do tamanho)',
  compacta: 'Compacta (H.265, o menor arquivo)',
};

/** Duração total da vinheta, em segundos. */
export const TEASER_SEC = 10;

export const FPS = 30;
export const DEFAULT_MUSIC_VOLUME = 0.15;
/** A música entra em 0,5 s e sai nos últimos 1,5 s. */
export const MUSIC_FADE_IN = 0.5;
export const MUSIC_FADE_OUT = 1.5;
export const INTRO_SEC = 2.5;
export const OUTRO_SEC = 2.5;

export const clipFrames = (c: ClipProps) =>
  Math.max(1, Math.round((c.durationSec / (c.speed || 1)) * FPS));

/** Duração máxima (em quadros) da transição suave entre dois trechos. */
export const TRANSITION_FRAMES = 12;

/**
 * Posição de cada trecho na linha do tempo. Trechos vizinhos se sobrepõem por
 * alguns quadros para a imagem e o som fazerem fusão em vez de um corte seco.
 * `trans[i]` é a sobreposição entre o trecho i-1 e o trecho i (0 para o primeiro).
 */
export const layout = (p: AutoCutProps) => {
  const frames = p.clips.map(clipFrames);
  const trans = frames.map((f, i) =>
    i === 0 || p.clips[i].transition === 'cut'
      ? 0
      : Math.max(0, Math.min(TRANSITION_FRAMES, Math.floor(f / 3), Math.floor(frames[i - 1] / 3))),
  );
  const starts: number[] = [];
  let cursor = 0;
  frames.forEach((f, i) => {
    cursor -= trans[i];
    starts.push(cursor);
    cursor += f;
  });
  const outroFrames = p.outroText ? Math.round(OUTRO_SEC * FPS) : 0;
  return {frames, trans, starts, outroStart: cursor, outroFrames, total: Math.max(1, cursor + outroFrames)};
};

export const totalFrames = (p: AutoCutProps) => layout(p).total;

export const dimensions = (format: AutoCutProps['format']) =>
  format === 'portrait' ? {width: 1080, height: 1920} : {width: 1920, height: 1080};

export type Piece = Segment & {badge?: string};

/**
 * Transforma os trechos do plano nos pedaços que realmente vão para a linha do tempo
 * (um trecho com replay vira dois pedaços). A prévia e a exportação usam esta mesma lista.
 */
export const expand = (video: VideoPlan, fx: number): Piece[] => {
  const out: Piece[] = [];
  for (const s of video.segments) {
    if (s.end - s.start <= 0.2) continue;
    out.push(s);
    if (s.replay && fx > 0) {
      const center = s.impactAt !== undefined && s.impactAt > s.start && s.impactAt < s.end ? s.impactAt : s.end - 1.5;
      const start = Math.max(s.start, center - 1.5);
      const end = Math.min(s.end, center + 1.5);
      if (end - start > 0.5) out.push({start, end, speed: 0.5, transition: 'flash', badge: 'REPLAY'});
    }
  }
  return out;
};

export type Extras = {
  transcript: Subtitle[];
  markers: Marker[];
  sourceAspect: number;
  fx: number;
  channelName: string;
  theme: Theme;
  /** Endereço de onde a prévia carrega as músicas. */
  musicBase: string;
};

/** Monta as props do template a partir de um vídeo do plano. */
export const buildProps = (
  video: VideoPlan,
  extras: Extras,
  srcFor: (index: number, piece: Piece) => {src: string; offsetSec: number},
): AutoCutProps => ({
  format: video.format ?? (video.kind === 'short' ? 'portrait' : 'landscape'),
  introTitle: video.introTitle,
  titleAtEnd: video.kind === 'teaser',
  outroText: video.outroText,
  channelName: extras.channelName,
  theme: extras.theme,
  subtitles: extras.transcript,
  markers: extras.fx > 0 ? extras.markers : [],
  sourceAspect: extras.sourceAspect,
  fit: video.fit ?? 'cover',
  music: video.music
    ? {src: `${extras.musicBase}/${encodeURIComponent(video.music)}`, volume: video.musicVolume ?? DEFAULT_MUSIC_VOLUME}
    : undefined,
  fx: extras.fx,
  clips: expand(video, extras.fx).map((s, i) => ({
    ...srcFor(i, s),
    sourceStart: s.start,
    durationSec: s.end - s.start,
    speed: s.speed ?? 1,
    caption: s.caption,
    zoom: s.zoom,
    transition: extras.fx > 0 ? s.transition ?? 'fade' : 'fade',
    impactAt: extras.fx > 0 ? s.impactAt : undefined,
    badge: s.badge,
  })),
});

export const extrasFrom = (analysis: Analysis, plan: EditPlan, style: Style, musicBase = '/music'): Extras => ({
  theme: {accent: style.accent, textColor: style.textColor, captionBg: style.captionBg, titleFont: style.titleFont, textFont: style.textFont},
  musicBase,
  transcript: analysis.transcript,
  markers: plan.markers ?? [],
  sourceAspect: analysis.width / analysis.height,
  fx: plan.fx ?? 1,
  channelName: style.channelName,
});

export const KIND_LABEL: Record<VideoPlan['kind'], string> = {
  highlights: 'Melhores momentos',
  short: 'Short',
  long: 'Vídeo longo',
  teaser: 'Vinheta',
};

export const FIT_LABEL: Record<Fit, string> = {
  cover: 'Preencher a tela (corta as laterais)',
  wide: 'Mais aberto, com fundo desfocado',
  contain: 'Imagem inteira, com fundo desfocado',
};

/** Fração da largura do vídeo bruto que aparece na tela em cada enquadramento. */
export const visibleFraction = (fit: Fit, sourceAspect: number, compAspect: number) => {
  const cover = Math.min(1, compAspect / sourceAspect);
  return fit === 'contain' ? 1 : fit === 'wide' ? Math.max(cover, 0.7) : cover;
};

export const TRANSITION_LABEL: Record<Transition, string> = {
  fade: 'Fusão',
  flash: 'Flash',
  slide: 'Deslizar',
  zoom: 'Zoom',
  cut: 'Corte seco',
};

export const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};
