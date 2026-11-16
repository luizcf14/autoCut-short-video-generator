import React from 'react';
import {
  AbsoluteFill,
  Audio,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {
  contrastOn, DEFAULT_STYLE, INTRO_SEC, MUSIC_FADE_IN, MUSIC_FADE_OUT, layout, type Theme, visibleFraction, type AutoCutProps, type Fit, type ClipProps, type Marker, type Subtitle} from '../shared/types';

// A identidade visual (cores e fontes) vem do estilo escolhido na tela.
const ThemeCtx = React.createContext<Theme>(DEFAULT_STYLE);
const useTheme = () => {
  const t = React.useContext(ThemeCtx);
  return {
    ACCENT: t.accent,
    ON_ACCENT: contrastOn(t.accent), // letras sobre a cor de destaque
    TEXT: t.textColor,
    CAPTION_BG: `${t.captionBg}b8`, // fundo dos letreiros, 72% opaco
    FONT: `"${t.titleFont}", "Arial Black", Impact, Arial, sans-serif`,
    TEXT_FONT: `"${t.textFont}", "Segoe UI", Arial, sans-serif`,
  };
};

/**
 * A transcrição vem em frases longas. Quebra em pedaços curtos (até duas linhas na
 * tela) e divide o tempo da frase entre eles conforme o tamanho de cada pedaço.
 */
const subtitleChunk = (sub: Subtitle, time: number, maxChars: number) => {
  const chunks: string[] = [];
  for (const word of sub.text.split(/\s+/).filter(Boolean)) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + 1 + word.length <= maxChars) chunks[chunks.length - 1] = `${last} ${word}`;
    else chunks.push(word);
  }
  const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1;
  const progress = Math.max(0, Math.min(0.9999, (time - sub.start) / Math.max(0.01, sub.end - sub.start)));
  let acc = 0;
  for (const c of chunks) {
    acc += c.length / totalChars;
    if (progress < acc) return c;
  }
  return chunks[chunks.length - 1] ?? '';
};

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

/** Posição do marcador num instante, interpolando entre os pontos detectados. */
const markerPosition = (m: Marker, time: number) => {
  const pts = m.points;
  if (pts.length === 1 || time <= pts[0].t) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (time <= pts[i].t) {
      const k = (time - pts[i - 1].t) / Math.max(0.001, pts[i].t - pts[i - 1].t);
      return {x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k};
    }
  }
  return pts[pts.length - 1];
};

/** Círculo pulsando + seta apontando para o alvo. `x` e `y` em pixels da tela. */
const MarkerView: React.FC<{x: number; y: number; age: number; label?: string}> = ({x, y, age, label}) => {
  const frame = useCurrentFrame();
  const {ACCENT, ON_ACCENT, TEXT, CAPTION_BG, FONT, TEXT_FONT} = useTheme();
  const {fps, width, height} = useVideoConfig();
  const unit = Math.min(width, height) / 1080;
  const enter = spring({frame: age, fps, config: {damping: 12, mass: 0.6}, durationInFrames: 18});
  const pulse = 1 + 0.08 * Math.sin((frame / fps) * Math.PI * 3);
  const ring = 70 * unit;

  // A seta vem do lado onde há mais espaço (em direção ao centro da tela).
  let dx = width / 2 - x;
  let dy = height / 2 - y;
  if (Math.hypot(dx, dy) < 120 * unit) { dx = 1; dy = -1; }
  const len = Math.hypot(dx, dy);
  dx /= len;
  dy /= len;
  const bob = 14 * unit * Math.sin((frame / fps) * Math.PI * 4);
  const dist = ring + 30 * unit + bob + (1 - enter) * 200 * unit;
  const arrowLen = 190 * unit;
  const angle = (Math.atan2(-dy, -dx) * 180) / Math.PI; // a ponta aponta para o alvo
  const labelDist = dist + arrowLen + 46 * unit;
  const shadow = 'drop-shadow(0 4px 10px rgba(0,0,0,0.75))';

  return (
    <>
      <div style={{position: 'absolute', left: x - ring, top: y - ring, width: ring * 2, height: ring * 2,
        borderRadius: '50%', border: `${9 * unit}px solid ${ACCENT}`, boxSizing: 'border-box',
        transform: `scale(${enter * pulse})`, filter: shadow}} />
      <svg width={arrowLen} height={80 * unit} viewBox="0 0 190 80"
        style={{position: 'absolute', left: x + dx * dist, top: y + dy * dist - 40 * unit, opacity: enter,
          transformOrigin: '0 50%', transform: `rotate(${angle + 180}deg)`, filter: shadow, overflow: 'visible'}}>
        <path d="M0 40 L70 2 L70 24 L190 24 L190 56 L70 56 L70 78 Z" fill={ACCENT} stroke="#000" strokeWidth={5}
          strokeLinejoin="round" />
      </svg>
      {label ? (
        <div style={{position: 'absolute', left: x + dx * labelDist, top: y + dy * labelDist, opacity: enter,
          transform: 'translate(-50%, -50%)', fontFamily: FONT, fontSize: 40 * unit, color: ON_ACCENT,
          backgroundColor: ACCENT, padding: `${6 * unit}px ${18 * unit}px`, borderRadius: 8 * unit,
          whiteSpace: 'nowrap', textTransform: 'uppercase', filter: shadow}}>
          {label}
        </div>
      ) : null}
    </>
  );
};

