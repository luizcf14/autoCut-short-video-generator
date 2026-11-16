import React, {useEffect, useState} from 'react';

type FolderInfo = {path: string; exists: boolean; freeGB: number | null};
type SettingsData = {
  values: Record<string, string>;
  folders: Record<string, FolderInfo>;
  defaultModel: string;
  envFile: string;
};
type Model = {id: string; name: string};

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

const SECRETS = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY'] as const;

/** Campo de chave: mostra só o final da chave salva; digitar substitui. */
const KeyField: React.FC<{
  label: string;
  name: string;
  saved: string;
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  cleared: boolean;
  help: React.ReactNode;
  test: () => Promise<void>;
  testing: boolean;
  result?: {ok: boolean; message: string};
}> = ({label, name, saved, value, onChange, onClear, cleared, help, test, testing, result}) => (
  <div className="field">
    <label htmlFor={name}>{label}</label>
    <div className="row">
      <input
        id={name}
        className="grow"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={cleared ? 'Será apagada ao salvar' : saved ? `Configurada (${saved}). Digite para trocar.` : 'Cole a chave aqui'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button className="small" disabled={testing || (!value && (!saved || cleared))} onClick={() => void test()}>
        {testing ? 'Testando…' : 'Testar'}
      </button>
      {saved && !cleared ? <button className="small" title="Apagar a chave salva" onClick={onClear}>Remover</button> : null}
    </div>
    {result ? <div className={result.ok ? 'ok' : 'error'}>{result.message}</div> : null}
    <div className="hint">{help}</div>
  </div>
);

export const Settings: React.FC<{onClose: () => void; onSaved: () => void}> = ({onClose, onSaved}) => {
  const [data, setData] = useState<SettingsData | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<string[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [testing, setTesting] = useState('');
  const [results, setResults] = useState<Record<string, {ok: boolean; message: string}>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const d = await api<SettingsData>('/api/settings');
    setData(d);
    // Chaves começam vazias no formulário (nunca recebemos a chave inteira).
    setForm(Object.fromEntries(Object.entries(d.values).map(([k, v]) => [k, SECRETS.includes(k as never) ? '' : v])));
    setClear([]);
  };

  useEffect(() => {
    load().catch((e) => setError(String(e.message)));
    // Lista de modelos, se já houver chave salva.
    api<{models: Model[]}>('/api/settings/test', 'POST', {service: 'anthropic'})
      .then((r) => setModels(r.models))
      .catch(() => undefined);
  }, []);

  if (!data) return <section><p className="dim">{error || 'Carregando configurações…'}</p></section>;

  const set = (k: string, v: string) => setForm((f) => ({...f, [k]: v}));
  const test = async (service: string, key: string) => {
    setTesting(service);
    try {
      const r = await api<{ok: boolean; message: string; models?: Model[]}>('/api/settings/test', 'POST', {service, key: form[key]});
      setResults((x) => ({...x, [service]: r}));
      if (r.models) setModels(r.models);
    } catch (e) {
      setResults((x) => ({...x, [service]: {ok: false, message: e instanceof Error ? e.message : String(e)}}));
    } finally {
      setTesting('');
    }
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const r = await api<{changed: string[]; warnings: string[]}>('/api/settings', 'PUT', {values: form, clear});
      await load();
      setResults({});
      setNotice(r.changed.length ? `Configurações salvas.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}` : 'Nada mudou.');
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const currentModel = form.CLAUDE_MODEL || data.defaultModel;
  const modelOptions = models.some((m) => m.id === currentModel) ? models : [{id: currentModel, name: currentModel}, ...models];
  const folder = (k: string, label: string, hint: string, placeholder: string) => {
    const f = data.folders[k];
    return (
      <div className="field">
        <label htmlFor={k}>{label}</label>
        <input id={k} value={form[k] ?? ''} placeholder={placeholder} spellCheck={false} onChange={(e) => set(k, e.target.value)} />
        <div className="hint">
          Em uso: {f.path}
          {f.freeGB !== null ? <> · <span className={f.freeGB < 10 ? 'warn' : ''}>{f.freeGB} GB livres no disco</span></> : null}
          {!f.exists ? ' · ainda não existe' : ''}. {hint}
        </div>
      </div>
    );
  };

  return (
    <section className="settings">
      <div className="row">
        <h2 style={{margin: 0}}>Configurações</h2>
        <span className="grow" />
        <button onClick={onClose}>Voltar</button>
        <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar'}</button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="ok">{notice}</div> : null}

      <h3>Claude (cortes, textos e setas)</h3>
      <KeyField
        label="Chave da API da Anthropic"
        name="ANTHROPIC_API_KEY"
        saved={data.values.ANTHROPIC_API_KEY}
        value={form.ANTHROPIC_API_KEY ?? ''}
        onChange={(v) => set('ANTHROPIC_API_KEY', v)}
        cleared={clear.includes('ANTHROPIC_API_KEY')}
        onClear={() => setClear((c) => [...c, 'ANTHROPIC_API_KEY'])}
        test={() => test('anthropic', 'ANTHROPIC_API_KEY')}
        testing={testing === 'anthropic'}
        result={results.anthropic}
        help={<>Crie em <b>platform.claude.com</b> → API Keys. O uso é cobrado à parte da assinatura do Claude. Sem chave, os cortes são montados só pelo áudio.</>}
      />
      <div className="field">
        <label htmlFor="CLAUDE_MODEL">Modelo</label>
        <select id="CLAUDE_MODEL" value={currentModel} onChange={(e) => set('CLAUDE_MODEL', e.target.value === data.defaultModel ? '' : e.target.value)}>
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} (${m.id})`}{m.id === data.defaultModel ? ' · padrão' : ''}</option>
          ))}
        </select>
        <div className="hint">
          {models.length ? 'Lista dos modelos liberados para a sua chave.' : 'Clique em "Testar" na chave para carregar a lista de modelos.'}{' '}
          Modelos maiores escolhem melhor os cortes e custam mais por vídeo.
        </div>
      </div>

      <h3>Música gerada por IA (opcional)</h3>
      <KeyField
        label="Chave do Google Gemini (Lyria)"
        name="GEMINI_API_KEY"
        saved={data.values.GEMINI_API_KEY}
        value={form.GEMINI_API_KEY ?? ''}
        onChange={(v) => set('GEMINI_API_KEY', v)}
        cleared={clear.includes('GEMINI_API_KEY')}
        onClear={() => setClear((c) => [...c, 'GEMINI_API_KEY'])}
        test={() => test('gemini', 'GEMINI_API_KEY')}
        testing={testing === 'gemini'}
        result={results.gemini}
        help={<>Crie em <b>aistudio.google.com/apikey</b>. A geração de música é cobrada pelo Google.</>}
      />
      <KeyField
        label="Chave da ElevenLabs"
        name="ELEVENLABS_API_KEY"
        saved={data.values.ELEVENLABS_API_KEY}
        value={form.ELEVENLABS_API_KEY ?? ''}
        onChange={(v) => set('ELEVENLABS_API_KEY', v)}
        cleared={clear.includes('ELEVENLABS_API_KEY')}
        onClear={() => setClear((c) => [...c, 'ELEVENLABS_API_KEY'])}
        test={() => test('elevenlabs', 'ELEVENLABS_API_KEY')}
        testing={testing === 'elevenlabs'}
        result={results.elevenlabs}
        help={<>Alternativa ao Gemini. Precisa de plano pago em <b>elevenlabs.io</b>.</>}
      />
      <div className="field">
        <label htmlFor="MUSIC_PROVIDER">Gerador de música preferido</label>
        <select id="MUSIC_PROVIDER" value={form.MUSIC_PROVIDER ?? ''} onChange={(e) => set('MUSIC_PROVIDER', e.target.value)}>
          <option value="">Automático (o que tiver chave)</option>
          <option value="gemini">Google Lyria</option>
          <option value="elevenlabs">ElevenLabs</option>
        </select>
      </div>

      <h3>Pastas</h3>
      {folder('VIDEOS_DIR', 'Vídeos brutos', 'A pasta precisa existir.', 'Padrão: a pasta "videos" do AutoCut')}
      {folder('OUTPUT_DIR', 'Vídeos prontos', '', 'Padrão: "prontos" dentro da pasta de vídeos')}
      {folder('WORK_DIR', 'Arquivos de trabalho', 'Precisa de cerca de 1/3 do tamanho de cada vídeo bruto; use um disco com espaço.', 'Padrão: a pasta "work" do AutoCut')}
      {folder('MUSIC_DIR', 'Músicas de fundo', '', 'Padrão: "musicas" dentro da pasta de vídeos')}

      <h3>Canal e desempenho</h3>
      <div className="field">
        <label htmlFor="CHANNEL_NAME">Nome do canal (quando o estilo não define um)</label>
        <input id="CHANNEL_NAME" value={form.CHANNEL_NAME ?? ''} onChange={(e) => set('CHANNEL_NAME', e.target.value)} />
      </div>
      <div className="grid2">
        <div className="field">
          <label><input type="checkbox" checked={form.RENDER_NVENC === '1'} onChange={(e) => set('RENDER_NVENC', e.target.checked ? '1' : '')} /> Codificar com placa NVIDIA (NVENC)</label>
          <div className="hint">Mais rápido com placas GeForce/RTX. Se a placa falhar, o AutoCut volta ao processador sozinho.</div>
        </div>
        <div className="field">
          <label><input type="checkbox" checked={form.RENDER_GL === 'angle'} onChange={(e) => set('RENDER_GL', e.target.checked ? 'angle' : '')} /> Desenhar os quadros com a placa de vídeo</label>
          <div className="hint">Ajuda nos Shorts com fundo desfocado. Desligue se a exportação falhar.</div>
        </div>
        <div className="field">
          <label htmlFor="RENDER_CONCURRENCY">Núcleos do processador na exportação</label>
          <select id="RENDER_CONCURRENCY" value={form.RENDER_CONCURRENCY ?? ''} onChange={(e) => set('RENDER_CONCURRENCY', e.target.value)}>
            <option value="">Padrão (metade)</option>
            <option value="50%">50%</option>
            <option value="75%">75%</option>
            <option value="100%">100% (o computador fica lento)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="MAX_FRAMES">Quadros enviados ao Claude por vídeo</label>
          <input id="MAX_FRAMES" type="number" min={16} max={150} placeholder="48" value={form.MAX_FRAMES ?? ''} onChange={(e) => set('MAX_FRAMES', e.target.value)} />
          <div className="hint">Mais quadros, cortes melhores e custo maior. Vale ao analisar de novo.</div>
        </div>
      </div>

      <p className="hint">
        As configurações ficam no arquivo {data.envFile}, só neste computador. As chaves nunca aparecem inteiras nesta tela.
      </p>
      <div className="row">
        <span className="grow" />
        <button onClick={onClose}>Voltar</button>
        <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar'}</button>
      </div>
    </section>
  );
};
