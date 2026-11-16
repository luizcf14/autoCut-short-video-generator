import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import express from 'express';
import {
  DEFAULT_STYLE, EditPlanSchema, QUALITIES, StyleSchema,
  type Analysis, type EditPlan, type Job, type Quality, type Style,
} from '../shared/types';
import {AUDIO_EXT, cleanTmp, config, slug, VIDEO_EXT} from './config';
import {analyze} from './analyze';
import {buildTeaser, detectPointing, planHeuristic, planWithClaude, refineWithClaude, sanitize} from './planner';
import {renderVideo} from './render';
import {generateMusic, musicProvider, PROVIDER_LABEL} from './music';
import {readSettings, saveSettings, testKey} from './settings';
import {downloadYoutubeVideo, validateYoutubeUrl, type YoutubeQuality} from './youtube';

const app = express();
app.use(express.json({limit: '5mb'}));
// Só aceita pedidos feitos para este computador (bloqueia sites que tentem usar o AutoCut
// por trás, por "DNS rebinding"), já que a API lê e grava as chaves.
app.use((req, res, next) => {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return next();
  res.status(403).send('Acesso permitido só a partir deste computador.');
});

// As pastas podem mudar na tela de Configurações, então o servidor de arquivos é criado na hora.
app.use('/media', (req, res, next) => express.static(config.workDir)(req, res, next));
app.use('/music', (req, res, next) => express.static(config.musicDir)(req, res, next));

const jobs = new Map<string, Job>();

/** Roda uma tarefa demorada em segundo plano; a tela acompanha por /api/jobs/:id. */
const startJob = (fn: (progress: (f: number, m: string) => void) => Promise<unknown>) => {
  const job: Job = {id: randomUUID(), status: 'running', progress: 0, message: 'Iniciando'};
  jobs.set(job.id, job);
  fn((f, m) => {
    job.progress = f;
    job.message = m;
  })
    .then((result) => Object.assign(job, {status: 'done', progress: 1, message: 'Concluído', result}))
    .catch((e) => {
      console.error(e);
      Object.assign(job, {status: 'error', error: e instanceof Error ? e.message : String(e)});
    });
  return job;
};

const listVideos = async () => {
  if (!existsSync(config.videosDir)) return [];
  const files = (await fs.readdir(config.videosDir)).filter((f) => VIDEO_EXT.test(f));
  return Promise.all(
    files.map(async (file) => {
      const id = slug(file);
      const dir = path.join(config.workDir, id);
      const stat = await fs.stat(path.join(config.videosDir, file));
      return {
        id,
        file,
        sizeMB: Math.round(stat.size / 1e6),
        analyzed: existsSync(path.join(dir, 'analysis.json')),
        planned: existsSync(path.join(dir, 'plan.json')),
      };
    }),
  );
};

const project = async (id: string) => {
  const video = (await listVideos()).find((v) => v.id === id);
  if (!video) throw new Error('Vídeo não encontrado na pasta.');
  const dir = path.join(config.workDir, id);
  const read = async <T,>(name: string): Promise<T | null> =>
    existsSync(path.join(dir, name)) ? JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) : null;
  return {
    ...video,
    dir,
    original: path.join(config.videosDir, video.file),
    analysis: await read<Analysis>('analysis.json'),
    plan: await read<EditPlan>('plan.json'),
  };
};

// ---- Estilos: um arquivo JSON por estilo na pasta `estilos` ----
const defaultStyle = (): Style => ({...DEFAULT_STYLE, channelName: config.channelName});

const listStyles = async (): Promise<Style[]> => {
  if (!existsSync(config.stylesDir)) return [];
  const out: Style[] = [];
  for (const f of (await fs.readdir(config.stylesDir)).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(config.stylesDir, f), 'utf8'));
      out.push(StyleSchema.parse({...DEFAULT_STYLE, ...raw, id: f.replace(/\.json$/, '')}));
    } catch (e) {
      console.warn(`Estilo ignorado (arquivo inválido): ${f}`);
    }
  }
  return out;
};

