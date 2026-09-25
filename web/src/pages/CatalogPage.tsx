import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import type { CatalogPage as CatalogPageData, Facets } from '../types';
import { PhotoSearchBox } from '../components/PhotoSearchBox';
import { ErrorNotice, Notice, ProductCardView, Spinner, useDocumentTitle } from '../components/ui';

const PAGE = 48;
const FILTER_KEYS = ['suppliers', 'brand', 'category', 'priceMin', 'priceMax', 'availability', 'gtin', 'image', 'sort'] as const;

interface CatalogStatus {
  products: number;
  importsRunning: number;
  suppliersWithFailedImport: number;
  imagesProcessing: number;
  photoSearch: 'ready' | 'starting' | 'unavailable';
}

export function CatalogPage() {
  useDocumentTitle('Catalogo');
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const q = params.get('q') ?? '';
  const filters = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])), [params]);
  const activeFilters = FILTER_KEYS.filter((k) => k !== 'sort' && filters[k]).length;

  const status = useQuery({ queryKey: ['catalog-status'], queryFn: () => api.get<CatalogStatus>('/api/catalog/status'), refetchInterval: 20_000 });
  const facets = useQuery({ queryKey: ['facets'], queryFn: () => api.get<Facets>('/api/catalog/facets'), staleTime: 60_000 });
  const list = useInfiniteQuery({
    queryKey: ['products', q, filters],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.get<CatalogPageData>(`/api/products${qs({ q, ...filters, offset: pageParam, limit: PAGE })}`, { signal }),
    getNextPageParam: (last) => (last.offset + last.items.length < Math.min(last.total, 10_000) ? last.offset + last.items.length : undefined),
  });

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: key !== 'q' });
  };

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
    }, { rootMargin: '600px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [list.hasNextPage, list.isFetchingNextPage, list.fetchNextPage]);

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const mode = list.data?.pages[0]?.mode;
  const st = status.data;
  const catalogEmpty = st && st.products === 0 && !q && activeFilters === 0;

  return (
    <div className="page">
      <PhotoSearchBox onTextSearch={(v) => setParam('q', v)} initialText={q} />

      <div className="stack" style={{ marginBottom: 12 }}>
        {st?.photoSearch === 'unavailable' && (
          <Notice kind="warning">La ricerca per foto è temporaneamente non disponibile. Catalogo, ricerca per testo, EAN e codice fornitore funzionano normalmente.</Notice>
        )}
        {st?.photoSearch === 'starting' && <Notice kind="info">La ricerca per foto è in avvio: sarà disponibile tra pochi secondi.</Notice>}
        {st && st.importsRunning > 0 && <Notice kind="info">Aggiornamento listini in corso: alcuni dati potrebbero cambiare nei prossimi minuti.</Notice>}
        {st && st.imagesProcessing > 0 && (
          <Notice kind="info">{st.imagesProcessing.toLocaleString('it-IT')} immagini in elaborazione: finché non sono pronte, quei prodotti si trovano per testo o codice ma non ancora per foto.</Notice>
        )}
        {st && st.suppliersWithFailedImport > 0 && (
          <Notice kind="warning">
            L’ultimo aggiornamento di {st.suppliersWithFailedImport} {st.suppliersWithFailedImport === 1 ? 'fornitore è fallito' : 'fornitori è fallito'}: i relativi prezzi e disponibilità potrebbero non essere aggiornati.{' '}
            <Link to="/importazioni?status=failed">Vedi importazioni</Link>
          </Notice>
        )}
      </div>

      {catalogEmpty ? (
        <div className="card empty">
          <h2>Il catalogo è vuoto</h2>
          <p>Per iniziare serve almeno un fornitore con un listino importato.</p>
          {isAdmin ? (
            <div className="row" style={{ justifyContent: 'center' }}>
              <Link className="btn" to="/fornitori">
                Crea un fornitore
              </Link>
              <Link className="btn btn-primary" to="/importazioni/nuova">
                Importa un listino
              </Link>
            </div>
          ) : (
            <p className="muted">Chiedi a un amministratore di importare i listini dei fornitori.</p>
          )}
        </div>
      ) : (
        <div className="catalog-layout">
          <aside className={`card filters${filtersOpen ? '' : ' collapsed'}`} aria-label="Filtri">
            <div className="row">
              <h2 style={{ margin: 0 }}>Filtri {activeFilters > 0 && <span className="badge badge-info">{activeFilters}</span>}</h2>
              <span className="spacer" />
              <button className="btn btn-sm filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
                {filtersOpen ? 'Nascondi' : 'Mostra'}
              </button>
            </div>
            <div className="filters-body" style={{ marginTop: 12 }}>
              <div className="field">
                <label htmlFor="f-supplier">Fornitore</label>
                <select id="f-supplier" className="input" value={filters.suppliers} onChange={(e) => setParam('suppliers', e.target.value)}>
                  <option value="">Tutti</option>
                  {facets.data?.suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.products})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="f-brand">Marca</label>
                <select id="f-brand" className="input" value={filters.brand} onChange={(e) => setParam('brand', e.target.value)}>
                  <option value="">Tutte</option>
                  {facets.data?.brands.map((b) => (
                    <option key={b.brand} value={b.brand}>
                      {b.brand} ({b.products})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="f-category">Categoria</label>
                <select id="f-category" className="input" value={filters.category} onChange={(e) => setParam('category', e.target.value)}>
                  <option value="">Tutte</option>
                  {facets.data?.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.products})
                    </option>
                  ))}
                </select>
              </div>
              <fieldset className="field" style={{ border: 0, padding: 0, margin: '12px 0 0' }}>
                <legend style={{ fontWeight: 500, fontSize: 14, marginBottom: 4 }}>Prezzo netto unitario (€)</legend>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <input aria-label="Prezzo minimo" className="input" inputMode="decimal" placeholder="da" defaultValue={filters.priceMin} onBlur={(e) => setParam('priceMin', e.target.value.replace(',', '.'))} />
                  <input aria-label="Prezzo massimo" className="input" inputMode="decimal" placeholder="a" defaultValue={filters.priceMax} onBlur={(e) => setParam('priceMax', e.target.value.replace(',', '.'))} />
                </div>
              </fieldset>
              <div className="field">
                <label htmlFor="f-avail">Disponibilità</label>
                <select id="f-avail" className="input" value={filters.availability} onChange={(e) => setParam('availability', e.target.value)}>
                  <option value="">Qualsiasi</option>
                  <option value="available">Disponibile presso almeno un fornitore</option>
                  <option value="unavailable">Non disponibile o non dichiarata</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="f-gtin">EAN</label>
                <select id="f-gtin" className="input" value={filters.gtin} onChange={(e) => setParam('gtin', e.target.value)}>
                  <option value="">Qualsiasi</option>
                  <option value="present">Con EAN valido</option>
                  <option value="absent">Senza EAN valido</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="f-image">Immagini</label>
                <select id="f-image" className="input" value={filters.image} onChange={(e) => setParam('image', e.target.value)}>
                  <option value="">Qualsiasi</option>
                  <option value="with">Con immagini</option>
                  <option value="without">Senza immagini</option>
                </select>
              </div>
              {activeFilters > 0 && (
                <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => setParams(q ? { q } : {})}>
                  Azzera filtri
                </button>
              )}
            </div>
          </aside>

          <section aria-labelledby="results-title">
            <div className="results-bar">
              <h2 id="results-title" style={{ margin: 0 }} aria-live="polite">
                {list.isLoading ? 'Caricamento…' : `${total >= 10_000 ? 'oltre 10.000' : total.toLocaleString('it-IT')} prodotti`}
                {q && <span className="muted"> per “{q}”{mode === 'code' ? ' (codice)' : ''}</span>}
              </h2>
              <span className="spacer" />
              <label htmlFor="sort" className="small">
                Ordina
              </label>
              <select id="sort" className="input" style={{ width: 'auto' }} value={filters.sort} onChange={(e) => setParam('sort', e.target.value)}>
                <option value="">{q ? 'Pertinenza' : 'Nome'}</option>
                <option value="title">Nome</option>
                <option value="price">Prezzo più basso</option>
                <option value="updated">Aggiornati di recente</option>
              </select>
            </div>
            {list.isError ? (
              <div className="stack">
                <ErrorNotice error={list.error} />
                <button className="btn" onClick={() => void list.refetch()}>
                  Riprova
                </button>
              </div>
            ) : list.isLoading ? (
              <Spinner />
            ) : items.length === 0 ? (
              <div className="card empty">
                <h2>Nessun prodotto trovato</h2>
                <p>
                  {q ? 'Prova con meno parole, un EAN completo o il codice del fornitore.' : 'Nessun prodotto corrisponde ai filtri selezionati.'}
                  {activeFilters > 0 && ' Puoi anche azzerare i filtri.'}
                </p>
              </div>
            ) : (
              <>
                <div className="product-grid">
                  {items.map((p) => (
                    <ProductCardView key={p.id} card={p} />
                  ))}
                </div>
                <div ref={sentinel} className="load-more">
                  {list.hasNextPage ? (
                    <button className="btn" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                      {list.isFetchingNextPage ? 'Caricamento…' : 'Carica altri prodotti'}
                    </button>
                  ) : total > 10_000 ? (
                    <span className="muted">Affina la ricerca o usa i filtri per vedere altri prodotti.</span>
                  ) : null}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
