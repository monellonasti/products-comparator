import { Link, NavLink, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import type { ImportRun } from '../types';
import { ErrorNotice, Spinner, useDocumentTitle } from '../components/ui';
import { bytes, dateTime } from '../format';

const STATUS: Record<ImportRun['status'], [string, string]> = {
  uploaded: ['Da configurare', 'badge-neutral'],
  queued: ['In coda', 'badge-info'],
  running: ['In corso', 'badge-info'],
  succeeded: ['Completato', 'badge-ok'],
  failed: ['Fallito', 'badge-bad'],
  cancelled: ['Annullato', 'badge-neutral'],
};

export function RunStatus({ status }: { status: ImportRun['status'] }) {
  const [label, cls] = STATUS[status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function ImportsTabs(_props: { active: "runs" | "changes" }) {
  return (
    <nav className="tabs" aria-label="Sezioni importazioni">
      <NavLink to="/importazioni" end className="tab-link">
        Importazioni
      </NavLink>
      <NavLink to="/importazioni/variazioni" className="tab-link">
        Variazioni
      </NavLink>
    </nav>
  );
}

export default function ImportsPage() {
  useDocumentTitle('Importazioni');
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const q = useQuery({
    queryKey: ['imports', { status }],
    queryFn: () => api.get<{ items: ImportRun[] }>(`/api/imports${qs({ status })}`),
    refetchInterval: (query) => (query.state.data?.items.some((r) => r.status === 'queued' || r.status === 'running') ? 3000 : 30_000),
  });
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Importazioni</h1>
          <p>Stato dei listini caricati, errori per riga e ripresa degli import falliti.</p>
        </div>
        <div className="row">
          <select className="input" aria-label="Filtra per stato" style={{ width: 'auto' }} value={status} onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})}>
            <option value="">Tutti gli stati</option>
            {Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {isAdmin && <Link className="btn btn-primary" to="/importazioni/nuova">Nuovo import</Link>}
        </div>
      </div>
      <ImportsTabs active="runs" />
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorNotice error={q.error} /> : q.data!.items.length === 0 ? (
        <div className="card empty"><h2>Nessun import</h2><p>{isAdmin ? 'Carica il primo listino CSV o XLSX di un fornitore.' : 'Non ci sono ancora import.'}</p></div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>File</th><th>Fornitore</th><th>Stato</th><th>Tipo</th><th className="num">Righe</th><th>Esito</th><th>Caricato</th></tr></thead>
            <tbody>
              {q.data!.items.map((r) => {
                const c = r.counters ?? {};
                const pct = r.stagedRows ? Math.round(((c.rows_processed ?? 0) / r.stagedRows) * 100) : 0;
                return (
                  <tr key={r.id}>
                    <td><Link to={`/importazioni/${r.id}`}>{r.fileName}</Link><div className="muted small">{r.sourceKind === 'feed' ? 'feed automatico' : 'caricamento manuale'} · {r.fileKind.toUpperCase()} · {bytes(r.fileSize)}</div></td>
                    <td>{r.supplierName}</td>
                    <td><RunStatus status={r.status} />{r.status === 'running' && <div className="progress" style={{ marginTop: 6, width: 120 }} aria-label={`Avanzamento ${pct}%`}><span style={{ width: `${pct}%` }} /></div>}</td>
                    <td>{r.mode === 'snapshot' ? 'Listino completo' : 'Aggiornamento parziale'}</td>
                    <td className="num">{(r.stagedRows ?? c.rows_total ?? 0).toLocaleString('it-IT')}</td>
                    <td className="small">
                      {r.status === 'succeeded' && (
                        <>
                          {c.offers_created ?? 0} nuove · {c.offers_updated ?? 0} aggiornate · {c.offers_unchanged ?? 0} invariate{c.rows_error ? ` · ${c.rows_error} righe con errori` : ''}
                          {(c.changes_price ?? 0) + (c.changes_availability ?? 0) > 0 && (
                            <div>
                              <Link to={`/importazioni/variazioni?run=${r.id}`}>
                                {c.changes_price ?? 0} prezzi · {c.changes_availability ?? 0} disponibilità cambiati
                              </Link>
                            </div>
                          )}
                        </>
                      )}
                      {r.status === 'failed' && <span className="error-text">{r.error}</span>}
                    </td>
                    <td>{dateTime(r.createdAt)}<div className="muted small">{r.createdBy ?? ''}</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