const styleFor = async (id: string | undefined) =>
  (id ? (await listStyles()).find((s) => s.id === id) : undefined) ?? defaultStyle();

const savePlan = (dir: string, plan: EditPlan) =>
  fs.writeFile(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2));

const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e) => res.status(400).json({error: e instanceof Error ? e.message : String(e)}));

app.get('/api/status', (_req, res) =>
  res.json({
    hasKey: Boolean(config.apiKey),
    configured: {claude: Boolean(config.apiKey), gemini: Boolean(config.geminiKey), elevenlabs: Boolean(config.elevenKey)},
    model: config.model,
    videosDir: config.videosDir,
    outputDir: config.outputDir,
    channelName: config.channelName,
    musicDir: config.musicDir,
    musicGenerator: (() => {
      const p = musicProvider();
      return p ? PROVIDER_LABEL[p] : null;
    })(),
  }),
);

app.get('/api/music', wrap(async (_req, res) => {
  await fs.mkdir(config.musicDir, {recursive: true}).catch(() => undefined);
  const files = existsSync(config.musicDir) ? await fs.readdir(config.musicDir) : [];
  res.json(files.filter((f) => AUDIO_EXT.test(f)).sort());
}));

app.get('/api/settings', wrap(async (_req, res) => res.json(await readSettings())));

app.put('/api/settings', wrap(async (req, res) => {
  const values = (req.body?.values ?? {}) as Record<string, unknown>;
  const clear = Array.isArray(req.body?.clear) ? (req.body.clear as unknown[]).map(String) : [];
  const busy = [...jobs.values()].some((j) => j.status === 'running');
  const dirKeys = ['VIDEOS_DIR', 'OUTPUT_DIR', 'WORK_DIR', 'MUSIC_DIR'];
  if (busy && dirKeys.some((k) => (k in values && String(values[k] ?? '') !== (process.env[k] ?? '')) || clear.includes(k))) {
    throw new Error('Espere a tarefa em andamento terminar para mudar as pastas.');
  }
  const result = await saveSettings(values, clear);
  res.json({...result, settings: await readSettings()});
}));

app.post('/api/settings/test', wrap(async (req, res) => {
  res.json(await testKey(String(req.body?.service ?? ''), req.body?.key));
}));

app.get('/api/styles', wrap(async (_req, res) => res.json(await listStyles())));

app.put('/api/styles', wrap(async (req, res) => {
  const body = StyleSchema.parse({...req.body, id: String(req.body?.id ?? '')});
  const id = slug(body.id || body.name).toLowerCase();
  await fs.mkdir(config.stylesDir, {recursive: true});
  const {id: _id, ...data} = body;
  await fs.writeFile(path.join(config.stylesDir, `${id}.json`), JSON.stringify(data, null, 2));
  res.json({...body, id});
}));

app.delete('/api/styles/:id', wrap(async (req, res) => {
  await fs.rm(path.join(config.stylesDir, `${slug(req.params.id)}.json`), {force: true});
  res.json({ok: true});
}));

app.get('/api/videos', wrap(async (_req, res) => res.json(await listVideos())));

app.post('/api/youtube/download', wrap(async (req, res) => {
  const url = validateYoutubeUrl(String(req.body?.url ?? ''));
  const quality: YoutubeQuality = req.body?.quality === '1080' ? '1080' : 'max';
  res.json(startJob((progress) => downloadYoutubeVideo(url, quality, progress)));
}));

app.get('/api/projects/:id', wrap(async (req, res) => {
  const {dir: _d, original: _o, ...p} = await project(req.params.id);
  res.json(p);
}));

app.post('/api/projects/:id/analyze', wrap(async (req, res) => {
  const p = await project(req.params.id);
  res.json(startJob((progress) => analyze(p.original, p.dir, progress).then(() => null)));
}));

