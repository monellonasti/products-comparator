import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, imageUrl, qs } from '../api';
import type { ProductCard } from '../types';
import { ErrorNotice, Spinner, useDocumentTitle } from '../components/ui';
import { dateTime } from '../format';

interface ReviewRow {
  id: string;
  kind: string;
  kindLabel: string;
  status: string;
  score: number | null;
  reasons: Array<{ code: string; message: string }>;
  gtin: string | null;
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  product?: ProductCard;
  candidate?: ProductCard;
}

const RESOLUTION: Record<string, string> = { merged: 'Uniti', kept_separate: 'Mantenuti separati', dismissed: 'Ignorata' };

function Mini({ p }: { p?: ProductCard }) {
  if (!p) return <span className="muted">prodotto non disponibile</span>;
  return (
    <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
      {p.imageId ? <img src={imageUrl(p.imageId)} alt="" width={44} height={44} style={{ objectFit: 'contain', background: '#fff', border: '1px solid var(--border)', borderRadius: 6 }} /> : null}
      <span>
        <span style={{ fontWeight: 600 }}>{p.title}</span>
        <span className="muted small" style={{ display: 'block' }}>
          {p.brand ?? 'marca n/d'} · {p.gtin ? `EAN ${p.gtin}` : 'senza EAN'} · {p.supplierCount} forn.
        </span>
      </span>
    </span>
  );
}

export default function ReviewsPage() {
  useDocumentTitle('Corrispondenze da verificare');
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'open';
  const kind = params.get('kind') ?? '';
  const q = useQuery({ queryKey: ['reviews', status, kind], queryFn: () => api.get<{ items: ReviewRow[]; openCounts: Record<string, number> }>(`/api/reviews${qs({ status, kind })}`) });
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    setParams(n);
  };
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Corrispondenze da verificare</h1>
          <p>Nessuna fusione avviene in automatico per somiglianza: qui si decide con le evidenze. Ogni decisione è tracciata e annullabile.</p>
        </div>
        <div className="row">
          <select className="input" aria-label="Stato" style={{ width: 'auto' }} value={status} onChange={(e) => set('status', e.target.value)}>
            <option value="open">Da verificare</option>
            <option value="resolved">Risolte</option>
            <option value="dismissed">Ignorate</option>
          </select>
          <select className="input" aria-label="Tipo" style={{ width: 'auto' }} value={kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="">Tutti i tipi</option>
            <option value="gtin_conflict">Stesso EAN, dati in conflitto ({q.data?.openCounts.gtin_conflict ?? 0})</option>
            <option value="suggested_duplicate">Possibili doppioni senza EAN ({q.data?.openCounts.suggested_duplicate ?? 0})</option>
            <option value="gtin_changed">EAN cambiato ({q.data?.openCounts.gtin_changed ?? 0})</option>
          </select>
        </div>
      </div>
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorNotice error={q.error} /> : q.data!.items.length === 0 ? (
        <div className="card empty"><h2>{status === 'open' ? 'Niente da verificare' : 'Nessuna revisione'}</h2><p>{status === 'open' ? 'Tutte le corrispondenze sono state gestite.' : ''}</p></div>
      ) : (
        <div className="stack">
          {q.data!.items.map((r) => (
            <Link key={r.id} to={`/corrispondenze/${r.id}`} className="card" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className={`badge ${r.kind === 'gtin_conflict' ? 'badge-warn' : 'badge-info'}`}>{r.kindLabel}</span>
                {r.gtin && <span className="mono small">EAN {r.gtin}</span>}
                <span className="spacer" />
                <span className="muted small">{dateTime(r.created_at)}</span>
                {r.resolution && <span className="badge badge-neutral">{RESOLUTION[r.resolution]}{r.resolved_by ? ` da ${r.resolved_by}` : ''}</span>}
              </div>
              <div className="compare">
                <Mini p={r.product} />
                <Mini p={r.candidate} />
              </div>
              <ul className="evidence">{r.reasons.map((x) => <li key={x.code + x.message}>{x.message}</li>)}</ul>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
