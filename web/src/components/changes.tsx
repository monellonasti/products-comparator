import { Link } from 'react-router';
import { imageUrl } from '../api';
import { dateTime, money, STOCK_LABELS } from '../format';
import type { ChangeType, OfferChange } from '../types';

export const CHANGE_TYPES: Array<{ key: ChangeType; label: string }> = [
  { key: 'price', label: 'Prezzo' },
  { key: 'availability', label: 'Disponibilità' },
  { key: 'stock', label: 'Quantità' },
  { key: 'images', label: 'Immagini' },
  { key: 'new_offer', label: 'Nuove offerte' },
  { key: 'removed', label: 'Uscite dal listino' },
  { key: 'reactivated', label: 'Tornate a listino' },
  { key: 'barcode', label: 'EAN cambiato' },
];

function priceText(v: any): string {
  if (!v?.price) return 'nessun prezzo';
  const pack = v.unitsPerPack && v.unitsPerPack > 1 ? ` / ${v.unitsPerPack} pz` : '';
  const vat = v.vat === 'gross' ? ' IVA incl.' : v.vat === 'unknown' ? ' IVA n/d' : '';
  return `${money(v.price, v.currency)}${pack}${vat}`;
}

function stockText(v: any): string {
  const label = STOCK_LABELS[v?.status as keyof typeof STOCK_LABELS] ?? v?.status ?? '—';
  return v?.quantity !== null && v?.quantity !== undefined ? `${label} (${v.quantity})` : label;
}

/** "before → after" for a change, in plain language. */
export function ChangeValues({ c }: { c: OfferChange }) {
  const arrow = <span aria-hidden="true"> → </span>;
  switch (c.type) {
    case 'price': {
      const pct = c.pct === null ? null : Number(c.pct);
      return (
        <span>
          {priceText(c.oldValue)}
          {arrow}
          <strong>{priceText(c.newValue)}</strong>{' '}
          {pct !== null ? (
            <span className={`badge ${pct > 0 ? 'badge-bad' : pct < 0 ? 'badge-ok' : 'badge-neutral'}`}>
              {pct > 0 ? '+' : ''}
              {pct.toLocaleString('it-IT', { maximumFractionDigits: 2 })}%
            </span>
          ) : (
            <span className="muted small">(condizioni diverse: non confrontabile in %)</span>
          )}
        </span>
      );
    }
    case 'availability':
      return (
        <span>
          {stockText(c.oldValue)}
          {arrow}
          <strong>{stockText(c.newValue)}</strong>
        </span>
      );
    case 'stock':
      return (
        <span>
          {c.oldValue?.quantity ?? 'n/d'}
          {arrow}
          <strong>{c.newValue?.quantity ?? 'n/d'}</strong> pz
        </span>
      );
    case 'images':
      return (
        <span>
          {c.oldValue?.count ?? 0} → <strong>{c.newValue?.count ?? 0}</strong> immagini
          {c.newValue?.added?.length ? ` · ${c.newValue.added.length} aggiunte` : ''}
          {c.oldValue?.removed?.length ? ` · ${c.oldValue.removed.length} rimosse` : ''}
        </span>
      );
    case 'new_offer':
      return <span>{priceText(c.newValue)} · {stockText({ status: c.newValue?.stockStatus, quantity: c.newValue?.stockQuantity })}</span>;
    case 'removed':
      return <span>ultimo prezzo {priceText(c.oldValue)}</span>;
    case 'reactivated':
      return <span>{priceText(c.newValue)}</span>;
    case 'barcode':
      return (
        <span className="mono">
          {c.oldValue?.gtin ?? 'assente'}
          {arrow}
          {c.newValue?.gtin ?? 'assente'}
        </span>
      );
  }
}

export function ChangesTable({ items, showProduct = true }: { items: OfferChange[]; showProduct?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Quando</th>
            {showProduct && <th>Prodotto</th>}
            <th>Fornitore · codice</th>
            <th>Tipo</th>
            <th>Prima → dopo</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td className="small">
                {dateTime(c.at)}
                <div className="muted">{c.source === 'feed' ? 'feed automatico' : 'caricamento manuale'}</div>
              </td>
              {showProduct && (
                <td>
                  {c.product ? (
                    <Link to={`/prodotti/${c.product.id}`} className="row" style={{ gap: 8, flexWrap: 'nowrap', textDecoration: 'none' }}>
                      {c.product.imageId && <img src={imageUrl(c.product.imageId)} alt="" width={36} height={36} style={{ objectFit: 'contain', background: '#fff', borderRadius: 4, border: '1px solid var(--border)' }} />}
                      <span>{c.product.title}</span>
                    </Link>
                  ) : (
                    c.offerTitle ?? '—'
                  )}
                </td>
              )}
              <td>
                {c.supplier.name}
                <div className="mono small muted">{c.sku}</div>
              </td>
              <td>
                <span className="badge badge-info">{c.typeLabel}</span>
              </td>
              <td>
                <ChangeValues c={c} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Compact summary of change counters stored on an import run. */
export function ChangeCounters({ counters }: { counters: Record<string, number> }) {
  const items = CHANGE_TYPES.map((t) => ({ ...t, n: counters[`changes_${t.key}`] ?? 0 })).filter((t) => t.n > 0);
  if (!items.length) return <span className="muted small">Nessuna variazione di prezzo, disponibilità o immagini.</span>;
  return (
    <span className="row" style={{ gap: 6 }}>
      {items.map((t) => (
        <span key={t.key} className="badge badge-neutral">
          {t.label}: {t.n}
        </span>
      ))}
    </span>
  );
}
