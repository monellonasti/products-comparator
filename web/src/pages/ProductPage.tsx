import { useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, imageUrl, qs } from '../api';
import { useAuth } from '../auth';
import type { CatalogPage, Offer, ProductDetail } from '../types';
import { BestPriceBlock, ErrorNotice, Modal, Notice, Spinner, StockBadge, useDocumentTitle } from '../components/ui';
import { ago, BARCODE_STATUS_LABELS, dateTime, LINK_LABELS, money, stockText, VAT_LABELS } from '../format';

const ATTR_LABELS: Record<string, string> = { color: 'Colore', size: 'Misura/taglia', variant: 'Variante', net_content: 'Contenuto netto', pieces: 'Pezzi per articolo', material: 'Materiale' };
const ACTION_LABELS: Record<string, string> = {
  'product.merge': 'Unione di prodotti',
  'product.split': 'Separazione (annullamento unione)',
  'offer.detach': 'Offerta separata dal prodotto',
  'offer.reattach': 'Offerta riassociata',
  'offer.relinked': 'Offerta spostata per cambio EAN nel listino',
  'offer.reactivated': 'Offerta tornata a listino',
  'product.override': 'Modifica manuale dei dati',
  'review.kept_separate': 'Revisione: prodotti mantenuti separati',
};
const REVERTIBLE = new Set(['product.merge', 'offer.detach', 'product.override']);

