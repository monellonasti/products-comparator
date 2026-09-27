import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { FeedSchedule, FeedView } from '../types';
import { ErrorNotice, Notice } from './ui';
import { ChangeCounters } from './changes';
import { dateTime } from '../format';
import { RunStatus } from '../pages/ImportsPage';

type AuthType = FeedView['authType'];

const STATUS_TEXT: Record<NonNullable<FeedView['lastStatus']>, string> = {
  queued: 'scaricato e avviato l’import',
  failed: 'non riuscito',
  postponed: 'rinviato (import già in corso)',
  no_mapping: 'in attesa della mappatura delle colonne',
};

/** Scheduled feed configuration for a supplier. Secrets are write-only: the form never shows them. */
export function FeedCard({ supplierId, feed, isAdmin }: { supplierId: string; feed: FeedView; isAdmin: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(!feed.configured && isAdmin);
  const [enabled, setEnabled] = useState(feed.configured ? feed.enabled : true);
  const [url, setUrl] = useState('');
  const [authType, setAuthType] = useState<AuthType>(feed.authType);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [headerName, setHeaderName] = useState(feed.headerName ?? '');
  const [headerValue, setHeaderValue] = useState('');
  const [schedule, setSchedule] = useState<FeedSchedule>(feed.schedule);
  const [mode, setMode] = useState(feed.mode);
  const [testResult, setTestResult] = useState<any>(null);

  useEffect(() => {
    setAuthType(feed.authType);
    setSchedule(feed.schedule);
    setMode(feed.mode);
  }, [feed]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['supplier', supplierId] });
    void qc.invalidateQueries({ queryKey: ['suppliers'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api.put<{ feed: FeedView }>(`/api/suppliers/${supplierId}/feed`, {
        enabled,
        url: url || undefined,
        auth: {
          type: authType,
          username: username || undefined,
          password: password || undefined,
          token: token || undefined,
          headerName: authType === 'header' ? headerName : undefined,
          headerValue: headerValue || undefined,
        },
        schedule,
        mode,
      }),
    onSuccess: () => {
      setEditing(false);
      setUrl('');
      setPassword('');
      setToken('');
      setHeaderValue('');
      refresh();
    },
  });
  const test = useMutation({ mutationFn: () => api.post<any>(`/api/suppliers/${supplierId}/feed/test`), onSuccess: setTestResult });
  const run = useMutation({ mutationFn: () => api.post(`/api/suppliers/${supplierId}/feed/run`), onSuccess: () => setTimeout(refresh, 1500) });
  const sample = useMutation({
    mutationFn: () => api.post<any>(`/api/suppliers/${supplierId}/feed/sample`),
    onSuccess: (inspect) => navigate('/importazioni/nuova', { state: { inspect } }),
  });

  const secretHint = (set: boolean | undefined) => (set ? 'impostato: lascia vuoto per non cambiarlo' : '');

  return (
    <section className="card" aria-labelledby="feed-title">
      <div className="card-title">
        <h2 id="feed-title">Aggiornamento automatico (feed)</h2>
        {feed.configured && (
          <span className={`badge ${feed.enabled ? 'badge-ok' : 'badge-neutral'}`}>{feed.enabled ? `Attivo · ${feed.scheduleText}` : 'Disattivato'}</span>
        )}
      </div>

      {!feed.secretsKeyConfigured && (
        <Notice kind="warning">
          Per salvare l’indirizzo e le credenziali dei feed il server deve avere la chiave di cifratura <code>SECRETS_KEY</code> (vedi docs/OPERATIONS.md).
        </Notice>
      )}

      {feed.configured && !editing && (
        <div className="stack">
          <dl className="kv">
            <dt>Indirizzo</dt>
            <dd className="mono small">{feed.urlDisplay}</dd>
            <dt>Accesso</dt>
            <dd>{{ none: 'nessuna autenticazione', basic: 'utente e password', bearer: 'token (Bearer)', header: `header ${feed.headerName}` }[feed.authType]}</dd>
            <dt>Tipo di file</dt>
            <dd>{feed.mode === 'snapshot' ? 'listino completo (le offerte assenti escono dal listino)' : 'aggiornamento parziale'}</dd>
            <dt>Prossima esecuzione</dt>
            <dd>{feed.enabled ? dateTime(feed.nextRunAt) : '—'}</dd>
            <dt>Ultimo controllo</dt>
            <dd>
              {dateTime(feed.lastCheckedAt)}
              {feed.lastStatus && ` · ${STATUS_TEXT[feed.lastStatus]}`}
            </dd>
            {feed.lastRun && (
              <>
                <dt>Ultimo import dal feed</dt>
                <dd>
                  <Link to={`/importazioni/${feed.lastRun.id}`}>{dateTime(feed.lastRun.created_at)}</Link> <RunStatus status={feed.lastRun.status as any} />
                  <div style={{ marginTop: 4 }}>
                    <ChangeCounters counters={feed.lastRun.counters ?? {}} />
                  </div>
                </dd>
              </>
            )}
          </dl>
          {feed.lastStatus === 'failed' && feed.lastError && <Notice kind="danger">{feed.lastError}</Notice>}
          {feed.lastStatus === 'no_mapping' && (
            <Notice kind="warning">Il feed non ha ancora una mappatura delle colonne: usa “Configura mappatura dal feed”.</Notice>
          )}
          {feed.lastRun?.status === 'failed' && feed.lastRun.error && <Notice kind="danger">Import fallito: {feed.lastRun.error}</Notice>}
          {isAdmin && (
            <div className="row">
              <button className="btn" onClick={() => setEditing(true)}>Modifica</button>
              <button className="btn" onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? 'Prova in corso…' : 'Prova connessione'}</button>
              <button className="btn" onClick={() => sample.mutate()} disabled={sample.isPending}>{sample.isPending ? 'Scaricamento…' : 'Configura mappatura dal feed'}</button>
              <button className="btn btn-primary" onClick={() => run.mutate()} disabled={run.isPending}>Aggiorna ora</button>
              {run.isSuccess && <span className="small muted">Aggiornamento avviato: il risultato compare tra le importazioni.</span>}
            </div>
          )}
        </div>
      )}

      {!feed.configured && !isAdmin && <p className="muted">Nessun feed: il listino viene caricato a mano.</p>}

      {editing && isAdmin && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <p className="muted small" style={{ margin: 0 }}>
            Il file (CSV o XLSX) viene scaricato all’orario indicato e importato con la mappatura delle colonne salvata per questo fornitore. Le variazioni di prezzi,
            disponibilità e immagini compaiono in Importazioni › Variazioni.
          </p>
          <label className="checkbox">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Aggiornamento automatico attivo
          </label>
          <div className="field">
            <label htmlFor="feed-url">
              Indirizzo del listino {feed.secretsSet?.url && <span className="field-hint">attuale: {feed.urlDisplay} — lascia vuoto per non cambiarlo</span>}
            </label>
            <input id="feed-url" className="input mono" type="url" autoComplete="off" placeholder="https://fornitore.it/export/listino.csv?key=…" value={url} onChange={(e) => setUrl(e.target.value)} />
            <span className="field-hint">L’indirizzo viene salvato cifrato perché spesso contiene un codice di accesso.</span>
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="feed-auth">Autenticazione</label>
              <select id="feed-auth" className="input" value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
                <option value="none">Nessuna (o codice nell’indirizzo)</option>
                <option value="basic">Utente e password</option>
                <option value="bearer">Token (Bearer)</option>
                <option value="header">Header personalizzato</option>
              </select>
            </div>
            {authType === 'basic' && (
              <>
                <div className="field">
                  <label htmlFor="feed-user">Utente</label>
                  <input id="feed-user" className="input" autoComplete="off" placeholder={secretHint(feed.secretsSet?.username)} value={username} onChange={(e) => setUsername(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="feed-pw">Password</label>
                  <input id="feed-pw" className="input" type="password" autoComplete="new-password" placeholder={secretHint(feed.secretsSet?.password)} value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
              </>
            )}
            {authType === 'bearer' && (
              <div className="field">
                <label htmlFor="feed-token">Token</label>
                <input id="feed-token" className="input" type="password" autoComplete="off" placeholder={secretHint(feed.secretsSet?.token)} value={token} onChange={(e) => setToken(e.target.value)} />
              </div>
            )}
            {authType === 'header' && (
              <>
                <div className="field">
                  <label htmlFor="feed-hn">Nome header</label>
                  <input id="feed-hn" className="input mono" placeholder="X-Api-Key" value={headerName} onChange={(e) => setHeaderName(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="feed-hv">Valore</label>
                  <input id="feed-hv" className="input" type="password" autoComplete="off" placeholder={secretHint(feed.secretsSet?.header_value)} value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} />
                </div>
              </>
            )}
          </div>
          {authType !== 'none' && <span className="field-hint">Le credenziali vengono inviate solo in HTTPS e solo all’indirizzo configurato.</span>}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="feed-freq">Frequenza</label>
              <select
                id="feed-freq"
                className="input"
                value={schedule.kind}
                onChange={(e) =>
                  setSchedule(e.target.value === 'daily' ? { kind: 'daily', time: '06:00', timezone: 'Europe/Rome' } : { kind: 'hourly', everyHours: 6 })
                }
              >
                <option value="daily">Una volta al giorno</option>
                <option value="hourly">Ogni N ore</option>
              </select>
            </div>
            {schedule.kind === 'daily' ? (
              <div className="field">
                <label htmlFor="feed-time">Orario (ora italiana)</label>
                <input id="feed-time" className="input" type="time" value={schedule.time} onChange={(e) => setSchedule({ ...schedule, time: e.target.value })} />
              </div>
            ) : (
              <div className="field">
                <label htmlFor="feed-hours">Ogni quante ore</label>
                <input id="feed-hours" className="input" type="number" min={1} max={24} value={schedule.everyHours} onChange={(e) => setSchedule({ kind: 'hourly', everyHours: Number(e.target.value) })} />
              </div>
            )}
            <div className="field">
              <label htmlFor="feed-mode">Il file contiene</label>
              <select id="feed-mode" className="input" value={mode} onChange={(e) => setMode(e.target.value as FeedView['mode'])}>
                <option value="snapshot">Tutto il listino (le offerte assenti escono dal listino)</option>
                <option value="delta">Solo una parte (non toglie nulla)</option>
              </select>
            </div>
          </div>
          <ErrorNotice error={save.error} />
          <div className="row">
            {feed.configured && <button type="button" className="btn" onClick={() => setEditing(false)}>Annulla</button>}
            <button type="submit" className="btn btn-primary" disabled={save.isPending || !feed.secretsKeyConfigured}>Salva</button>
          </div>
        </form>
      )}

      <ErrorNotice error={test.error ?? sample.error ?? run.error} />
      {testResult && (
        <Notice kind={testResult.missingMappedColumns?.length ? 'warning' : 'success'}>
          Connessione riuscita: {testResult.fileKind.toUpperCase()} di {(testResult.bytes / 1024).toFixed(0)} KB scaricato in {testResult.downloadMs} ms, {testResult.headers.length} colonne.
          {!testResult.hasMapping && ' Manca la mappatura delle colonne.'}
          {testResult.missingMappedColumns?.length > 0 && ` Colonne mappate non più presenti nel file: ${testResult.missingMappedColumns.join(', ')}.`}
        </Notice>
      )}
    </section>
  );
}
