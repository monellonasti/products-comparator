import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorNotice, Modal, Notice, Spinner, useDocumentTitle } from '../components/ui';
import { dateTime } from '../format';

export default function SettingsPage() {
  useDocumentTitle('Impostazioni');
  const { isAdmin, user } = useAuth();
  const [tab, setTab] = useState<'users' | 'categories' | 'system'>(isAdmin ? 'users' : 'categories');
  return (
    <div className="page page-narrow">
      <div className="page-header"><div><h1>Impostazioni</h1><p>Connesso come {user?.email}.</p></div></div>
      <div className="tabs" role="tablist">
        {isAdmin && <button role="tab" aria-selected={tab === 'users'} onClick={() => setTab('users')}>Utenti</button>}
        <button role="tab" aria-selected={tab === 'categories'} onClick={() => setTab('categories')}>Categorie</button>
        {isAdmin && <button role="tab" aria-selected={tab === 'system'} onClick={() => setTab('system')}>Stato del sistema</button>}
      </div>
      {tab === 'users' && isAdmin && <Users />}
      {tab === 'categories' && <Categories />}
      {tab === 'system' && isAdmin && <SystemStatus />}
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
      <ul>{q.data?.items.map((c) => <li key={c.id}>{c.name}</li>)}</ul>
      {isAdmin && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
          <input className="input" style={{ maxWidth: 320 }} aria-label="Nuova categoria" placeholder="Nuova categoria" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn" type="submit">Aggiungi</button>
        </form>
      )}
      <ErrorNotice error={create.error} />
    </div>
  );
}

function SystemStatus() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-status'], queryFn: () => api.get<any>('/api/admin/status'), refetchInterval: 10_000 });
  const retry = useMutation({ mutationFn: (includeBlocked: boolean) => api.post<{ requeued: number }>('/api/admin/images/retry-failed', { includeBlocked }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-status'] }) });
  const [th, setTh] = useState<{ possible: string; similar: string; calibrated: boolean } | null>(null);
  const saveTh = useMutation({
    mutationFn: () => api.patch('/api/admin/vision/thresholds', { possible: Number(th!.possible), similar: Number(th!.similar), calibrated: th!.calibrated }),
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
          <dt>Stato motore</dt><dd>{v.embedder?.state ?? '—'}{v.embedder?.loadMs ? ` (caricato in ${v.embedder.loadMs} ms)` : ''}</dd>
          <dt>Copertura indice</dt><dd>{v.coverage ? `${v.coverage.indexed.toLocaleString('it-IT')} / ${v.coverage.assets.toLocaleString('it-IT')} immagini · ${v.coverage.pending} in attesa · ${v.coverage.failed} fallite` : '—'}</dd>
          <dt>Soglie</dt>
          <dd>
            possibile ≥ {v.activeModel?.thresholds.possible} · simile ≥ {v.activeModel?.thresholds.similar} · {v.activeModel?.thresholds.calibrated ? 'calibrate' : <span className="badge badge-warn">non calibrate su dati reali</span>}{' '}
            <button className="btn btn-sm" onClick={() => setTh({ possible: String(v.activeModel.thresholds.possible), similar: String(v.activeModel.thresholds.similar), calibrated: !!v.activeModel.thresholds.calibrated })}>Modifica</button>
          </dd>
          <dt>Ricerche (7 giorni)</dt><dd>{s.photoSearches.total} · non riuscite {s.photoSearches.failed} · p95 server {s.photoSearches.p95_ms ? `${Math.round(s.photoSearches.p95_ms)} ms` : '—'}</dd>
          <dt>Segnalazioni</dt><dd>{s.feedback.map((f: any) => `${f.verdict}: ${f.n}`).join(' · ') || 'nessuna'}</dd>
        </dl>
        {th && (
          <div className="row" style={{ marginTop: 12 }}>
            <label className="field">Possibile ≥ <input className="input" value={th.possible} onChange={(e) => setTh({ ...th, possible: e.target.value })} /></label>
            <label className="field">Simile ≥ <input className="input" value={th.similar} onChange={(e) => setTh({ ...th, similar: e.target.value })} /></label>
            <label className="checkbox"><input type="checkbox" checked={th.calibrated} onChange={(e) => setTh({ ...th, calibrated: e.target.checked })} /> calibrate su un benchmark reale</label>
            <button className="btn btn-primary" onClick={() => saveTh.mutate()}>Salva</button>
          </div>
        )}
        <ErrorNotice error={saveTh.error} />
      </div>
      <div className="card">
        <h2>Code di lavoro</h2>
        {s.queue.length === 0 ? <p className="muted">Nessun job in coda.</p> : (
          <ul>{s.queue.map((j: any) => <li key={j.task}>{j.task}: {j.jobs} ({j.running} in esecuzione, {j.with_errors} con errori in attesa di retry)</li>)}</ul>
        )}
        <p className="small muted">Immagini: {Object.entries(s.images).map(([k, n]) => `${k} ${n}`).join(' · ')}</p>
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
        <ul>{s.suppliers.map((x: any) => <li key={x.id}>{x.name}: {x.last_import_status ?? 'mai importato'} · dati al {dateTime(x.last_success_as_of)} {x.stale && <span className="badge badge-warn">non aggiornato</span>}</li>)}</ul>
      </div>
    </div>
  );
}