export default function ProductPage() {
  const { id } = useParams();
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['product', id], queryFn: () => api.get<ProductDetail>(`/api/products/${id}`) });
  const [imgIdx, setImgIdx] = useState(0);
  const [modal, setModal] = useState<null | 'override' | 'merge' | { detach: Offer }>(null);
  const [showInactive, setShowInactive] = useState(false);
  useDocumentTitle(q.data?.product?.title ?? 'Prodotto');

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['product'] });
    void qc.invalidateQueries({ queryKey: ['products'] });
  };
  const revert = useMutation({ mutationFn: (eventId: number) => api.post(`/api/audit/${eventId}/revert`, {}), onSuccess: invalidate });

  const offersBySupplier = useMemo(() => new Map((q.data?.offers ?? []).map((o) => [o.id, o.supplier.name])), [q.data]);
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <div className="page"><ErrorNotice error={q.error} /></div>;
  const d = q.data!;
  if (d.mergedInto) return <Navigate to={`/prodotti/${d.mergedInto}`} replace />;
  const p = d.product;
  const active = d.offers.filter((o) => o.active);
  const inactive = d.offers.filter((o) => !o.active);
  const bestId = p.bestPrice?.best?.offerId;
  const img = d.gallery[Math.min(imgIdx, d.gallery.length - 1)];
  const src = (field: string) => {
    const s = p.canonicalSources?.[field];
    if (!s) return null;
    if (s.manual) return 'modifica manuale';
    if (s.offerId) return offersBySupplier.get(s.offerId) ?? null;
    return null;
  };

  return (
    <div className="page">
      <nav className="small" aria-label="Percorso" style={{ marginBottom: 8 }}>
        <Link to="/">Catalogo</Link> › <span className="muted">Scheda prodotto</span>
      </nav>
      {d.reviews.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Notice kind="warning">
            Associazione da verificare:{' '}
            {d.reviews.map((r) => (
              <Link key={r.id} to={`/corrispondenze/${r.id}`} style={{ marginRight: 8 }}>
                confronto con “{r.other_title || 'altro prodotto'}”
              </Link>
            ))}
          </Notice>
        </div>
      )}
      <div className="product-layout">
        <div>
          <div className="gallery-main">{img ? <img src={imageUrl(img.id, 'display')} alt={`Immagine di ${p.title}`} /> : <span className="muted">Nessuna immagine disponibile</span>}</div>
          {img && (
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              Fonte immagine: {img.supplierName}
              {isAdmin && !img.searchable && ' · non ancora ricercabile per foto'}
            </p>
          )}
          {d.gallery.length > 1 && (
            <div className="gallery-thumbs" role="group" aria-label="Galleria">
              {d.gallery.map((g, i) => (
                <button key={g.id} aria-pressed={i === imgIdx} aria-label={`Immagine ${i + 1} di ${d.gallery.length} (${g.supplierName})`} onClick={() => setImgIdx(i)}>
                  <img src={imageUrl(g.id)} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
          {(d.images.pending > 0 || d.images.failed > 0) && (
            <p className="muted small">
              {d.images.pending > 0 && `${d.images.pending} immagini in scaricamento. `}
              {d.images.failed > 0 && `${d.images.failed} immagini non scaricabili dal fornitore.`}
            </p>
          )}
        </div>

        <div className="stack">
          <div className="card">
            <h1 style={{ margin: '0 0 4px', fontSize: 22 }}>{p.title}</h1>
            <p className="muted" style={{ margin: 0 }}>
              {p.brand ?? 'Marca non indicata'}
              {p.categoryName && ` · ${p.categoryName}`}
            </p>
            <div className="product-price" style={{ marginTop: 10 }}>
              <BestPriceBlock summary={p.bestPrice} />
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>
              {p.offerCount} {p.offerCount === 1 ? 'offerta attiva' : 'offerte attive'} da {p.supplierCount} {p.supplierCount === 1 ? 'fornitore' : 'fornitori'} · disponibile presso{' '}
              {p.availableSupplierCount} · dati aggiornati {ago(p.dataAsOf)}
            </p>
            {isAdmin && (
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btn-sm" onClick={() => setModal('override')}>
                  Correggi dati
                </button>
                <button className="btn btn-sm" onClick={() => setModal('merge')}>
                  Unisci con altro prodotto…
                </button>
              </div>
            )}
          </div>

          <div className="card">
            <h2>Dati del prodotto</h2>
            <dl className="kv">
              <dt>Titolo</dt>
              <dd>
                {p.title} {src('title') && <span className="muted small">— da {src('title')}</span>}
              </dd>
              <dt>Marca</dt>
              <dd>
                {p.brand ?? '—'} {src('brand') && <span className="muted small">— da {src('brand')}</span>}
              </dd>
              <dt>Categoria</dt>
              <dd>{p.categoryName ?? 'Non classificata'}</dd>
              <dt>EAN / GTIN</dt>
              <dd>
                {d.identifiers.length === 0
                  ? 'Nessun EAN valido: prodotto identificato solo dal codice fornitore'
                  : d.identifiers.map((i) => (
                      <div key={i.value}>
                        <span className="mono">{i.display}</span>{' '}
                        <span className="muted small">
                          {i.source === 'manual' ? `aggiunto manualmente${i.created_by ? ` da ${i.created_by}` : ''}` : 'dal listino'} il {dateTime(i.created_at)}
                        </span>
                      </div>
                    ))}
              </dd>
              {Object.entries(p.attributes).map(([k, v]) => (
                <FragmentKV key={k} label={ATTR_LABELS[k] ?? k} value={v} source={p.canonicalSources?.attributes?.[k] ? offersBySupplier.get(p.canonicalSources.attributes[k]) : null} />
              ))}
            </dl>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Precedenza dei dati: modifica manuale, poi fornitore con priorità più alta. Materiali e misure provengono dai listini, non dalle foto.
            </p>
          </div>
        </div>
      </div>

      <section className="card" style={{ marginTop: 16 }} aria-labelledby="offers-title">
        <div className="card-title">
          <h2 id="offers-title">Offerte dei fornitori</h2>
          <span className="muted small">Prezzi netti unitari confrontati solo quando valuta, IVA e confezione sono dichiarate. Spedizione e altri costi esclusi.</span>
        </div>
        {active.length === 0 && <Notice kind="info">Nessuna offerta attiva: il prodotto non è più presente nei listini correnti.</Notice>}
        <div className="table-wrap offers-table">
          <table className="data">
            <thead>
              <tr>
                <th>Fornitore</th>
                <th>Codice fornitore</th>
                <th>EAN nel listino</th>
                <th className="num">Prezzo listino</th>
                <th className="num">Netto / pz</th>
                <th>Confezione · MOQ</th>
                <th>Disponibilità</th>
                <th>Consegna</th>
                <th>Aggiornato</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              {(showInactive ? [...active, ...inactive] : active).map((o) => (
                <tr key={o.id} className={!o.active ? 'inactive' : o.id === bestId ? 'best' : undefined}>
                  <td>
                    <strong>{o.supplier.name}</strong>
                    {o.id === bestId && <div><span className="badge badge-ok">Miglior prezzo acquistabile</span></div>}
                    {!o.active && <div><span className="badge badge-neutral">Non più a listino</span></div>}
                    {o.linkSource !== 'gtin' && <div className="muted small">{LINK_LABELS[o.linkSource]}</div>}
                    {isAdmin && o.active && active.length > 1 && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setModal({ detach: o })}>
                        Separa…
                      </button>
                    )}
                  </td>
                  <td className="mono">{o.sku}</td>
                  <td>
                    <span className="mono">{o.barcode.raw ?? '—'}</span>
                    {o.barcode.status !== 'valid' && o.barcode.status !== 'missing' && <div className="small muted">{BARCODE_STATUS_LABELS[o.barcode.status]}</div>}
                  </td>
                  <td className="num">
                    {money(o.price, o.currency)}
                    <div className="small muted">{VAT_LABELS[o.vatTreatment]}{o.vatTreatment === 'gross' && o.vatRate ? ` ${Number(o.vatRate)}%` : ''}</div>
                  </td>
                  <td className="num">
                    {o.netUnitPrice ? money(o.netUnitPrice, o.currency) : '—'}
                    {!o.comparable && o.active && <div className="small muted">non confrontabile: {o.notComparableReasons.join(', ')}</div>}
                    {o.netDerivedFromGross && <div className="small muted">scorporata IVA</div>}
                  </td>
                  <td>
                    {o.unitsPerPack ? (o.unitsPerPack > 1 ? `${o.unitsPerPack} pz` : '1 pz') : 'non dichiarata'}
                    {o.salesUnit && <span className="muted small"> ({o.salesUnit})</span>}
                    {o.moq && <div className="small">minimo {o.moq}</div>}
                    {o.priceTiers?.length ? (
                      <div className="small muted">
                        {o.priceTiers.map((t) => `da ${t.minQty}: ${money(t.price, o.currency)}`).join(' · ')}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <StockBadge status={o.stockStatus} />
                    <div className="small muted">{stockText(o.stockStatus, o.stockQuantity)}</div>
                    {o.availabilityRaw && <div className="small muted">“{o.availabilityRaw}”</div>}
                  </td>
                  <td>{o.leadTimeRaw ?? (o.leadTimeDays !== null ? `${o.leadTimeDays} gg` : '—')}</td>
                  <td>
                    {dateTime(o.dataAsOf)}
                    {o.stale && <div><span className="badge badge-warn" title={o.staleReason ?? ''}>Non aggiornato</span></div>}
                  </td>
                  <td>
                    {o.productUrl ? (
                      <a href={o.productUrl} target="_blank" rel="noopener noreferrer">
                        Apri ↗
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="offer-cards">
          {(showInactive ? [...active, ...inactive] : active).map((o) => (
            <div key={o.id} className={`offer-card${o.id === bestId ? ' best' : ''}`}>
              <header>
                <strong>{o.supplier.name}</strong>
                <span className="price-main">{o.netUnitPrice ? money(o.netUnitPrice, o.currency) : money(o.price, o.currency)}</span>
              </header>
              {o.id === bestId && <span className="badge badge-ok">Miglior prezzo acquistabile</span>}
              {!o.active && <span className="badge badge-neutral">Non più a listino</span>}
              <dl className="kv small" style={{ marginTop: 6 }}>
                <dt>Prezzo listino</dt>
                <dd>{money(o.price, o.currency)} · {VAT_LABELS[o.vatTreatment]}</dd>
                <dt>Netto / pz</dt>
                <dd>{o.netUnitPrice ? money(o.netUnitPrice, o.currency) : `non confrontabile (${o.notComparableReasons.join(', ')})`}</dd>
                <dt>Confezione</dt>
                <dd>{o.unitsPerPack ? `${o.unitsPerPack} pz` : 'non dichiarata'}{o.moq ? ` · minimo ${o.moq}` : ''}</dd>
                <dt>Disponibilità</dt>
                <dd>{stockText(o.stockStatus, o.stockQuantity)}</dd>
                <dt>Consegna</dt>
                <dd>{o.leadTimeRaw ?? '—'}</dd>
                <dt>Codice</dt>
                <dd className="mono">{o.sku}</dd>
                <dt>Aggiornato</dt>
                <dd>{dateTime(o.dataAsOf)} {o.stale && <span className="badge badge-warn">Non aggiornato</span>}</dd>
              </dl>
              {o.productUrl && (
                <a className="btn btn-sm" style={{ marginTop: 8 }} href={o.productUrl} target="_blank" rel="noopener noreferrer">
                  Apri pagina fornitore ↗
                </a>
              )}
            </div>
          ))}
        </div>
        {inactive.length > 0 && (
          <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setShowInactive((v) => !v)} aria-expanded={showInactive}>
            {showInactive ? 'Nascondi' : 'Mostra'} {inactive.length} offerte non più a listino
          </button>
        )}
      </section>

      <section className="card" aria-labelledby="provenance-title">
        <h2 id="provenance-title">Provenienza dei dati</h2>
        {d.offers.map((o) => (
          <details key={o.id} style={{ marginBottom: 6 }}>
            <summary>
              {o.supplier.name} · <span className="mono">{o.sku}</span> · “{o.title ?? 'senza titolo'}” · {LINK_LABELS[o.linkSource]}
            </summary>
            <div className="small" style={{ padding: '8px 0 8px 16px' }}>
              <div>Marca nel listino: {o.brand ?? '—'} · Categoria del fornitore: {o.categoryRaw ?? '—'}{o.categoryName ? ` → ${o.categoryName}` : ''}</div>
              {o.description && <p style={{ whiteSpace: 'pre-line' }}>{o.description}</p>}
              <div>Visto per l’ultima volta: {dateTime(o.lastSeenAt)} {o.lastImportId && <Link to={`/importazioni/${o.lastImportId}`}>(import)</Link>}</div>
              {isAdmin && o.sourceRow && (
                <details>
                  <summary>Riga originale del file</summary>
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(o.sourceRow, null, 2)}</pre>
                </details>
              )}
            </div>
          </details>
        ))}
      </section>

      {d.history.length > 0 && (
        <section className="card" aria-labelledby="history-title">
          <h2 id="history-title">Storico associazioni e modifiche</h2>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            {d.history.map((h) => (
              <li key={h.id} style={{ marginBottom: 6 }}>
                <strong>{ACTION_LABELS[h.action] ?? h.action}</strong> · {dateTime(h.at)} · {h.actor_name ?? (h.actor_kind === 'import' ? 'import automatico' : 'sistema')}
                {h.reason && <span className="muted"> — “{h.reason}”</span>}
                {h.reverted_by_event_id && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>annullata</span>}
                {isAdmin && REVERTIBLE.has(h.action) && !h.reverted_by_event_id && !h.reverts_event_id && (
                  <button
                    className="btn btn-sm"
                    style={{ marginLeft: 8 }}
                    disabled={revert.isPending}
                    onClick={() => {
                      if (confirm('Annullare questa operazione? Le offerte e gli identificativi torneranno com’erano.')) revert.mutate(h.id);
                    }}
                  >
                    Annulla
                  </button>
                )}
              </li>
            ))}
          </ul>
          <ErrorNotice error={revert.error} />
        </section>
      )}

      {modal === 'override' && <OverrideModal detail={d} onClose={() => setModal(null)} onDone={invalidate} />}
      {modal === 'merge' && <MergeModal detail={d} onClose={() => setModal(null)} onDone={invalidate} />}
      {modal && typeof modal === 'object' && <DetachModal offer={modal.detach} onClose={() => setModal(null)} onDone={invalidate} />}
    </div>
  );
}

function FragmentKV({ label, value, source }: { label: string; value: string; source?: string | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value} {source && <span className="muted small">— da {source}</span>}
      </dd>
    </>
  );
}

function OverrideModal({ detail, onClose, onDone }: { detail: ProductDetail; onClose: () => void; onDone: () => void }) {
  const o = detail.product.overrides;
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api.get<{ items: Array<{ id: string; name: string }> }>('/api/categories') });
  const [title, setTitle] = useState(o.title ?? '');
  const [brand, setBrand] = useState(o.brand ?? '');
  const [categoryId, setCategoryId] = useState(o.categoryId ?? '');
  const [primaryImageId, setPrimaryImageId] = useState(o.primaryImageId ?? '');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api.patch(`/api/products/${detail.product.id}/overrides`, {
        title: title || null, brand: brand || null, categoryId: categoryId || null, primaryImageId: primaryImageId || null, reason: reason || undefined,
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Correggi i dati del prodotto"
      footer={
        <>
          <button className="btn" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={() => m.mutate()} disabled={m.isPending}>Salva</button>
        </>
      }
    >
      <div className="stack">
        <p className="muted small">I valori inseriti qui prevalgono sui listini e non vengono sovrascritti dagli import. Lascia vuoto per usare il dato del fornitore con priorità più alta.</p>
        <div className="field">
          <label htmlFor="ov-title">Titolo</label>
          <input id="ov-title" className="input" value={title} placeholder={detail.product.title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ov-brand">Marca</label>
          <input id="ov-brand" className="input" value={brand} placeholder={detail.product.brand ?? ''} onChange={(e) => setBrand(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ov-cat">Categoria</label>
          <select id="ov-cat" className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Automatica ({detail.product.categoryName ?? 'nessuna'})</option>
            {cats.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {detail.gallery.length > 1 && (
          <div className="field">
            <span style={{ fontWeight: 500, fontSize: 14 }}>Immagine principale</span>
            <div className="gallery-thumbs">
              <button aria-pressed={!primaryImageId} onClick={() => setPrimaryImageId('')} title="Automatica" style={{ fontSize: 12 }}>Auto</button>
              {detail.gallery.map((g) => (
                <button key={g.id} aria-pressed={primaryImageId === g.id} onClick={() => setPrimaryImageId(g.id)}>
                  <img src={imageUrl(g.id)} alt={`Immagine da ${g.supplierName}`} />
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="field">
          <label htmlFor="ov-reason">Motivazione (facoltativa)</label>
          <input id="ov-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <ErrorNotice error={m.error} />
      </div>
    </Modal>
  );
}

function MergeModal({ detail, onClose, onDone }: { detail: ProductDetail; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const results = useQuery({
    queryKey: ['merge-search', term],
    queryFn: () => api.get<CatalogPage>(`/api/products${qs({ q: term, limit: 12, withoutOffers: '1' })}`),
    enabled: term.length > 1,
  });
  const m = useMutation({
    mutationFn: () => api.post(`/api/products/${detail.product.id}/merge`, { sourceProductId: selected, reason }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  const selectedCard = results.data?.items.find((i) => i.id === selected);
  return (
    <Modal
      open
      onClose={onClose}
      wide
      title="Unisci un altro prodotto in questo"
      footer={
        <>
          <button className="btn" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" disabled={!selected || m.isPending} onClick={() => m.mutate()}>Unisci</button>
        </>
      }
    >
      <div className="stack">
        <Notice kind="warning">
          Unisci solo prodotti identici (stessa marca, variante e confezione) con un’evidenza concreta, ad esempio lo stesso codice del produttore. Varianti e multipack devono restare separati. L’operazione è annullabile dallo storico.
        </Notice>
        <form className="row" onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }}>
          <input className="input" style={{ flex: 1 }} aria-label="Cerca il prodotto da unire" placeholder="Nome, EAN o codice fornitore" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" type="submit">Cerca</button>
        </form>
        {results.isFetching && <Spinner />}
        <div className="stack" style={{ gap: 6 }}>
          {results.data?.items.filter((i) => i.id !== detail.product.id).map((i) => (
            <label key={i.id} className="checkbox card" style={{ padding: 8 }}>
              <input type="radio" name="merge-target" checked={selected === i.id} onChange={() => setSelected(i.id)} />
              {i.imageId && <img src={imageUrl(i.imageId)} alt="" width={48} height={48} style={{ objectFit: 'contain' }} />}
              <span>
                <strong>{i.title}</strong> <span className="muted small">{i.brand ?? ''} · {i.gtin ? `EAN ${i.gtin}` : 'senza EAN'} · {i.offerCount} offerte</span>
              </span>
            </label>
          ))}
        </div>
        {selectedCard && (
          <div className="field">
            <label htmlFor="merge-reason">Motivazione ed evidenze{selectedCard.gtin && detail.identifiers.length ? ' (obbligatoria: EAN diversi)' : ''}</label>
            <textarea id="merge-reason" className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="es. stesso codice produttore LL-2231, confermato dal fornitore via email del 12/09" />
          </div>
        )}
        <ErrorNotice error={m.error} />
      </div>
    </Modal>
  );
}

function DetachModal({ offer, onClose, onDone }: { offer: Offer; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/api/offers/${offer.id}/detach`, { reason }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Separa offerta"
      footer={
        <>
          <button className="btn" onClick={onClose}>Annulla</button>
          <button className="btn btn-danger" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>Separa</button>
        </>
      }
    >
      <div className="stack">
        <p>
          L’offerta <strong>{offer.supplier.name}</strong> · <span className="mono">{offer.sku}</span> diventerà un prodotto separato. Potrai annullare l’operazione dallo storico.
        </p>
        <div className="field">
          <label htmlFor="detach-reason">Motivazione</label>
          <input id="detach-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="es. variante diversa (50 ml invece di 100 ml)" />
        </div>
        <ErrorNotice error={m.error} />
      </div>
    </Modal>
  );
}