app.post('/api/projects/:id/plan', wrap(async (req, res) => {
  const p = await project(req.params.id);
  if (!p.analysis) throw new Error('Analise o vídeo primeiro.');
  const a = p.analysis;
  res.json(startJob(async (progress) => {
    progress(0.2, config.apiKey ? `Enviando ${a.frames.length} quadros para o Claude` : 'Montando plano pelo áudio');
    const styleId = req.body?.styleId ? String(req.body.styleId) : undefined;
    const style = await styleFor(styleId);
    const plan = config.apiKey ? await planWithClaude(a, p.dir, String(req.body?.notes ?? ''), style) : planHeuristic(a);
    plan.styleId = styleId;
    await savePlan(p.dir, plan);
    return null;
  }));
}));

app.post('/api/projects/:id/refine', wrap(async (req, res) => {
  const p = await project(req.params.id);
  if (!p.analysis || !p.plan) throw new Error('Gere um plano primeiro.');
  if (!config.apiKey) throw new Error('Pedir alterações em texto precisa da chave da API (ANTHROPIC_API_KEY).');
  const {analysis, plan} = p;
  res.json(startJob(async (progress) => {
    progress(0.3, 'Claude está ajustando o plano');
    // As vinhetas são montadas à parte e não passam pelo ajuste em texto.
    const teasers = plan.videos.filter((v) => v.kind === 'teaser');
    const refined = await refineWithClaude(
      analysis, {...plan, videos: plan.videos.filter((v) => v.kind !== 'teaser')},
      String(req.body?.instruction ?? ''), await styleFor(plan.styleId),
    );
    // Marcadores, música e intensidade dos efeitos não passam pelo Claude nesta etapa: mantém.
    const videos = refined.videos.map((v) => {
      const old = plan.videos.find((o) => o.id === v.id);
      return {...v, music: old?.music, musicVolume: old?.musicVolume, musicNote: old?.musicNote, fit: v.fit ?? old?.fit};
    });
    await savePlan(p.dir, {...refined, videos: [...videos.filter((v) => v.kind !== 'teaser'), ...teasers], markers: plan.markers, fx: plan.fx, styleId: plan.styleId});
    return null;
  }));
}));

app.put('/api/projects/:id/plan', wrap(async (req, res) => {
  const p = await project(req.params.id);
  if (!p.analysis) throw new Error('Analise o vídeo primeiro.');
  const plan = sanitize(EditPlanSchema.parse(req.body), p.analysis, req.body.source);
  await savePlan(p.dir, plan);
  res.json(plan);
}));

app.post('/api/projects/:id/render', wrap(async (req, res) => {
  const p = await project(req.params.id);
  const video = p.plan?.videos.find((v) => v.id === req.body?.videoId);
  if (!p.analysis || !video) throw new Error('Vídeo do plano não encontrado.');
  const a = p.analysis;
  const plan = p.plan!;
  const quality: Quality = QUALITIES.includes(req.body?.quality) ? req.body.quality : 'alta';
  const style = await styleFor(plan.styleId);
  res.json(startJob((progress) => renderVideo(p.id, p.original, a, plan, video, style, quality, progress)));
}));

app.post('/api/projects/:id/markers', wrap(async (req, res) => {
  const p = await project(req.params.id);
  const video = p.plan?.videos.find((v) => v.id === req.body?.videoId);
  if (!p.analysis || !p.plan || !video) throw new Error('Vídeo do plano não encontrado.');
  if (!config.apiKey) throw new Error('Detectar apontamentos precisa da chave da API (ANTHROPIC_API_KEY).');
  const {analysis, plan} = p;
  res.json(startJob(async (progress) => {
    const {markers, ranges} = await detectPointing(analysis, p.dir, video, progress);
    // Substitui só os marcadores dos trechos que foram examinados agora.
    const kept = (plan.markers ?? []).filter((m) => !ranges.some((r) => m.start < r.end && m.end > r.start));
    const latest = (await project(p.id)).plan ?? plan;
    await savePlan(p.dir, {...latest, markers: [...kept, ...markers].sort((x, y) => x.start - y.start)});
    return {found: markers.length};
  }));
}));

