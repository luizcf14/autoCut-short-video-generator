import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import {AutoCut} from '../remotion/AutoCut';
import {Settings} from './Settings';
import {
  buildProps,
  extrasFrom,
  FIT_LABEL,
  FITS,
  type Fit,
  DEFAULT_MUSIC_VOLUME,
  DEFAULT_STYLE,
  FONT_SUGGESTIONS,
  STYLE_PRESETS,
  type Style,
  dimensions,
  fmtTime,
  FPS,
  KIND_LABEL,
  QUALITIES,
  QUALITY_LABEL,
  type Quality,
  layout,
  totalFrames,
  TRANSITION_LABEL,
  TRANSITIONS,
  type Transition,
  type Analysis,
  type EditPlan,
  type Job,
  type Segment,
  type VideoPlan,
} from '../shared/types';

type VideoItem = {id: string; file: string; sizeMB: number; analyzed: boolean; planned: boolean};
type Project = VideoItem & {analysis: Analysis | null; plan: EditPlan | null};
type Status = {hasKey: boolean; model: string; videosDir: string; outputDir: string; channelName: string; musicDir: string; musicGenerator: string | null};

const api = async <T,>(url: string, method = 'GET', body?: unknown): Promise<T> => {
  const res = await fetch(url, {
    method,
    headers: body ? {'Content-Type': 'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Erro no servidor');
  return json;
};

/** Aceita "83", "83.5" ou "1:23". */
const parseTime = (text: string) => {
  const parts = text.trim().replace(',', '.').split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};

const TimeInput: React.FC<{value: number; onChange: (v: number) => void}> = ({value, onChange}) => {
  const [text, setText] = useState(fmtTime(value));
  useEffect(() => setText(fmtTime(value)), [value]);
  return (
    <input
      className="time"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const v = parseTime(text);
        if (v === null) setText(fmtTime(value));
        else onChange(v);
      }}
    />
  );
};

