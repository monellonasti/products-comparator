import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, imageUrl } from '../api';
import { useAuth } from '../auth';
import { ErrorNotice, Notice, Spinner, useDocumentTitle } from '../components/ui';
import { money } from '../format';

const ATTR: Record<string, string> = { color: 'Colore', size: 'Misura', variant: 'Variante', net_content: 'Contenuto', pieces: 'Pezzi', material: 'Materiale' };
const attrText = (a: Record<string, string>) => Object.entries(a ?? {}).map(([k, v]) => `${ATTR[k] ?? k}: ${v}`).join(', ');

interface Side {
  id: string;
  title: string;
  brand: string | null;
  attributes: Record<string, string>;
  status: string;
  primary_image_id: string | null;
  identifiers: string[];
  offers: Array<{ id: string; supplier_sku: string; title: string | null; brand: string | null; attributes: Record<string, string>; barcode_raw: string | null; barcode_status: string; gtin: string | null; price: string | null; currency: string | null; units_per_pack: number | null; link_source: string; supplier_name: string }>;
}

export default function ReviewDetailPage() {
  useDocumentTitle('Verifica corrispondenza');
  const { id } = useParams();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['review', id], queryFn: () => api.get<{ review: any; product: Side; candidate: Side }>(`/api/reviews/${id}`) });
  const resolve = useMutation({
    mutationFn: (action: 'merge' | 'keep_separate' | 'dismiss') => api.post<{ auditEventId: number | null }>(`/api/reviews/${id}/resolve`, { action, note: note || undefined }),
    onSuccess: () => {
      void qc.invalidateQueries();
      navigate('/corrispondenze');
    },
  });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <div className="page"><ErrorNotice error={q.error} /></div>;
  const { review, product, candidate } = q.data!;
  const bothGtin = product.identifiers.length > 0 && candidate.identifiers.length > 0;
  return (
    <div className="page">
      <nav className="small" style={{ marginBottom: 8 }}><Link to="/corrispondenze">Corrispondenze</Link> › verifica</nav>
      <h1 style={{ marginTop: 0 }}>{review.kindLabel}</h1>
      <Notice kind={review.kind === 'gtin_conflict' ? 'warning' : 'info'}>
        <ul style={{ margin: 0, paddingLeft: 18 }}>{review.reasons.map((r: any) => <li key={r.code + r.message}>{r.message}</li>)}</ul>
      </Notice>
      <div className="compare" style={{ marginTop: 16 }}>
        {[{ label: review.kind === 'gtin_conflict' ? 'Offerta in attesa di verifica' : 'Prodotto', side: product }, { label: 'Prodotto esistente', side: candidate }].map(({ label, side }) => (
          <div className="card" key={side.id}>
            <p className="muted small" style={{ marginTop: 0 }}>{label}</p>
            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              {side.primary_image_id && <img src={imageUrl(side.primary_image_id)} alt="" width={120} height={120} style={{ objectFit: 'contain', background: '#fff', border: '1px solid var(--border)', borderRadius: 8 }} />}
              <div>
                <Link to={`/prodotti/${side.id}`}><strong>{side.title || '(senza titolo)'}</strong></Link>
                <div className="small muted">{side.brand ?? 'marca n/d'} · {side.identifiers.length ? `EAN ${side.identifiers.join(', ')}` : 'nessun EAN'}</div>
                {Object.entries(side.attributes ?? {}).map(([k, v]) => <div key={k} className="small">{ATTR[k] ?? k}: {v}</div>)}
              </div>
            </div>
            <h3 style={{ marginTop: 12 }}>Offerte</h3>
            <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
              {side.offers.map((o) => (
                <li key={o.id}>
                  <strong>{o.supplier_name}</strong> · <span className="mono">{o.supplier_sku}</span> · “{o.title}” · marca {o.brand ?? 'n/d'} · EAN {o.barcode_raw ?? '—'} ({o.barcode_status})
                  {Object.keys(o.attributes ?? {}).length > 0 && ` · ${attrText(o.attributes)}`} · {money(o.price, o.currency)}
                  {o.units_per_pack && o.units_per_pack > 1 ? ` per ${o.units_per_pack} pz` : ''}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {review.status !== 'open' ? (
        <Notice kind="info">Revisione chiusa ({review.resolution}). {review.audit_event_id && review.resolution === 'merged' && 'L’unione si può annullare dallo storico della scheda prodotto.'}</Notice>
      ) : isAdmin ? (
        <div className="card stack" style={{ marginTop: 16 }}>
          <div className="field">
            <label htmlFor="note">Motivazione ed evidenze {bothGtin ? '(obbligatoria per unire prodotti con EAN diversi)' : ''}</label>
            <textarea id="note" className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="es. stessa variante e confezione confermata dal catalogo del produttore" />
          </div>
          <ErrorNotice error={resolve.error} />
          <div className="row">
            <button className="btn btn-primary" disabled={resolve.isPending} onClick={() => resolve.mutate('merge')}>Stesso prodotto: unisci</button>
            <button className="btn" disabled={resolve.isPending} onClick={() => resolve.mutate('keep_separate')}>Prodotti diversi: mantieni separati</button>
            <button className="btn btn-ghost" disabled={resolve.isPending} onClick={() => resolve.mutate('dismiss')}>Ignora</button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>“Mantieni separati” viene ricordato: la stessa coppia non verrà riproposta.</p>
        </div>
      ) : (
        <Notice kind="info">Solo un amministratore può decidere su questa corrispondenza.</Notice>
      )}
    </div>
  );
}
