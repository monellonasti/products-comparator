import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import type { FeedView, ImportRun, Supplier } from '../types';
import { FeedCard } from '../components/FeedCard';
import { ErrorNotice, Spinner, useDocumentTitle } from '../components/ui';
import { dateTime } from '../format';
import { SupplierForm, SupplierStatus } from './SuppliersPage';
import { RunStatus } from './ImportsPage';

export default function SupplierDetailPage() {
  const { id } = useParams();
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const s = useQuery({ queryKey: ['supplier', id], queryFn: () => api.get<{ supplier: Supplier; profiles: any[]; feed: FeedView }>(`/api/suppliers/${id}`) });
  const runs = useQuery({ queryKey: ['imports', { supplier: id }], queryFn: () => api.get<{ items: ImportRun[] }>(`/api/imports?supplier=${id}`) });
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api.get<{ items: Array<{ id: string; name: string }> }>('/api/categories') });
  const mappings = useQuery({ queryKey: ['category-mappings', id], queryFn: () => api.get<{ items: Array<{ raw_category: string; category_id: string | null; category_name: string | null; offers: number }> }>(`/api/suppliers/${id}/category-mappings`) });
  const setMapping = useMutation({
    mutationFn: (b: { rawCategory: string; categoryId: string | null }) => api.put(`/api/suppliers/${id}/category-mappings`, b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['category-mappings', id] });
      void qc.invalidateQueries({ queryKey: ['facets'] });
    },
  });
  useDocumentTitle(s.data?.supplier.name ?? 'Fornitore');
  if (s.isLoading) return <Spinner />;
  if (s.isError) return <div className="page"><ErrorNotice error={s.error} /></div>;
  const sup = s.data!.supplier;
  return (
    <div className="page">
      <nav className="small" style={{ marginBottom: 8 }}>
        <Link to="/fornitori">Fornitori</Link> › {sup.name}
      </nav>
      <div className="page-header">
        <div>
          <h1>{sup.name}</h1>
          <p>
            <SupplierStatus s={sup} /> · ultimo aggiornamento riuscito: {dateTime(sup.lastSuccessAsOf)}
          </p>
        </div>
        {isAdmin && (
          <div className="row">
            <button className="btn" onClick={() => setEditing(true)}>Modifica</button>
            <Link className="btn btn-primary" to={`/importazioni/nuova?supplier=${sup.id}`}>Importa listino</Link>
          </div>
        )}
      </div>
      <div className="grid-2">
        <div className="card">
          <h2>Configurazione</h2>
          <dl className="kv">
            <dt>Codice</dt><dd className="mono">{sup.code}</dd>
            <dt>Priorità dati</dt><dd>{sup.priority}</dd>
            <dt>Prezzi</dt><dd>{sup.defaultVatTreatment === 'net' ? 'IVA esclusa' : sup.defaultVatTreatment === 'gross' ? `IVA inclusa (${sup.defaultVatRate ?? '?'}%)` : 'IVA non dichiarata'} · {sup.defaultCurrency}</dd>
            <dt>Dati vecchi dopo</dt><dd>{sup.staleAfterHours} ore</dd>
            <dt>Host immagini</dt><dd className="mono small">{sup.imageHostAllowlist.length ? sup.imageHostAllowlist.join(', ') : 'qualsiasi host pubblico'}</dd>
            <dt>Aggiornamento</dt><dd>{sup.feedEnabled ? `feed automatico, ${sup.feedScheduleText}` : 'caricamento manuale di CSV/XLSX'}</dd>
            {sup.website && (<><dt>Sito</dt><dd><a href={sup.website} target="_blank" rel="noopener noreferrer">{sup.website}</a></dd></>)}
          </dl>
          {s.data!.profiles.length > 0 && <p className="muted small">Mappatura colonne salvata: verrà proposta al prossimo import.</p>}
        </div>
        <div className="card">
          <h2>Ultimi import</h2>
          {runs.data?.items.length ? (
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {runs.data.items.slice(0, 8).map((r) => (
                <li key={r.id} style={{ marginBottom: 4 }}>
                  <Link to={`/importazioni/${r.id}`}>{r.fileName}</Link> · <RunStatus status={r.status} /> · {dateTime(r.createdAt)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nessun import.</p>
          )}
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <FeedCard supplierId={sup.id} feed={s.data!.feed} isAdmin={isAdmin} />
      </div>
      <section className="card" aria-labelledby="cat-title">
        <h2 id="cat-title">Categorie del fornitore → categorie normalizzate</h2>
        {mappings.data?.items.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Categoria nel listino</th><th className="num">Offerte</th><th>Categoria normalizzata</th></tr></thead>
              <tbody>
                {mappings.data.items.map((m) => (
                  <tr key={m.raw_category}>
                    <td>{m.raw_category}</td>
                    <td className="num">{m.offers}</td>
                    <td>
                      {isAdmin ? (
                        <select className="input" aria-label={`Categoria per ${m.raw_category}`} value={m.category_id ?? ''} onChange={(e) => setMapping.mutate({ rawCategory: m.raw_category, categoryId: e.target.value || null })}>
                          <option value="">— da mappare —</option>
                          {cats.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      ) : (
                        m.category_name ?? <span className="muted">da mappare</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Le categorie compaiono dopo il primo import con la colonna categoria mappata.</p>
        )}
        <ErrorNotice error={setMapping.error} />
      </section>
      {editing && <SupplierForm supplier={sup} onClose={() => setEditing(false)} />}
    </div>
  );
}
