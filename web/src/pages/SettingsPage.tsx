import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorNotice, Modal, Notice, Spinner, useDocumentTitle } from '../components/ui';
import { dateTime, parseDecimalInput } from '../format';

type TabKey = 'users' | 'categories' | 'system';
const TABS: Array<{ key: TabKey; label: string; adminOnly: boolean }> = [
  { key: 'users', label: 'Utenti', adminOnly: true },
  { key: 'categories', label: 'Categorie', adminOnly: false },
  { key: 'system', label: 'Stato del sistema', adminOnly: true },
];

export default function SettingsPage() {
  useDocumentTitle('Impostazioni');
  const { isAdmin, user } = useAuth();
  const [tab, setTab] = useState<TabKey>(isAdmin ? 'users' : 'categories');
  const tabs = TABS.filter((t) => isAdmin || !t.adminOnly);
  // WAI-ARIA tabs: one tab in the Tab order, arrows (and Home/End) move between tabs.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.key === tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    setTab(t.key);
    document.getElementById(`tab-${t.key}`)?.focus();
  };
  return (
    <div className="page page-narrow">
      <div className="page-header"><div><h1>Impostazioni</h1><p>Connesso come {user?.email}.</p></div></div>
      <div className="tabs" role="tablist" aria-label="Sezioni delle impostazioni" onKeyDown={onKeyDown}>
        {tabs.map((t) => (
          <button key={t.key} id={`tab-${t.key}`} role="tab" aria-selected={tab === t.key} aria-controls={`panel-${t.key}`} tabIndex={tab === t.key ? 0 : -1} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'users' && isAdmin && <Users />}
        {tab === 'categories' && <Categories />}
        {tab === 'system' && isAdmin && <SystemStatus />}
      </div>
    </div>
  );
}

function Users() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ items: any[] }>('/api/users') });
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ email: '', displayName: '', role: 'operator', password: '' });
  const create = useMutation({
    mutationFn: () => api.post('/api/users', f),
    onSuccess: () => {
      setCreating(false);
      setF({ email: '', displayName: '', role: 'operator', password: '' });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
  const update = useMutation({ mutationFn: (b: { id: string } & Record<string, unknown>) => api.patch(`/api/users/${b.id}`, b), onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }) });
  if (q.isLoading) return <Spinner />;
  return (
    <div className="stack">
      <div className="row"><span className="muted small">Operatore: consulta catalogo, cerca, segnala. Amministratore: anche fornitori, import, corrispondenze e utenti.</span><span className="spacer" /><button className="btn btn-primary" onClick={() => setCreating(true)}>Nuovo utente</button></div>
      <ErrorNotice error={q.error ?? update.error} />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Nome</th><th>Email</th><th>Ruolo</th><th>Ultimo accesso</th><th>Stato</th></tr></thead>
          <tbody>
            {q.data?.items.map((u) => (
              <tr key={u.id} className={u.active ? undefined : 'inactive'}>
                <td>{u.display_name}</td>
                <td>{u.email}</td>
                <td>
                  <select className="input" aria-label={`Ruolo di ${u.display_name}`} value={u.role} onChange={(e) => update.mutate({ id: u.id, role: e.target.value })}>
                    <option value="operator">Operatore</option>
                    <option value="admin">Amministratore</option>
                  </select>
                </td>
                <td>{dateTime(u.last_login_at)}</td>
                <td><button className="btn btn-sm" onClick={() => update.mutate({ id: u.id, active: !u.active })}>{u.active ? 'Disattiva' : 'Riattiva'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal open={creating} onClose={() => setCreating(false)} title="Nuovo utente" footer={<><button className="btn" onClick={() => setCreating(false)}>Annulla</button><button className="btn btn-primary" onClick={() => create.mutate()} disabled={create.isPending}>Crea</button></>}>
        <div className="form-grid">
          <div className="field"><label htmlFor="u-name">Nome</label><input id="u-name" className="input" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></div>
          <div className="field"><label htmlFor="u-email">Email</label><input id="u-email" className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="field"><label htmlFor="u-role">Ruolo</label><select id="u-role" className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="operator">Operatore</option><option value="admin">Amministratore</option></select></div>
          <div className="field"><label htmlFor="u-pw">Password iniziale <span className="field-hint">almeno 12 caratteri</span></label><input id="u-pw" className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
        </div>
        <ErrorNotice error={create.error} />
      </Modal>
    </div>
  );
}

function Categories() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['categories'], queryFn: () => api.get<{ items: Array<{ id: string; name: string }> }>('/api/categories') });
  const [name, setName] = useState('');
  const create = useMutation({ mutationFn: () => api.post('/api/categories', { name }), onSuccess: () => { setName(''); void qc.invalidateQueries({ queryKey: ['categories'] }); } });
  return (
    <div className="card stack">
      <p className="muted small" style={{ margin: 0 }}>Categorie normalizzate usate nei filtri. Le categorie di ciascun fornitore si associano dalla pagina del fornitore.</p>
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorNotice error={q.error} /> : q.data!.items.length === 0 ? (
        <p className="muted">Nessuna categoria.</p>
      ) : (
        <ul>{q.data!.items.map((c) => <li key={c.id}>{c.name}</li>)}</ul>
      )}
      {isAdmin && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !create.isPending) create.mutate(); }}>
          <input className="input" style={{ maxWidth: 320 }} aria-label="Nuova categoria" placeholder="Nuova categoria" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn" type="submit" disabled={!name.trim() || create.isPending}>{create.isPending ? 'Aggiunta…' : 'Aggiungi'}</button>
        </form>
      )}
      <ErrorNotice error={create.error} />
    </div>
  );
}

