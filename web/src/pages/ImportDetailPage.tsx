import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import type { ImportRun } from '../types';
import { ErrorNotice, Notice, Spinner, useDocumentTitle } from '../components/ui';
import { bytes, dateTime } from '../format';
import { RunStatus } from './ImportsPage';

const COUNTER_LABELS: Array<[string, string]> = [
  ['rows_total', 'Righe nel file'], ['rows_processed', 'Righe elaborate'], ['offers_created', 'Offerte nuove'], ['offers_updated', 'Offerte aggiornate'],
  ['offers_unchanged', 'Offerte invariate'], ['offers_skipped_outdated', 'Righe più vecchie dei dati presenti'], ['offers_reactivated', 'Offerte tornate a listino'],
  ['offers_relinked', 'Offerte spostate per cambio EAN'], ['offers_deactivated', 'Offerte non più a listino'], ['products_created', 'Prodotti nuovi'],
  ['conflicts_opened', 'Conflitti da verificare'], ['images_new', 'Nuove immagini da scaricare'], ['rows_error', 'Righe con errori'], ['rows_with_warnings', 'Righe con avvisi'],
];

export default function ImportDetailPage() {
  const { id } = useParams();
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [severity, setSeverity] = useState('');
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ['import', id],
    queryFn: () => api.get<{ run: ImportRun; issueSummary: Array<{ severity: string; code: string; message: string; count: number }>; images: { pending: number; fetched: number; failed: number } }>(`/api/imports/${id}`),
    refetchInterval: (query) => (['queued', 'running'].includes(query.state.data?.run.status ?? '') || (query.state.data?.images.pending ?? 0) > 0 ? 2500 : false),
  });
  const issues = useQuery({
    queryKey: ['import-issues', id, severity, offset],
    queryFn: () => api.get<{ items: Array<{ row_number: number; severity: string; field: string | null; code: string; message: string; value: string | null }>; total: number }>(`/api/imports/${id}/issues${qs({ severity, offset })}`),
  });
  const action = useMutation({
    mutationFn: (a: 'retry' | 'cancel') => api.post(`/api/imports/${id}/${a}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['import', id] });
      void qc.invalidateQueries({ queryKey: ['imports'] });
    },
  });
  useDocumentTitle('Dettaglio import');
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <div className="page"><ErrorNotice error={q.error} /></div>;
  const { run, issueSummary, images } = q.data!;
  const c = run.counters ?? {};
  const pct = run.stagedRows ? Math.min(100, Math.round(((c.rows_processed ?? 0) / run.stagedRows) * 100)) : 0;
  const stuck = run.status === 'running' && run.heartbeatAt && Date.now() - new Date(run.heartbeatAt).getTime() > 15 * 60_000;

  return (
    <div className="page">
      <nav className="small" style={{ marginBottom: 8 }}><Link to="/importazioni">Importazioni</Link> › {run.fileName}</nav>
      <div className="page-header">
        <div>
          <h1>{run.fileName}</h1>
          <p>
            <Link to={`/fornitori/${run.supplierId}`}>{run.supplierName}</Link> · <RunStatus status={run.status} /> · {run.mode === 'snapshot' ? 'listino completo' : 'aggiornamento parziale'} · dati al {dateTime(run.asOf)}
          </p>
        </div>
        {isAdmin && (
          <div className="row">
            {(run.status === 'failed' || stuck) && <button className="btn btn-primary" onClick={() => action.mutate('retry')} disabled={action.isPending}>Riprova (riprende dall’ultima riga salvata)</button>}
            {['uploaded', 'queued', 'failed'].includes(run.status) && <button className="btn btn-danger" onClick={() => action.mutate('cancel')} disabled={action.isPending}>Annulla import</button>}
          </div>
        )}
      </div>
      <ErrorNotice error={action.error} />
      {run.status === 'failed' && (
        <Notice kind="danger" title="Import fallito.">
          {run.error} I dati precedenti del fornitore restano invariati per le righe non elaborate e sono segnalati come non aggiornati.
          {run.checkpointRow > 0 && ` Ultima riga salvata: ${run.checkpointRow}.`}
        </Notice>
      )}
      {stuck && <Notice kind="warning">L’import non dà segni di avanzamento da oltre 15 minuti: puoi riprovare.</Notice>}
      {(run.status === 'running' || run.status === 'queued') && (
        <div className="card">
          <p style={{ marginTop: 0 }}>{run.status === 'queued' ? 'In coda: partirà appena il worker è libero.' : `Elaborazione in corso: ${pct}%`}</p>
          <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
        </div>
      )}
      {run.snapshotResult && <Notice kind="info">{run.snapshotResult}</Notice>}

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Risultato</h2>
          <dl className="kv">
            {COUNTER_LABELS.filter(([k]) => c[k] !== undefined).map(([k, l]) => (
              <FragmentRow key={k} label={l} value={c[k].toLocaleString('it-IT')} />
            ))}
          </dl>
        </div>
        <div className="card">
          <h2>File e immagini</h2>
          <dl className="kv">
            <dt>Formato</dt><dd>{run.fileKind.toUpperCase()} · {bytes(run.fileSize)}</dd>
            <dt>Caricato</dt><dd>{dateTime(run.createdAt)} {run.createdBy && `da ${run.createdBy}`}</dd>
            <dt>Iniziato / finito</dt><dd>{dateTime(run.startedAt)} / {dateTime(run.finishedAt)}</dd>
            <dt>Tentativi</dt><dd>{run.attempts}</dd>
            <dt>Immagini</dt><dd>{images.fetched} pronte · {images.pending} in scaricamento · {images.failed} non scaricabili</dd>
          </dl>
        </div>
      </div>

      <section className="card" aria-labelledby="issues-title">
        <div className="card-title">
          <h2 id="issues-title">Problemi per riga</h2>
          <div className="row">
            <select className="input" aria-label="Filtra per gravità" style={{ width: 'auto' }} value={severity} onChange={(e) => { setSeverity(e.target.value); setOffset(0); }}>
              <option value="">Errori e avvisi</option>
              <option value="error">Solo errori</option>
              <option value="warning">Solo avvisi</option>
            </select>
            <a className="btn btn-sm" href={`/api/imports/${id}/issues.csv`}>Scarica CSV</a>
          </div>
        </div>
        {issueSummary.length > 0 && (
          <ul className="small" style={{ paddingLeft: 18 }}>
            {issueSummary.map((s) => <li key={s.severity + s.code} className={s.severity === 'error' ? 'error-text' : undefined}>{s.count}× {s.message}</li>)}
          </ul>
        )}
        {issues.data?.items.length ? (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Riga</th><th>Gravità</th><th>Campo</th><th>Messaggio</th><th>Valore</th></tr></thead>
                <tbody>
                  {issues.data.items.map((i, n) => (
                    <tr key={`${i.row_number}-${i.code}-${n}`}>
                      <td>{i.row_number || 'file'}</td>
                      <td><span className={`badge ${i.severity === 'error' ? 'badge-bad' : 'badge-warn'}`}>{i.severity === 'error' ? 'errore' : 'avviso'}</span></td>
                      <td>{i.field ?? '—'}</td>
                      <td>{i.message}</td>
                      <td className="mono small">{i.value ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="muted small">{issues.data.total} problemi</span>
              <span className="spacer" />
              <button className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 200))}>Precedenti</button>
              <button className="btn btn-sm" disabled={offset + 200 >= issues.data.total} onClick={() => setOffset(offset + 200)}>Successivi</button>
            </div>
          </>
        ) : (
          <p className="muted">{run.status === 'succeeded' ? 'Nessun problema rilevato.' : 'Nessun problema registrato finora.'}</p>
        )}
      </section>
    </div>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