export const App: React.FC = () => {
  const [status, setStatus] = useState<Status | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [musics, setMusics] = useState<string[]>([]);
  const [styles, setStyles] = useState<Style[]>([]);
  const [styleId, setStyleId] = useState('');
  /** Estilo em edição no formulário (null = formulário fechado). */
  const [draft, setDraft] = useState<Style | null>(null);
  const [musicMode, setMusicMode] = useState<'auto' | 'describe'>('auto');
  const [musicDesc, setMusicDesc] = useState('');
  const [project, setProject] = useState<Project | null>(null);
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState('');
  const [instruction, setInstruction] = useState('');
  const [quality, setQuality] = useState<Quality>(() => {
    try {
      const saved = localStorage.getItem('autocut-quality') as Quality | null;
      return saved && QUALITIES.includes(saved) ? saved : 'alta';
    } catch {
      return 'alta';
    }
  });
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const player = useRef<PlayerRef>(null);

  const busy = job?.status === 'running';

  const refreshStatus = useCallback(async () => {
    setStatus(await api<Status>('/api/status'));
    await loadVideos().catch(() => undefined);
  }, []);

  const loadVideos = useCallback(async () => {
    setVideos(await api<VideoItem[]>('/api/videos'));
    setMusics(await api<string[]>('/api/music'));
    setStyles(await api<Style[]>('/api/styles'));
  }, []);
  const loadProject = useCallback(async (id: string) => {
    const p = await api<Project>(`/api/projects/${id}`);
    setProject(p);
    setPlan(p.plan);
    if (p.plan) setStyleId(p.plan.styleId ?? '');
    setDirty(false);
  }, []);

  useEffect(() => {
    refreshStatus().catch((e) => setError(String(e.message)));
    loadVideos().catch(() => undefined);
  }, [loadVideos]);

  /** Dispara uma tarefa no servidor e acompanha até terminar. */
  const runJob = async (url: string, body?: unknown) => {
    setError('');
    try {
      let j = await api<Job>(url, 'POST', body ?? {});
      setJob(j);
      while (j.status === 'running') {
        await new Promise((r) => setTimeout(r, 700));
        j = await api<Job>(`/api/jobs/${j.id}`);
        setJob(j);
      }
      if (j.status === 'error') throw new Error(j.error);
      return j.result;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setJob(null);
      throw e;
    }
  };

  const act = (fn: () => Promise<void>) => () => {
    fn().catch(() => undefined);
  };

  const savePlan = async () => {
    if (!project || !plan) return;
    const saved = await api<EditPlan>(`/api/projects/${project.id}/plan`, 'PUT', plan);
    setPlan(saved);
    setDirty(false);
  };

  const video: VideoPlan | undefined = plan?.videos[Math.min(tab, (plan?.videos.length ?? 1) - 1)];

  const updateVideo = (patch: Partial<VideoPlan>) => {
    if (!plan || !video) return;
    setPlan({...plan, videos: plan.videos.map((v) => (v === video ? {...v, ...patch} : v))});
    setDirty(true);
  };
  const updateSegment = (i: number, patch: Partial<Segment>) =>
    video && updateVideo({segments: video.segments.map((s, k) => (k === i ? {...s, ...patch} : s))});
  const moveSegment = (i: number, dir: -1 | 1) => {
    if (!video || i + dir < 0 || i + dir >= video.segments.length) return;
    const segments = [...video.segments];
    [segments[i], segments[i + dir]] = [segments[i + dir], segments[i]];
    updateVideo({segments});
  };

  const savedStyle = useMemo(
    () => styles.find((s) => s.id === styleId) ?? {...DEFAULT_STYLE, channelName: status?.channelName ?? ''},
    [styles, styleId, status],
  );
  // Enquanto o estilo escolhido está sendo editado, a prévia já mostra as mudanças.
  const previewStyle = draft && draft.id === styleId ? draft : savedStyle;

  const chooseStyle = (id: string) => {
    setStyleId(id);
    if (plan) {
      setPlan({...plan, styleId: id || undefined});
      setDirty(true);
    }
  };

  const props = useMemo(() => {
    if (!project?.analysis || !video || !plan) return null;
    const proxy = `/media/${project.id}/proxy.mp4`;
    return buildProps(video, extrasFrom(project.analysis, plan, previewStyle), (_i, s) => ({
      src: proxy,
      offsetSec: s.start,
    }));
  }, [project, video, plan, previewStyle]);

  /** Quadro da linha do tempo em que um instante do vídeo bruto aparece (ou null). */
  const frameForSourceTime = (t: number) => {
    if (!props) return null;
    const {starts} = layout(props);
    const i = props.clips.findIndex((c) => !c.badge && t >= c.sourceStart && t <= c.sourceStart + c.durationSec);
    return i < 0 ? null : starts[i] + Math.round(((t - props.clips[i].sourceStart) / props.clips[i].speed) * FPS);
  };

  // Marcadores que caem dentro dos trechos deste vídeo.
  const videoMarkers = (plan?.markers ?? []).filter((m) => frameForSourceTime(m.start) !== null);
  const updateMarkers = (fn: (m: NonNullable<EditPlan['markers']>) => NonNullable<EditPlan['markers']>) => {
    if (!plan) return;
    setPlan({...plan, markers: fn(plan.markers ?? [])});
    setDirty(true);
  };

  const seekToSegment = (i: number) => {
    if (!props) return;
    const seg = video?.segments[i];
    const k = props.clips.findIndex((c) => !c.badge && seg && c.sourceStart === seg.start);
    player.current?.seekTo(layout(props).starts[Math.max(0, k)] ?? 0);
    player.current?.play();
  };

  const duration = project?.analysis?.duration ?? 0;
  const size = props ? dimensions(props.format) : {width: 1920, height: 1080};
  const outSec = props ? totalFrames(props) / FPS : 0;

  return (
    <>
      <header>
        <h1>Auto<span>Cut</span></h1>
        <div className="status">
          {status ? (
            <>
              {status.hasKey ? `Claude: ${status.model}` : 'Sem chave do Claude: cortes só pelo áudio'}
              <br />
              Pasta: {status.videosDir}
            </>
          ) : 'Conectando ao servidor…'}
        </div>
        <button className={showSettings ? 'active' : ''} disabled={busy} onClick={() => setShowSettings((v) => !v)}>⚙ Configurações</button>
      </header>
      <div className="layout">
        <aside>
          <h2>Vídeos brutos</h2>
          {videos.length === 0 ? <p className="dim">Nenhum vídeo encontrado na pasta.</p> : null}
          {videos.map((v) => (
            <button
              key={v.id}
              className={`video ${project?.id === v.id ? 'active' : ''}`}
              disabled={busy}
              onClick={act(async () => {
                setTab(0);
                setJob(null);
                setError('');
                await loadProject(v.id);
              })}
            >
              {v.file}
              <small>{v.sizeMB} MB · {v.planned ? 'plano pronto' : v.analyzed ? 'analisado' : 'novo'}</small>
            </button>
          ))}
          <button className="small" onClick={act(loadVideos)}>Atualizar lista</button>
        </aside>

        <main>
          {showSettings ? (
            <Settings onClose={() => setShowSettings(false)} onSaved={() => void refreshStatus()} />
          ) : (
          <>
          {status && !status.hasKey ? (
            <div className="banner">
              Falta a chave do Claude: sem ela, os cortes são montados só pelo áudio e não há letreiros, setas nem textos para o YouTube.{' '}
              <button className="small primary" onClick={() => setShowSettings(true)}>Configurar agora</button>
            </div>
          ) : null}
          {!project ? <p className="dim">Escolha um vídeo na lista ao lado para começar.</p> : null}

          {project ? (
            <section>
              <h2>Estilo</h2>
              <div className="row">
                <select value={styleId} disabled={busy} onChange={(e) => chooseStyle(e.target.value)}>
                  <option value="">Padrão (amarelo)</option>
                  {styles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <span className="swatch" style={{backgroundColor: previewStyle.accent}} />
                <button className="small" disabled={!styleId} onClick={() => setDraft(draft ? null : savedStyle)}>
                  {draft && draft.id ? 'Fechar edição' : 'Editar este estilo'}
                </button>
                <button className="small" onClick={() => setDraft({...DEFAULT_STYLE, name: '', channelName: status?.channelName ?? ''})}>
                  + Novo estilo
                </button>
                <span className="dim">Cores, fontes e o jeito de editar. Vale para a prévia, a exportação e os próximos planos.</span>
              </div>
              {draft ? (
                <div className="styleform">
                  <label>Nome do estilo<input value={draft.name} placeholder="Ex.: Kartec" onChange={(e) => setDraft({...draft, name: e.target.value})} /></label>
                  <label>Nome do canal (tela final)<input value={draft.channelName} onChange={(e) => setDraft({...draft, channelName: e.target.value})} /></label>
                  <label>Cor de destaque<input type="color" value={draft.accent} onChange={(e) => setDraft({...draft, accent: e.target.value})} /></label>
                  <label>Cor das letras<input type="color" value={draft.textColor} onChange={(e) => setDraft({...draft, textColor: e.target.value})} /></label>
                  <label>Fundo dos letreiros<input type="color" value={draft.captionBg} onChange={(e) => setDraft({...draft, captionBg: e.target.value})} /></label>
                  <label>Fonte dos títulos<input list="fonts" value={draft.titleFont} onChange={(e) => setDraft({...draft, titleFont: e.target.value})} /></label>
                  <label>Fonte das legendas<input list="fonts" value={draft.textFont} onChange={(e) => setDraft({...draft, textFont: e.target.value})} /></label>
                  <datalist id="fonts">{FONT_SUGGESTIONS.map((f) => <option key={f} value={f} />)}</datalist>
                  <label className="wide">
                    Orientação de edição para o Claude
                    <textarea style={{minHeight: 90}} value={draft.prompt}
                      placeholder="Descreva o tipo de vídeo, o ritmo e o tom dos textos. Ou comece por um dos modelos abaixo e ajuste."
                      onChange={(e) => setDraft({...draft, prompt: e.target.value})} />
                  </label>
                  <div className="row wide">
                    <span className="dim">Modelos:</span>
                    {STYLE_PRESETS.map((p) => (
                      <button key={p.label} className="small" onClick={() => setDraft({...draft, prompt: p.prompt})}>{p.label}</button>
                    ))}
                  </div>
                  <div className="row wide">
                    <button className="primary" disabled={!draft.name.trim()} onClick={act(async () => {
                      setError('');
                      try {
                        const saved = await api<Style>('/api/styles', 'PUT', draft);
                        setStyles(await api<Style[]>('/api/styles'));
                        chooseStyle(saved.id);
                        setDraft(null);
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    })}>Salvar estilo</button>
                    <button onClick={() => setDraft(null)}>Cancelar</button>
                    {draft.id ? (
                      <button onClick={act(async () => {
                        await api(`/api/styles/${draft.id}`, 'DELETE');
                        setStyles(await api<Style[]>('/api/styles'));
                        chooseStyle('');
                        setDraft(null);
                      })}>Excluir estilo</button>
                    ) : null}
                    <span className="dim">A orientação só muda os cortes quando você gera o plano de novo ou pede uma alteração.</span>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {project ? (
            <section>
              <h2>1. Analisar e planejar</h2>
              <div className="row">
                <button
                  className={project.analysis ? '' : 'primary'}
                  disabled={busy}
                  onClick={act(async () => {
                    await runJob(`/api/projects/${project.id}/analyze`);
                    await loadProject(project.id);
                    await loadVideos();
                  })}
                >
                  {project.analysis ? 'Analisar de novo' : 'Analisar vídeo'}
                </button>
                {project.analysis ? (
                  <span className="dim">
                    {fmtTime(duration)} · {project.analysis.width}x{project.analysis.height} ·{' '}
                    {project.analysis.frames.length} quadros ·{' '}
                    {project.analysis.transcript.length ? 'fala transcrita' : 'sem fala transcrita'}
                  </span>
                ) : (
                  <span className="dim">Cria a prévia leve, mede o áudio e tira os quadros. Pode demorar alguns minutos.</span>
                )}
              </div>
              {project.analysis ? (
                <div style={{marginTop: 12}}>
                  <textarea
                    placeholder="Orientações para o Claude (opcional). Ex.: foque nas ultrapassagens, quero um tom bem-humorado, a batida aos 12:30 tem que entrar."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                  <div className="row" style={{marginTop: 8}}>
                    <button
                      className={plan ? '' : 'primary'}
                      disabled={busy}
                      onClick={act(async () => {
                        await runJob(`/api/projects/${project.id}/plan`, {notes, styleId: styleId || undefined});
                        await loadProject(project.id);
                        await loadVideos();
                      })}
                    >
                      {plan ? 'Gerar plano de novo' : status?.hasKey ? 'Gerar plano com o Claude' : 'Gerar plano'}
                    </button>
                    {plan?.source === 'heuristic' ? (
                      <span className="dim">Plano atual feito só pelo áudio (sem Claude).</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {busy && job ? (
                <>
                  <div className="dim" style={{marginTop: 12}}>{job.message} ({Math.round(job.progress * 100)}%)</div>
                  <div className="progress"><div style={{width: `${job.progress * 100}%`}} /></div>
                </>
              ) : null}
              {error ? <div className="error">{error}</div> : null}
            </section>
          ) : null}

          {project && plan && video && props ? (
            <>
              <section>
                <h2>2. Revisar</h2>
                <div className="tabs">
                  {plan.videos.map((v, i) => (
                    <button key={v.id} className={i === tab ? 'active' : ''} onClick={() => setTab(i)}>
                      {KIND_LABEL[v.kind]}{v.kind === 'short' || v.kind === 'teaser' ? ` · ${v.title}` : ''}
                    </button>
                  ))}
                  <button
                    disabled={busy}
                    title="Monta uma vinheta de 10 segundos com os momentos mais importantes, na horizontal e na vertical"
                    onClick={act(async () => {
                      if (dirty) await savePlan();
                      await runJob(`/api/projects/${project.id}/teaser`);
                      const fresh = await api<Project>(`/api/projects/${project.id}`);
                      await loadProject(project.id);
                      setTab(Math.max(0, (fresh.plan?.videos ?? []).findIndex((v) => v.kind === 'teaser')));
                    })}
                  >
                    {plan.videos.some((v) => v.kind === 'teaser') ? '↻ Refazer vinheta' : '+ Gerar vinheta de 10 s'}
                  </button>
                  <label className="dim" style={{marginLeft: 'auto'}}>
                    Efeitos:{' '}
                    <select value={plan.fx ?? 1} onChange={(e) => { setPlan({...plan, fx: Number(e.target.value)}); setDirty(true); }}>
                      <option value={0}>Sem efeitos</option><option value={1}>Normal</option><option value={2}>Intenso</option>
                    </select>
                  </label>
                </div>
                <div className="editor">
                  <div>
                    <div className="player">
                      <Player
                        key={video.id}
                        ref={player}
                        component={AutoCut}
                        inputProps={props}
                        durationInFrames={totalFrames(props)}
                        fps={FPS}
                        compositionWidth={size.width}
                        compositionHeight={size.height}
                        controls
                        style={props.format === 'portrait' ? {height: 560, width: 315} : {width: '100%'}}
                      />
                    </div>
                    <p className="dim">
                      Duração final: {fmtTime(outSec)} · {props.format === 'portrait' ? 'vertical 9:16' : 'horizontal 16:9'}.
                      A prévia usa uma versão leve; a exportação usa o arquivo original.
                    </p>
                    <div className="meta">
                      <label>Título na abertura</label>
                      <input value={video.introTitle ?? ''} onChange={(e) => updateVideo({introTitle: e.target.value || undefined})} />
                      {props.format === 'portrait' ? (
                        <>
                          <label>Enquadramento vertical</label>
                          <select style={{width: '100%'}} value={video.fit ?? 'cover'} onChange={(e) => updateVideo({fit: e.target.value as Fit})}>
                            {FITS.map((f) => <option key={f} value={f}>{FIT_LABEL[f]}</option>)}
                          </select>
                        </>
                      ) : null}
                      <label>Música de fundo</label>
                      <div className="row">
                        <select className="grow" value={video.music ?? ''} onChange={(e) => updateVideo({music: e.target.value || undefined})}>
                          <option value="">Nenhuma</option>
                          {video.music && !musics.includes(video.music) ? <option value={video.music}>{video.music} (não encontrada)</option> : null}
                          {musics.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                        {video.music ? (
                          <>
                            <input type="range" min={0} max={0.6} step={0.01} title="Volume da música"
                              value={video.musicVolume ?? DEFAULT_MUSIC_VOLUME}
                              onChange={(e) => updateVideo({musicVolume: Number(e.target.value)})} />
                            <span className="dim">{Math.round((video.musicVolume ?? DEFAULT_MUSIC_VOLUME) * 100)}%</span>
                          </>
                        ) : null}
                      </div>
                      {video.musicNote && video.music?.startsWith('gerada_') ? (
                        <div className="dim" style={{fontSize: 12, marginTop: 4}}>Música gerada: {video.musicNote}</div>
                      ) : null}
                      <div className="musicgen">
                        <div className="row">
                          <label><input type="radio" checked={musicMode === 'auto'} onChange={() => setMusicMode('auto')} /> Gerar automaticamente</label>
                          <label><input type="radio" checked={musicMode === 'describe'} onChange={() => setMusicMode('describe')} /> Descrever a música</label>
                        </div>
                        {musicMode === 'describe' ? (
                          <textarea value={musicDesc} onChange={(e) => setMusicDesc(e.target.value)}
                            placeholder="Ex.: rock pesado com guitarra distorcida e bateria forte; ou lo-fi tranquilo de oficina, com baixo marcado." />
                        ) : (
                          <div className="dim" style={{fontSize: 12}}>
                            {status?.hasKey ? 'O Claude escolhe a música pelo estilo do canal e pelo conteúdo deste vídeo.' : 'Sem a chave da Anthropic, usa um pedido padrão.'}
                          </div>
                        )}
                        <button
                          disabled={busy || !status?.musicGenerator || (musicMode === 'describe' && !musicDesc.trim())}
                          title={status?.musicGenerator ? `Usa ${status.musicGenerator}` : 'Coloque GEMINI_API_KEY ou ELEVENLABS_API_KEY no .env'}
                          onClick={act(async () => {
                            if (dirty) await savePlan();
                            await runJob(`/api/projects/${project.id}/music`, {videoId: video.id, mode: musicMode, description: musicDesc});
                            await loadVideos();
                            await loadProject(project.id);
                          })}
                        >
                          🎵 Gerar música para este vídeo
                        </button>
                        <div className="dim" style={{fontSize: 12}}>
                          {status?.musicGenerator
                            ? `Gerador: ${status.musicGenerator}. A música é salva na pasta de músicas e já fica escolhida.`
                            : 'Para gerar músicas, coloque GEMINI_API_KEY ou ELEVENLABS_API_KEY no .env e reinicie.'}
                          {' '}Também dá para usar seus MP3 da pasta {status?.musicDir}.
                        </div>
                      </div>
                      <label>Texto da tela final</label>
                      <input value={video.outroText ?? ''} onChange={(e) => updateVideo({outroText: e.target.value || undefined})} />
                    </div>
                  </div>
                  <div>
                    <table>
                      <thead>
                        <tr><th>#</th><th>Início</th><th>Fim</th><th>Veloc.</th><th>Entrada</th><th title="Zoom lento">Zoom</th><th title="Instante do soco de zoom">Impacto</th><th>Replay</th><th>Letreiro</th><th /></tr>
                      </thead>
                      <tbody>
                        {video.segments.map((s, i) => (
                          <tr key={i}>
                            <td><button className="small" title="Ver este trecho" onClick={() => seekToSegment(i)}>▶ {i + 1}</button></td>
                            <td><TimeInput value={s.start} onChange={(v) => updateSegment(i, {start: Math.max(0, Math.min(v, s.end - 0.5))})} /></td>
                            <td><TimeInput value={s.end} onChange={(v) => updateSegment(i, {end: Math.min(duration, Math.max(v, s.start + 0.5))})} /></td>
                            <td>
                              <select value={s.speed ?? 1} onChange={(e) => updateSegment(i, {speed: Number(e.target.value) === 1 ? undefined : Number(e.target.value)})}>
                                <option value={0.5}>0,5x</option><option value={1}>1x</option>
                                <option value={2}>2x</option><option value={4}>4x</option>
                              </select>
                            </td>
                            <td>
                              <select value={s.transition ?? 'fade'} disabled={i === 0} onChange={(e) => updateSegment(i, {transition: e.target.value as Transition})}>
                                {TRANSITIONS.map((t) => <option key={t} value={t}>{TRANSITION_LABEL[t]}</option>)}
                              </select>
                            </td>
                            <td><input type="checkbox" checked={Boolean(s.zoom)} onChange={(e) => updateSegment(i, {zoom: e.target.checked || undefined})} /></td>
                            <td>
                              <input className="time" placeholder="—" key={`${i}-${s.impactAt}`} defaultValue={s.impactAt === undefined ? '' : fmtTime(s.impactAt)}
                                onBlur={(e) => {
                                  const v = e.target.value.trim() ? parseTime(e.target.value) : null;
                                  updateSegment(i, {impactAt: v !== null && v > s.start && v < s.end ? v : undefined});
                                }} />
                            </td>
                            <td><input type="checkbox" checked={Boolean(s.replay)} onChange={(e) => updateSegment(i, {replay: e.target.checked || undefined})} /></td>
                            <td><input className="cap" value={s.caption ?? ''} onChange={(e) => updateSegment(i, {caption: e.target.value || undefined})} /></td>
                            <td style={{whiteSpace: 'nowrap'}}>
                              <button className="small" onClick={() => moveSegment(i, -1)}>↑</button>{' '}
                              <button className="small" onClick={() => moveSegment(i, 1)}>↓</button>{' '}
                              <button className="small" title="Remover" disabled={video.segments.length === 1}
                                onClick={() => updateVideo({segments: video.segments.filter((_, k) => k !== i)})}>✕</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="row" style={{marginTop: 10}}>
                      <button className="small" onClick={() => {
                        const last = video.segments[video.segments.length - 1];
                        const start = Math.min(last ? last.end : 0, Math.max(0, duration - 5));
                        updateVideo({segments: [...video.segments, {start, end: Math.min(duration, start + 5)}]});
                      }}>+ Adicionar trecho</button>
                      <button disabled={!dirty || busy} onClick={act(savePlan)}>Salvar alterações</button>
                    </div>
                    <div style={{marginTop: 16}}>
                      <div className="row">
                        <button
                          disabled={busy || !status?.hasKey}
                          title={status?.hasKey ? '' : 'Precisa da chave da API'}
                          onClick={act(async () => {
                            if (dirty) await savePlan();
                            await runJob(`/api/projects/${project.id}/markers`, {videoId: video.id});
                            await loadProject(project.id);
                          })}
                        >
                          Detectar apontamentos neste vídeo
                        </button>
                        <span className="dim">
                          O Claude olha um quadro a cada 2 s dos trechos e põe uma seta onde alguém aponta para algo.
                        </span>
                      </div>
                      {videoMarkers.length ? (
                        <table style={{marginTop: 8}}>
                          <thead><tr><th>Seta</th><th>Tempo</th><th>Texto</th><th>Posição (x, y em %)</th><th /></tr></thead>
                          <tbody>
                            {videoMarkers.map((m) => {
                              const idx = (plan.markers ?? []).indexOf(m);
                              const set = (patch: Partial<typeof m>) => updateMarkers((all) => all.map((x, k) => (k === idx ? {...x, ...patch} : x)));
                              const nudge = (axis: 'x' | 'y', pct: number) => {
                                const delta = pct / 100 - m.points[0][axis];
                                set({points: m.points.map((pt) => ({...pt, [axis]: Math.max(0, Math.min(1, pt[axis] + delta))}))});
                              };
                              return (
                                <tr key={idx}>
                                  <td><button className="small" onClick={() => { const f = frameForSourceTime(m.start + 0.5); if (f !== null) { player.current?.seekTo(f); player.current?.pause(); } }}>▶</button></td>
                                  <td>{fmtTime(m.start)}–{fmtTime(m.end)}</td>
                                  <td><input className="cap" value={m.label ?? ''} onChange={(e) => set({label: e.target.value || undefined})} /></td>
                                  <td style={{whiteSpace: 'nowrap'}}>
                                    <input className="time" type="number" min={0} max={100} value={Math.round(m.points[0].x * 100)} onChange={(e) => nudge('x', Number(e.target.value))} />{' '}
                                    <input className="time" type="number" min={0} max={100} value={Math.round(m.points[0].y * 100)} onChange={(e) => nudge('y', Number(e.target.value))} />
                                  </td>
                                  <td><button className="small" title="Remover" onClick={() => updateMarkers((all) => all.filter((_, k) => k !== idx))}>✕</button></td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ) : null}
                    </div>
                    <div style={{marginTop: 16}}>
                      <textarea
                        placeholder={status?.hasKey
                          ? 'Peça uma alteração em texto. Ex.: deixa os melhores momentos com no máximo 4 minutos e tira o trecho dos boxes.'
                          : 'Pedir alterações em texto precisa da chave da API.'}
                        value={instruction}
                        disabled={!status?.hasKey}
                        onChange={(e) => setInstruction(e.target.value)}
                      />
                      <button
                        style={{marginTop: 8}}
                        disabled={busy || !status?.hasKey || !instruction.trim()}
                        onClick={act(async () => {
                          if (dirty) await savePlan();
                          await runJob(`/api/projects/${project.id}/refine`, {instruction});
                          setInstruction('');
                          await loadProject(project.id);
                        })}
                      >
                        Pedir alteração ao Claude
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <section>
                <h2>3. Exportar</h2>
                <div className="row">
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={act(async () => {
                      if (dirty) await savePlan();
                      const result = (await runJob(`/api/projects/${project.id}/render`, {videoId: video.id, quality})) as {output: string};
                      setOutputs((o) => ({...o, [video.id]: result.output}));
                    })}
                  >
                    Exportar "{KIND_LABEL[video.kind]}{video.kind === 'short' || video.kind === 'teaser' ? ` · ${video.title}` : ''}"
                  </button>
                  <label className="dim">
                    Qualidade:{' '}
                    <select value={quality} onChange={(e) => {
                      const v = e.target.value as Quality;
                      setQuality(v);
                      try { localStorage.setItem('autocut-quality', v); } catch { /* sem armazenamento: só não lembra */ }
                    }}>
                      {QUALITIES.map((k) => <option key={k} value={k}>{QUALITY_LABEL[k]}</option>)}
                    </select>
                  </label>
                  <span className="dim">Salva em {status?.outputDir}</span>
                </div>
                {outputs[video.id] ? <div className="out">Vídeo pronto: {outputs[video.id]}</div> : null}
              </section>

              <section className="meta">
                <h2>Para o YouTube</h2>
                <label>Título</label>
                <input value={plan.youtube.title} onChange={(e) => { setPlan({...plan, youtube: {...plan.youtube, title: e.target.value}}); setDirty(true); }} />
                <label>Descrição</label>
                <textarea style={{minHeight: 110}} value={plan.youtube.description} onChange={(e) => { setPlan({...plan, youtube: {...plan.youtube, description: e.target.value}}); setDirty(true); }} />
                <label>Tags</label>
                <div>{plan.youtube.tags.join(', ') || <span className="dim">—</span>}</div>
                <label>Ideia de thumbnail</label>
                <div>{plan.youtube.thumbnailIdea || <span className="dim">—</span>}</div>
              </section>
            </>
          ) : null}
          </>
          )}
        </main>
      </div>
    </>
  );
};