const Clip: React.FC<{
  clip: ClipProps; subtitles: Subtitle[]; markers: Marker[]; sourceAspect: number; fit: Fit; fx: number;
  frames: number; captionDelay: number; fadeIn: number; fadeOut: number;
}> = ({clip, subtitles, markers, sourceAspect, fit, fx, frames, captionDelay, fadeIn, fadeOut}) => {
  const frame = useCurrentFrame();
  const {ACCENT, ON_ACCENT, TEXT, CAPTION_BG, FONT, TEXT_FONT} = useTheme();
  const {fps, width, height} = useVideoConfig();
  const unit = Math.min(width, height) / 1080;
  const portrait = height > width;
  const sourceTime = clip.sourceStart + (frame / fps) * clip.speed;

  // Zoom lento + "soco" de zoom com tremida no instante de impacto.
  let scale = clip.zoom ? interpolate(frame, [0, frames], [1, 1.14], clamp) : 1;
  let shakeX = 0;
  let shakeY = 0;
  if (clip.impactAt !== undefined) {
    const dt = (sourceTime - clip.impactAt) / clip.speed; // segundos de tela desde o impacto
    if (dt >= 0 && dt <= 0.6) {
      const amount = fx >= 2 ? 0.3 : 0.16;
      scale *= interpolate(dt, [0, 0.07, 0.6], [1, 1 + amount, 1], clamp);
      const decay = (1 - dt / 0.6) * (fx >= 2 ? 26 : 14) * unit;
      shakeX = Math.sin(dt * 95) * decay;
      shakeY = Math.cos(dt * 80) * decay;
    }
  }

  // Entrada do trecho (imagem) e rampa de volume nas duas pontas (som).
  const p = fadeIn > 0 ? interpolate(frame, [0, fadeIn], [0, 1], clamp) : 1;
  const eased = 1 - (1 - p) ** 3;
  const enterStyle: React.CSSProperties =
    clip.transition === 'slide' ? {transform: `translateX(${(1 - eased) * 100}%)`}
    : clip.transition === 'zoom' ? {opacity: p, transform: `scale(${1.35 - 0.35 * eased})`}
    : clip.transition === 'flash' ? {opacity: Math.min(1, p * 3)}
    : {opacity: p};
  const flash = clip.transition === 'flash' && fadeIn > 0
    ? interpolate(frame, [0, fadeIn * 1.6], [0.9, 0], clamp) : 0;
  const volume = (f: number) =>
    Math.min(
      fadeIn > 0 ? interpolate(f, [0, fadeIn], [0, 1], clamp) : 1,
      fadeOut > 0 ? interpolate(f, [frames - fadeOut, frames], [1, 0], clamp) : 1,
    );

  // Retângulo que o vídeo ocupa na tela. Se o vídeo bruto é mais largo que a tela (Shorts),
  // o enquadramento decide quanto da largura aparece; o que sobra em cima e embaixo é
  // preenchido com uma cópia desfocada. Caso contrário, preenche a tela.
  const compAspect = width / height;
  const wider = sourceAspect > compAspect;
  const vw = wider ? width / visibleFraction(fit, sourceAspect, compAspect) : width;
  const vh = vw / sourceAspect;
  const vx = (width - vw) / 2;
  const vy = (height - vh) / 2;
  const needsBackdrop = vh < height - 1;
  const active = markers
    .filter((m) => sourceTime >= m.start && sourceTime <= m.end)
    .map((m) => {
      const pos = markerPosition(m, sourceTime);
      return {
        m, x: vx + pos.x * vw, y: vy + pos.y * vh,
        age: ((sourceTime - m.start) / clip.speed) * fps,
        left: ((m.end - sourceTime) / clip.speed) * fps,
      };
    });
  // Quando o vídeo é mais largo que a tela (Shorts), desliza o enquadramento para o
  // alvo do marcador ficar visível, e volta ao centro quando o marcador some.
  let panX = 0;
  if (active[0] && vw > width + 1) {
    const maxPan = (vw - width) / 2;
    // Só o necessário para o alvo entrar na tela com folga (sem centralizar à força).
    const margin = width * 0.22;
    const x = active[0].x;
    const shift = x < margin ? margin - x : x > width - margin ? width - margin - x : 0;
    const wanted = Math.max(-maxPan, Math.min(maxPan, shift));
    const weight = Math.max(0, Math.min(1, active[0].age / 12, active[0].left / 12));
    panX = wanted * (1 - (1 - weight) ** 2);
  }
  const visibleMarkers = active.filter(
    (v) => v.x + panX > 40 * unit && v.x + panX < width - 40 * unit && v.y > 40 * unit && v.y < height - 40 * unit,
  );

  const trim = Math.round(clip.offsetSec * fps);
  const sub = subtitles.find((s) => sourceTime >= s.start && sourceTime <= s.end);
  // O letreiro espera o título de abertura sair e fica 4 s na tela.
  const hideAt = captionDelay + 4 * fps;
  const captionOut = interpolate(frame, [Math.min(frames - 8, hideAt), Math.min(frames, hideAt + 8)], [1, 0], clamp);
  const badge = clip.badge ?? (clip.speed < 1 ? 'CÂMERA LENTA' : undefined);

  return (
    <AbsoluteFill style={{backgroundColor: fadeIn > 0 ? 'transparent' : '#000', overflow: 'hidden', ...enterStyle}}>
      {needsBackdrop ? (
        <OffthreadVideo
          src={clip.src}
          trimBefore={trim}
          playbackRate={clip.speed}
          muted
          style={{position: 'absolute', width: '100%', height: '100%', objectFit: 'cover',
            filter: `blur(${36 * unit}px) brightness(0.55)`, transform: 'scale(1.15)'}}
        />
      ) : null}
      <AbsoluteFill style={{transform: `translate(${shakeX + panX}px, ${shakeY}px) scale(${scale})`}}>
        <OffthreadVideo
          src={clip.src}
          trimBefore={trim}
          playbackRate={clip.speed}
          volume={volume}
          pauseWhenBuffering
          style={{position: 'absolute', left: vx, top: vy, width: vw, height: vh, objectFit: 'cover'}}
        />
        {visibleMarkers.map((v, i) => (
          <MarkerView key={i} x={v.x} y={v.y} age={v.age} label={v.m.label} />
        ))}
      </AbsoluteFill>
      {flash > 0 ? <AbsoluteFill style={{backgroundColor: '#fff', opacity: flash}} /> : null}
      {badge ? (
        <div style={{position: 'absolute', top: (portrait ? 120 : 40) * unit, right: 40 * unit, fontFamily: FONT,
          fontSize: 30 * unit, color: ON_ACCENT, backgroundColor: ACCENT, padding: `${6 * unit}px ${16 * unit}px`,
          borderRadius: 6 * unit}}>
          {badge}
        </div>
      ) : null}
      {clip.caption ? (
        <div style={{position: 'absolute', left: 0, right: 0, top: portrait ? '16%' : undefined,
          bottom: portrait ? undefined : 150 * unit, display: 'flex', justifyContent: 'center', opacity: captionOut}}>
          <div style={{fontFamily: FONT, fontSize: (portrait ? 64 : 54) * unit, color: TEXT, textAlign: 'center',
            maxWidth: '86%', lineHeight: 1.1, textTransform: 'uppercase', padding: `${10 * unit}px ${26 * unit}px`,
            backgroundColor: CAPTION_BG, borderLeft: `${10 * unit}px solid ${ACCENT}`,
            opacity: interpolate(frame, [captionDelay, captionDelay + 5], [0, 1], clamp)}}>
            {clip.caption.split(/\s+/).filter(Boolean).map((word, i) => {
              // As palavras entram uma a uma.
              const w = spring({frame: frame - captionDelay - i * 3, fps, config: {damping: 14}, durationInFrames: 14});
              return (
                <span key={i} style={{display: 'inline-block', marginRight: '0.28em', opacity: Math.min(1, w * 2),
                  transform: `translateY(${(1 - w) * 26 * unit}px) scale(${0.7 + 0.3 * w})`}}>
                  {word}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}
      {sub ? (
        // Na vertical fica acima da área que os botões e a descrição do Shorts cobrem.
        <div style={{position: 'absolute', left: portrait ? '8%' : '10%', right: portrait ? '16%' : '10%',
          bottom: portrait ? '24%' : 56 * unit, textAlign: 'center'}}>
          <span style={{display: 'inline-block', maxWidth: '100%', boxSizing: 'border-box', fontFamily: TEXT_FONT,
            fontWeight: 700, fontSize: (portrait ? 50 : 42) * unit, color: TEXT, lineHeight: 1.2,
            overflowWrap: 'anywhere', textShadow: '0 2px 6px #000, 0 0 3px #000',
            backgroundColor: 'rgba(0,0,0,0.45)', padding: `${4 * unit}px ${16 * unit}px`, borderRadius: 8 * unit}}>
            {subtitleChunk(sub, sourceTime, portrait ? 44 : 70)}
          </span>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const IntroTitle: React.FC<{title: string; frames: number}> = ({title, frames}) => {
  const frame = useCurrentFrame();
  const {ACCENT, ON_ACCENT, TEXT, CAPTION_BG, FONT, TEXT_FONT} = useTheme();
  const {fps, width, height} = useVideoConfig();
  const unit = Math.min(width, height) / 1080;
  const enter = spring({frame, fps, config: {damping: 200}, durationInFrames: 15});
  const exit = interpolate(frame, [frames - 10, frames], [1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', opacity: exit,
      background: 'linear-gradient(rgba(0,0,0,0.15), rgba(0,0,0,0.55))'}}>
      <div style={{fontFamily: FONT, fontSize: 104 * unit, color: TEXT, textAlign: 'center', maxWidth: '88%',
        lineHeight: 1.02, textTransform: 'uppercase', textShadow: '0 6px 24px rgba(0,0,0,0.8)',
        transform: `scale(${0.85 + 0.15 * enter})`, opacity: enter}}>
        {title}
      </div>
      <div style={{width: 260 * unit * enter, height: 12 * unit, backgroundColor: ACCENT, marginTop: 28 * unit}} />
    </AbsoluteFill>
  );
};

const Outro: React.FC<{text: string; channelName?: string}> = ({text, channelName}) => {
  const frame = useCurrentFrame();
  const {ACCENT, ON_ACCENT, TEXT, CAPTION_BG, FONT, TEXT_FONT} = useTheme();
  const {fps, width, height} = useVideoConfig();
  const unit = Math.min(width, height) / 1080;
  const enter = spring({frame, fps, config: {damping: 200}, durationInFrames: 15});
  return (
    <AbsoluteFill style={{backgroundColor: '#0b0b0d', justifyContent: 'center', alignItems: 'center', opacity: enter}}>
      {channelName ? (
        <div style={{fontFamily: FONT, fontSize: 48 * unit, color: ACCENT, marginBottom: 24 * unit,
          textTransform: 'uppercase', textAlign: 'center'}}>{channelName}</div>
      ) : null}
      <div style={{fontFamily: FONT, fontSize: 84 * unit, color: TEXT, textAlign: 'center', maxWidth: '86%',
        lineHeight: 1.05, textTransform: 'uppercase', transform: `translateY(${(1 - enter) * 40}px)`}}>
        {text}
      </div>
    </AbsoluteFill>
  );
};

export const AutoCut: React.FC<AutoCutProps> = (props) => {
  const {clips, introTitle, outroText, channelName, subtitles, markers, sourceAspect, fit, fx} = props;
  const {fps} = useVideoConfig();
  const {frames, trans, starts, outroStart, outroFrames, total} = layout(props);
  const music = props.music;
  // Na vinheta o título fecha a sequência; nos outros vídeos ele abre, sobre o primeiro trecho.
  const titleAtEnd = Boolean(props.titleAtEnd);
  const introFrames = Math.min(Math.round(INTRO_SEC * fps), titleAtEnd ? outroStart : frames[0] ?? 0);
  return (
    <ThemeCtx.Provider value={props.theme ?? DEFAULT_STYLE}>
    <AbsoluteFill style={{backgroundColor: '#000'}}>
      {music ? (
        // Só vale para a prévia: na exportação a trilha é montada pelo ffmpeg (render.ts).
        <Audio
          src={music.src}
          loop
          volume={(f) => music.volume * Math.min(
            interpolate(f, [0, MUSIC_FADE_IN * fps], [0, 1], clamp),
            interpolate(f, [total - MUSIC_FADE_OUT * fps, total], [1, 0], clamp),
          )}
        />
      ) : null}
      {clips.map((clip, i) => (
        <Sequence key={i} from={starts[i]} durationInFrames={frames[i]} premountFor={fps}>
          <Clip
            clip={clip}
            subtitles={subtitles}
            markers={markers ?? []}
            sourceAspect={sourceAspect || 16 / 9}
            fit={fit ?? 'cover'}
            fx={fx ?? 1}
            frames={frames[i]}
            captionDelay={i === 0 && introTitle && !titleAtEnd ? introFrames : trans[i]}
            fadeIn={trans[i]}
            fadeOut={trans[i + 1] ?? 0}
          />
        </Sequence>
      ))}
      {outroText ? (
        <Sequence from={outroStart} durationInFrames={outroFrames}>
          <Outro text={outroText} channelName={channelName} />
        </Sequence>
      ) : null}
      {introTitle && introFrames > 0 ? (
        <Sequence from={titleAtEnd ? outroStart - introFrames : 0} durationInFrames={introFrames}>
          <IntroTitle title={introTitle} frames={introFrames} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
    </ThemeCtx.Provider>
  );
};
