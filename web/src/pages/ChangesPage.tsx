import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../api';
import type { OfferChange, Supplier } from '../types';
import { DecimalFilterInput, ErrorNotice, Spinner, useDocumentTitle } from '../components/ui';
import { CHANGE_TYPES, ChangesTable } from '../components/changes';
import { ImportsTabs } from './ImportsPage';

const PERIODS = [
  { hours: 24, label: 'Ultime 24 ore' },
  { hours: 24 * 7, label: 'Ultimi 7 giorni' },
  { hours: 24 * 30, label: 'Ultimi 30 giorni' },
  { hours: 24 * 90, label: 'Ultimi 90 giorni' },
];
const PAGE = 100;

export default function ChangesPage() {
  useDocumentTitle('Variazioni');
  const [params, setParams] = useSearchParams();
  const f = {
    sinceHours: params.get('sinceHours') ?? String(24 * 7),
    supplier: params.get('supplier') ?? '',
    types: params.get('types') ?? '',
    minPct: params.get('minPct') ?? '',
    run: params.get('run') ?? '',
    offset: Number(params.get('offset') ?? 0),
  };
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== 'offset') n.delete('offset');
    setParams(n, { replace: true });
  };
  const selected = new Set(f.types.split(',').filter(Boolean));
  const toggleType = (t: string) => {
    const next = new Set(selected);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    set('types', [...next].join(','));
  };
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<{ items: Supplier[] }>('/api/suppliers') });
  const query = qs({ sinceHours: f.run ? undefined : f.sinceHours, supplier: f.supplier, types: f.types, minPct: f.minPct, run: f.run });
  const q = useQuery({
    queryKey: ['changes', query, f.offset],
    queryFn: () => api.get<{ items: OfferChange[]; counts: Record<string, number> }>(`/api/changes${query}${query ? '&' : '?'}offset=${f.offset}&limit=${PAGE}`),
  });
  const counts = q.data?.counts ?? {};
  const total = selected.size ? [...selected].reduce((a, t) => a + (counts[t] ?? 0), 0) : Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Variazioni dei listini</h1>
          <p>Cosa è cambiato a ogni aggiornamento: prezzi, disponibilità, quantità, immagini e offerte entrate o uscite.</p>
        </div>
        <a className="btn" href={`/api/changes.csv${query}`}>
          Scarica CSV
        </a>
      </div>
      <ImportsTabs active="changes" />
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="form-grid">
          {f.run ? (
            <div className="field">
              <span style={{ fontWeight: 500, fontSize: 14 }}>Import</span>
              <span>
                <Link to={`/importazioni/${f.run}`}>singolo import</Link>{' '}
                <button className="btn btn-sm" onClick={() => set('run', '')}>
                  Mostra tutti
                </button>
              </span>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="c-period">Periodo</label>
              <select id="c-period" className="input" value={f.sinceHours} onChange={(e) => set('sinceHours', e.target.value)}>
                {PERIODS.map((p) => (
                  <option key={p.hours} value={p.hours}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="c-supplier">Fornitore</label>
            <select id="c-supplier" className="input" value={f.supplier} onChange={(e) => set('supplier', e.target.value)}>
              <option value="">Tutti</option>
              {suppliers.data?.items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="c-pct">Prezzi: variazione minima %</label>
            <DecimalFilterInput id="c-pct" placeholder="qualsiasi" value={f.minPct} onApply={(v) => set('minPct', v)} />
          </div>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: '12px 0 0' }}>
          <legend className="small" style={{ fontWeight: 500, marginBottom: 6 }}>
            Tipo di variazione
          </legend>
          <div className="row" style={{ gap: 6 }}>
            {CHANGE_TYPES.map((t) => (
              <button key={t.key} type="button" className={`btn btn-sm${selected.has(t.key) ? ' btn-primary' : ''}`} aria-pressed={selected.has(t.key)} onClick={() => toggleType(t.key)}>
                {t.label} ({counts[t.key] ?? 0})
              </button>
            ))}
            {selected.size > 0 && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => set('types', '')}>
                Tutti i tipi
              </button>
            )}
          </div>
        </fieldset>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorNotice error={q.error} />
      ) : q.data!.items.length === 0 ? (
        <div className="card empty">
          <h2>Nessuna variazione</h2>
          <p>Nel periodo e con i filtri scelti i listini non hanno cambiato prezzi, disponibilità o immagini.</p>
        </div>
      ) : (
        <>
          <p className="muted small">{total.toLocaleString('it-IT')} variazioni</p>
          <ChangesTable items={q.data!.items} />
          <div className="row" style={{ marginTop: 8 }}>
            <span className="spacer" />
            <button className="btn btn-sm" disabled={f.offset === 0} onClick={() => set('offset', String(Math.max(0, f.offset - PAGE)))}>
              Precedenti
            </button>
            <button className="btn btn-sm" disabled={q.data!.items.length < PAGE} onClick={() => set('offset', String(f.offset + PAGE))}>
              Successive
            </button>
          </div>
        </>
      )}
    </div>
  );
}