app.post('/api/projects/:id/teaser', wrap(async (req, res) => {
  const p = await project(req.params.id);
  if (!p.analysis || !p.plan) throw new Error('Gere um plano primeiro.');
  const {analysis, plan} = p;
  res.json(startJob(async (progress) => {
    progress(0.3, config.apiKey ? 'Claude está escolhendo os momentos da vinheta' : 'Escolhendo os momentos pelo áudio');
    const teasers = await buildTeaser(analysis, plan, await styleFor(plan.styleId));
    const latest = (await project(p.id)).plan ?? plan;
    // Mantém a música já escolhida nas vinhetas anteriores.
    const keep = (id: string) => latest.videos.find((v) => v.id === id);
    await savePlan(p.dir, {
      ...latest,
      videos: [
        ...latest.videos.filter((v) => v.kind !== 'teaser'),
        ...teasers.map((t) => ({...t, music: keep(t.id)?.music, musicVolume: keep(t.id)?.musicVolume, musicNote: keep(t.id)?.musicNote})),
      ],
    });
    return null;
  }));
}));

app.post('/api/projects/:id/music', wrap(async (req, res) => {
  const p = await project(req.params.id);
  const video = p.plan?.videos.find((v) => v.id === req.body?.videoId);
  if (!p.analysis || !p.plan || !video) throw new Error('Vídeo do plano não encontrado.');
  if (!musicProvider()) throw new Error('Nenhum gerador de música configurado: coloque GEMINI_API_KEY ou ELEVENLABS_API_KEY no .env.');
  const {analysis, plan} = p;
  const mode = req.body?.mode === 'describe' ? 'describe' : 'auto';
  res.json(startJob(async (progress) => {
    const style = await styleFor(plan.styleId);
    const result = await generateMusic(analysis, plan, video, style, mode, String(req.body?.description ?? ''), progress);
    // Já deixa a música escolhida no vídeo.
    const latest = (await project(p.id)).plan ?? plan;
    await savePlan(p.dir, {
      ...latest,
      videos: latest.videos.map((v) => (v.id === video.id ? {...v, music: result.file, musicNote: result.resumo} : v)),
    });
    return result;
  }));
}));

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (job) res.json(job);
  else res.status(404).json({error: 'Tarefa não encontrada.'});
});

// Versão instalada: serve a tela compilada (npm run build:web) na mesma porta da API.
const webDir = path.resolve('dist/web');
if (existsSync(path.join(webDir, 'index.html'))) {
  app.use(express.static(webDir));
  app.get(/^\/(?!api\/|media\/|music\/).*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
}

// Um erro inesperado em segundo plano não deve derrubar o AutoCut inteiro.
process.on('unhandledRejection', (e) => console.error('Erro em segundo plano:', e instanceof Error ? e.message : e));

const appUrl = `http://127.0.0.1:${config.port}`;
const openBrowser = () => {
  if (process.env.AUTOCUT_OPEN_BROWSER !== '1') return;
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', appUrl]]
    : process.platform === 'darwin' ? ['open', [appUrl]] : ['xdg-open', [appUrl]];
  spawn(cmd, args as string[], {detached: true, stdio: 'ignore', windowsHide: true}).unref();
};

// Só escuta neste computador: outras máquinas da rede não acessam a tela nem as chaves.
const server = app.listen(config.port, process.env.HOST || '127.0.0.1', () => {
  cleanTmp();
  console.log(`AutoCut — servidor em ${appUrl}`);
  console.log(`Vídeos brutos:  ${config.videosDir}`);
  console.log(`Vídeos prontos: ${config.outputDir}`);
  console.log(config.apiKey ? `Modelo: ${config.model}` : 'Sem ANTHROPIC_API_KEY: planos montados só pelo áudio.');
  if (existsSync(path.join(webDir, 'index.html'))) console.log(`\nAbra ${appUrl} no navegador. Feche esta janela para encerrar o AutoCut.`);
  openBrowser();
});
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    // Já está aberto em outra janela: só mostra a tela.
    console.log(`O AutoCut já está rodando em ${appUrl}.`);
    openBrowser();
    setTimeout(() => process.exit(0), 1500);
  } else {
    throw e;
  }
});
