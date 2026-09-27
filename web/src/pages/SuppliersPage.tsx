import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import type { Supplier } from '../types';
import { ErrorNotice, Modal, Spinner, useDocumentTitle } from '../components/ui';
import { ago, dateTime } from '../format';

export function SupplierStatus({ s }: { s: Supplier }) {
  if (!s.lastImportStatus) return <span className="badge badge-neutral">Nessun import</span>;
  if (s.lastImportStatus === 'failed') return <span className="badge badge-bad">Ultimo import fallito</span>;
  const stale = s.lastSuccessAsOf && Date.now() - new Date(s.lastSuccessAsOf).getTime() > s.staleAfterHours * 3600_000;
  return stale ? <span className="badge badge-warn">Dati non aggiornati</span> : <span className="badge badge-ok">Aggiornato</span>;
}

export default function SuppliersPage() {
  useDocumentTitle('Fornitori');
  const { isAdmin } = useAuth();
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<{ items: Supplier[] }>('/api/suppliers') });
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Fornitori</h1>
          <p>Listini, priorità dei dati e stato degli aggiornamenti.</p>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            Nuovo fornitore
          </button>
        )}
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorNotice error={q.error} />
      ) : q.data!.items.length === 0 ? (
        <div className="card empty">
          <h2>Nessun fornitore</h2>
          <p>{isAdmin ? 'Crea il primo fornitore per poter importare il suo listino.' : 'Un amministratore deve configurare i fornitori.'}</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Fornitore</th>
                <th>Stato</th>
                <th className="num">Offerte attive</th>
                <th>Dati aggiornati</th>
                <th className="num">Priorità</th>
                <th>Aggiornamento</th>
                <th>Prezzi</th>
                <th>Da sistemare</th>
              </tr>
            </thead>
            <tbody>
              {q.data!.items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/fornitori/${s.id}`}>
                      <strong>{s.name}</strong>
                    </Link>
                    <div className="muted small mono">{s.code}{!s.active && ' · disattivato'}</div>
                  </td>
                  <td>
                    <SupplierStatus s={s} />
                  </td>
                  <td className="num">{s.stats?.activeOffers.toLocaleString('it-IT')}</td>
                  <td title={dateTime(s.lastSuccessAsOf)}>{ago(s.lastSuccessAsOf)}</td>
                  <td className="num">{s.priority}</td>
                  <td className="small">
                    {s.feedEnabled ? (
                      <>
                        Feed {s.feedScheduleText}
                        {s.feedLastStatus === 'failed' && <div><span className="badge badge-bad">ultimo feed non riuscito</span></div>}
                      </>
                    ) : (
                      'Manuale'
                    )}
                  </td>
                  <td>{s.defaultVatTreatment === 'net' ? 'IVA esclusa' : s.defaultVatTreatment === 'gross' ? `IVA inclusa ${s.defaultVatRate ?? ''}%` : <span className="badge badge-warn">IVA non dichiarata</span>}</td>
                  <td className="small">
                    {s.stats && s.stats.imagesFailed > 0 && <div>{s.stats.imagesFailed} immagini non scaricabili</div>}
                    {s.stats && s.stats.unmappedCategories > 0 && <div>{s.stats.unmappedCategories} categorie da mappare</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <SupplierForm onClose={() => setCreating(false)} />}
    </div>
  );
}

export function SupplierForm({ supplier, onClose }: { supplier?: Supplier; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [f, setF] = useState({
    code: supplier?.code ?? '',
    name: supplier?.name ?? '',
    website: supplier?.website ?? '',
    priority: supplier?.priority ?? 100,
    defaultCurrency: supplier?.defaultCurrency ?? 'EUR',
    defaultVatTreatment: supplier?.defaultVatTreatment ?? 'unknown',
    defaultVatRate: supplier?.defaultVatRate ? String(Number(supplier.defaultVatRate)) : '',
    imageHostAllowlist: (supplier?.imageHostAllowlist ?? []).join(', '),
    staleAfterHours: supplier?.staleAfterHours ?? 168,
    active: supplier?.active ?? true,
    notes: supplier?.notes ?? '',
  });
  const set = (k: keyof typeof f, v: any) => setF((s) => ({ ...s, [k]: v }));
  const m = useMutation({
    mutationFn: () => {
      const body = {
        ...f,
        website: f.website || null,
        defaultVatRate: f.defaultVatTreatment === 'gross' && f.defaultVatRate ? f.defaultVatRate.replace(',', '.') : null,
        imageHostAllowlist: f.imageHostAllowlist.split(/[,\s]+/).map((h) => h.trim()).filter(Boolean),
        priority: Number(f.priority),
        staleAfterHours: Number(f.staleAfterHours),
        notes: f.notes || null,
      };
      return supplier ? api.patch<{ supplier: Supplier }>(`/api/suppliers/${supplier.id}`, body) : api.post<{ supplier: Supplier }>('/api/suppliers', body);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
      void qc.invalidateQueries({ queryKey: ['supplier'] });
      onClose();
      if (!supplier) navigate(`/fornitori/${r.supplier.id}`);
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={supplier ? `Modifica ${supplier.name}` : 'Nuovo fornitore'}
      footer={
        <>
          <button className="btn" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={() => m.mutate()} disabled={m.isPending}>Salva</button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label htmlFor="s-name">Nome</label>
          <input id="s-name" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="s-code">Codice breve <span className="field-hint">minuscole, numeri, trattini</span></label>
          <input id="s-code" className="input mono" value={f.code} onChange={(e) => set('code', e.target.value.toLowerCase())} />
        </div>
        <div className="field">
          <label htmlFor="s-web">Sito</label>
          <input id="s-web" className="input" value={f.website} onChange={(e) => set('website', e.target.value)} placeholder="https://" />
        </div>
        <div className="field">
          <label htmlFor="s-prio">Priorità dati <span className="field-hint">più bassa = prevale su titoli, marca, immagini</span></label>
          <input id="s-prio" className="input" type="number" min={0} value={f.priority} onChange={(e) => set('priority', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="s-vat">I prezzi dei listini sono</label>
          <select id="s-vat" className="input" value={f.defaultVatTreatment} onChange={(e) => set('defaultVatTreatment', e.target.value)}>
            <option value="net">IVA esclusa (netti)</option>
            <option value="gross">IVA inclusa</option>
            <option value="unknown">Non so (prezzi non confrontabili)</option>
          </select>
        </div>
        {f.defaultVatTreatment === 'gross' && (
          <div className="field">
            <label htmlFor="s-rate">Aliquota IVA %</label>
            <input id="s-rate" className="input" inputMode="decimal" value={f.defaultVatRate} onChange={(e) => set('defaultVatRate', e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="s-cur">Valuta</label>
          <input id="s-cur" className="input mono" maxLength={3} value={f.defaultCurrency} onChange={(e) => set('defaultCurrency', e.target.value.toUpperCase())} />
        </div>
        <div className="field">
          <label htmlFor="s-stale">Dati considerati vecchi dopo (ore)</label>
          <input id="s-stale" className="input" type="number" min={1} value={f.staleAfterHours} onChange={(e) => set('staleAfterHours', e.target.value)} />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="s-hosts">Host autorizzati per le immagini <span className="field-hint">es. cdn.fornitore.it, separati da virgola; vuoto = qualsiasi host pubblico</span></label>
          <input id="s-hosts" className="input mono" value={f.imageHostAllowlist} onChange={(e) => set('imageHostAllowlist', e.target.value)} />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="s-notes">Note</label>
          <textarea id="s-notes" className="input" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Fornitore attivo
        </label>
      </div>
      <ErrorNotice error={m.error} />
    </Modal>
  );
}