const ENGINE_STATE: Record<string, string> = { idle: 'non ancora caricato', loading: 'in caricamento', ready: 'pronto', failed: 'errore' };
const IMAGE_STATUS: Record<string, string> = { pending: 'in attesa', fetched: 'scaricate', failed: 'non scaricabili', blocked: 'bloccate' };
const IMPORT_STATUS: Record<string, string> = { succeeded: 'ultimo aggiornamento riuscito', failed: 'ultimo aggiornamento fallito', running: 'aggiornamento in corso' };
const VERDICT: Record<string, string> = {
  correct: 'È questo', wrong: 'Non è questo', useful_alternative: 'Alternativa utile', none_relevant: 'Nessun risultato pertinente',
};

function SystemStatus() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-status'], queryFn: () => api.get<any>('/api/admin/status'), refetchInterval: 10_000 });
  const retry = useMutation({ mutationFn: (includeBlocked: boolean) => api.post<{ requeued: number }>('/api/admin/images/retry-failed', { includeBlocked }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-status'] }) });
  const [th, setTh] = useState<{ possible: string; similar: string; calibrated: boolean } | null>(null);
  // "0,85" typed the Italian way is a valid threshold; anything else is refused before sending.
  const thPossible = th ? parseDecimalInput(th.possible) : null;
  const thSimilar = th ? parseDecimalInput(th.similar) : null;
  const thValid = !!thPossible && !!thSimilar;
  const saveTh = useMutation({
    mutationFn: () => api.patch('/api/admin/vision/thresholds', { possible: Number(thPossible), similar: Number(thSimilar), calibrated: th!.calibrated }),
    onSuccess: () => { setTh(null); void qc.invalidateQueries({ queryKey: ['admin-status'] }); },
  });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorNotice error={q.error} />;
  const s = q.data;
  const v = s.vision;
  return (
    <div className="stack">
      <div className="card">
        <h2>Ricerca visiva</h2>
        {!v.enabled && <Notice kind="warning">Ricerca visiva disattivata (VISION_ENABLED=false).</Notice>}
        {v.embedder?.state === 'failed' && <Notice kind="danger">Modello non caricato: {v.embedder.error}</Notice>}
        <dl className="kv">
          <dt>Modello attivo</dt><dd>{v.activeModel ? <>{v.activeModel.label} <span className="mono small">{v.activeModel.key}</span></> : '—'}</dd>
          <dt>Licenza</dt><dd>{v.activeModel?.license ?? '—'}</dd>
          <dt>Stato motore</dt><dd>{v.embedder ? ENGINE_STATE[v.embedder.state] ?? v.embedder.state : '—'}{v.embedder?.loadMs ? ` (caricato in ${v.embedder.loadMs} ms)` : ''}</dd>
          <dt>Copertura indice</dt><dd>{v.coverage ? `${v.coverage.indexed.toLocaleString('it-IT')} / ${v.coverage.assets.toLocaleString('it-IT')} immagini · ${v.coverage.pending} in attesa · ${v.coverage.failed} fallite` : '—'}</dd>
          <dt>Soglie</dt>
          <dd>
            {v.activeModel ? (
              <>
                possibile ≥ {v.activeModel.thresholds.possible} · simile ≥ {v.activeModel.thresholds.similar} · {v.activeModel.thresholds.calibrated ? 'calibrate' : <span className="badge badge-warn">non calibrate su dati reali</span>}{' '}
                <button className="btn btn-sm" onClick={() => setTh({ possible: String(v.activeModel.thresholds.possible).replace('.', ','), similar: String(v.activeModel.thresholds.similar).replace('.', ','), calibrated: !!v.activeModel.thresholds.calibrated })}>Modifica</button>
              </>
            ) : (
              '—'
            )}
          </dd>
          <dt>Ricerche (7 giorni)</dt><dd>{s.photoSearches.total} · non riuscite {s.photoSearches.failed} · p95 server {s.photoSearches.p95_ms ? `${Math.round(s.photoSearches.p95_ms)} ms` : '—'}</dd>
          <dt>Segnalazioni</dt><dd>{s.feedback.map((f: any) => `${VERDICT[f.verdict] ?? f.verdict}: ${f.n}`).join(' · ') || 'nessuna'}</dd>
        </dl>
        {th && (
          <div className="row" style={{ marginTop: 12 }}>
            <label className="field">Possibile ≥ <input className="input" inputMode="decimal" aria-invalid={thPossible === null || undefined} value={th.possible} onChange={(e) => setTh({ ...th, possible: e.target.value })} /></label>
            <label className="field">Simile ≥ <input className="input" inputMode="decimal" aria-invalid={thSimilar === null || undefined} value={th.similar} onChange={(e) => setTh({ ...th, similar: e.target.value })} /></label>
            <label className="checkbox"><input type="checkbox" checked={th.calibrated} onChange={(e) => setTh({ ...th, calibrated: e.target.checked })} /> calibrate su un benchmark reale</label>
            <button className="btn btn-primary" disabled={!thValid || saveTh.isPending} onClick={() => saveTh.mutate()}>{saveTh.isPending ? 'Salvataggio…' : 'Salva'}</button>
            <button className="btn" onClick={() => setTh(null)}>Annulla</button>
            {!thValid && <span className="error-text small">Soglie tra 0 e 1, ad esempio 0,85</span>}
          </div>
        )}
        <ErrorNotice error={saveTh.error} />
      </div>
      <div className="card">
        <h2>Code di lavoro</h2>
        {s.queue.length === 0 ? <p className="muted">Nessun job in coda.</p> : (
          <ul>{s.queue.map((j: any) => <li key={j.task}>{j.task}: {j.jobs} ({j.running} in esecuzione, {j.with_errors} con errori in attesa di retry)</li>)}</ul>
        )}
        <p className="small muted">Immagini: {Object.entries(s.images).map(([k, n]) => `${IMAGE_STATUS[k] ?? k} ${n}`).join(' · ')}</p>
        <div className="row">
          <button className="btn" onClick={() => retry.mutate(false)} disabled={retry.isPending}>Riprova immagini ed embedding falliti</button>
          <button className="btn btn-ghost" onClick={() => retry.mutate(true)} disabled={retry.isPending}>Riprova anche quelli bloccati (host non autorizzati)</button>
          {retry.data && <span className="small">{retry.data.requeued} rimessi in coda</span>}
        </div>
        {s.imageFailures.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary>Ultimi download falliti ({s.imageFailures.length})</summary>
            <ul className="small">{s.imageFailures.map((f: any) => <li key={f.id}><span className="mono">{f.url}</span> — {f.last_error} ({f.attempts} tentativi)</li>)}</ul>
          </details>
        )}
      </div>
      <div className="card">
        <h2>Aggiornamento dei fornitori</h2>
        <ul>{s.suppliers.map((x: any) => <li key={x.id}>{x.name}: {x.last_import_status ? IMPORT_STATUS[x.last_import_status] ?? x.last_import_status : 'mai importato'} · dati al {dateTime(x.last_success_as_of)} {x.stale && <span className="badge badge-warn">non aggiornato</span>}</li>)}</ul>
      </div>
    </div>
  );
}
