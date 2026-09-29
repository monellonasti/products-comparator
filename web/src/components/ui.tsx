import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { imageUrl } from '../api';
import { money, parseDecimalInput, STOCK_LABELS, date } from '../format';
import type { PriceSummary, ProductCard, StockStatus } from '../types';

export function Spinner({ label = 'Caricamento…' }: { label?: string }) {
  return (
    <div className="center" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Notice({ kind = 'info', children, title }: { kind?: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode; title?: string }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'danger' ? 'alert' : 'status'}>
      <div>
        {title && <strong>{title} </strong>}
        {children}
      </div>
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Errore imprevisto';
  const details = (error as any)?.details as string[] | undefined;
  return (
    <Notice kind="danger">
      {message}
      {details?.length ? (
        <ul className="small">
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      ) : null}
    </Notice>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement as HTMLElement | null;
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);
  // Many dialogs are removed by their parent ({x && <Modal open …/>}) without close(): give the focus back
  // to the button that opened them instead of losing it on <body>. No close() here: its "close" event would
  // reach onClose (under StrictMode's simulated unmount the dialog is still in use); passive cleanups run
  // after the dialog has left the DOM, so the opener is no longer inert.
  useEffect(
    () => () => {
      const el = opener.current;
      if (el && el.isConnected) el.focus();
    },
    [],
  );
  return (
    <dialog ref={ref} className="modal" onClose={onClose} onCancel={onClose} aria-labelledby="modal-title" style={wide ? { width: 'min(1100px, calc(100vw - 24px))' } : undefined}>
      {open && (
        <>
          <div className="modal-head">
            <h2 id="modal-title">{title}</h2>
            <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Chiudi">
              ✕
            </button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function StockBadge({ status }: { status: StockStatus }) {
  const cls = status === 'in_stock' ? 'badge-ok' : status === 'low_stock' || status === 'on_order' ? 'badge-warn' : status === 'out_of_stock' ? 'badge-bad' : 'badge-neutral';
  return <span className={`badge ${cls}`}>{STOCK_LABELS[status]}</span>;
}

export function AvailabilityLine({ card }: { card: Pick<ProductCard, 'availableSupplierCount' | 'offerCount' | 'supplierCount'> }) {
  if (card.offerCount === 0) return <span className="badge badge-neutral">Nessuna offerta attiva</span>;
  if (card.availableSupplierCount > 0)
    return <span className="badge badge-ok">Disponibile presso {card.availableSupplierCount} {card.availableSupplierCount === 1 ? 'fornitore' : 'fornitori'}</span>;
  return <span className="badge badge-neutral">Disponibilità non confermata</span>;
}

export function BestPriceBlock({ summary }: { summary: PriceSummary | null }) {
  if (!summary || (!summary.best && !summary.cheaperSoldOut)) {
    return <span className="price-note">{summary && summary.notComparableCount > 0 ? 'Prezzi non confrontabili (dati mancanti)' : 'Prezzo non disponibile'}</span>;
  }
  const b = summary.best;
  return (
    <>
      {b ? (
        <>
          <span className="price-main">
            {money(b.unitPrice, b.currency)} <span className="price-note">/ pz netto</span>
          </span>
          {(b.unitsPerPack > 1 || (b.moq ?? 1) > 1) && (
            <span className="price-note">
              {b.unitsPerPack > 1 ? `in confezione da ${b.unitsPerPack}` : ''}
              {b.unitsPerPack > 1 && (b.moq ?? 1) > 1 ? ' · ' : ''}
              {(b.moq ?? 1) > 1 ? `minimo ${b.moq}` : ''}
            </span>
          )}
          {b.stockStatus === 'unknown' && <span className="price-note">disponibilità non dichiarata</span>}
        </>
      ) : (
        <span className="price-note">Nessun prezzo confrontabile disponibile all'acquisto</span>
      )}
      {summary.cheaperSoldOut && <span className="price-note">Più economico ma esaurito: {money(summary.cheaperSoldOut.unitPrice, summary.cheaperSoldOut.currency)}</span>}
      {summary.otherCurrencies.length > 0 && <span className="price-note">Altre valute non convertite: {summary.otherCurrencies.join(', ')}</span>}
    </>
  );
}

export function ProductCardView({ card, extra, to }: { card: ProductCard; extra?: ReactNode; to?: string }) {
  return (
    <Link className="product-card" to={to ?? `/prodotti/${card.id}`}>
      <div className="product-thumb">
        {card.imageId ? <img src={imageUrl(card.imageId)} alt="" loading="lazy" decoding="async" /> : <span className="placeholder">Nessuna immagine</span>}
        <div className="corner">{card.stale && <span className="badge badge-warn" title="Dati del fornitore non aggiornati">Dati non aggiornati</span>}</div>
      </div>
      <div className="product-body">
        <span className="product-title">{card.title}</span>
        <div className="product-meta">
          {card.brand && <span>{card.brand}</span>}
          <span>{card.gtin ? `EAN ${card.gtin}` : 'EAN assente'}</span>
        </div>
        <div className="product-meta">
          <span>
            {card.supplierCount} {card.supplierCount === 1 ? 'fornitore' : 'fornitori'}
          </span>
          {card.dataAsOf && <span>agg. {date(card.dataAsOf)}</span>}
        </div>
        <AvailabilityLine card={card} />
        <div className="product-price">
          <BestPriceBlock summary={card.bestPrice} />
        </div>
        {extra}
      </div>
    </Link>
  );
}

/**
 * Numeric filter field bound to a URL value: accepts the Italian comma, applies on blur or Enter, and
 * rejects invalid input with a message instead of sending it to the server. Follows external changes
 * of the value (reset filters, back/forward).
 */
export function DecimalFilterInput({ value, onApply, id, label, placeholder }: { value: string; onApply: (v: string) => void; id?: string; label?: string; placeholder?: string }) {
  const shown = value.replace('.', ',');
  const [text, setText] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(shown);
    setInvalid(false);
  }, [shown]);
  const apply = () => {
    const v = parseDecimalInput(text);
    if (v === null) {
      setInvalid(true);
      return;
    }
    if (v !== value) onApply(v);
  };
  return (
    <span className="decimal-input">
      <input
        id={id}
        aria-label={label}
        className="input"
        inputMode="decimal"
        placeholder={placeholder}
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply();
          }
        }}
      />
      {invalid && <span className="error-text small" role="alert">Numero non valido</span>}
    </span>
  );
}

/** Previous/next pages for lists paginated by the server with `offset` and `hasMore`. */
export function Pager({ offset, limit, hasMore, onChange }: { offset: number; limit: number; hasMore: boolean; onChange: (offset: number) => void }) {
  if (offset === 0 && !hasMore) return null;
  return (
    <nav className="row" aria-label="Pagine" style={{ marginTop: 12 }}>
      <span className="muted small">
        Elementi {offset + 1}–{offset + limit}
      </span>
      <span className="spacer" />
      <button className="btn btn-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        Precedenti
      </button>
      <button className="btn btn-sm" disabled={!hasMore} onClick={() => onChange(offset + limit)}>
        Successivi
      </button>
    </nav>
  );
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Catalogo fornitori`;
  }, [title]);
}
