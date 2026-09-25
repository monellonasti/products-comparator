import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, imageUrl } from '../api';
import type { Candidate, PhotoSearchResult } from '../types';
import { AvailabilityLine, BestPriceBlock, ErrorNotice, Notice, Spinner, useDocumentTitle } from '../components/ui';
import { CropDialog, type RelativeCrop } from '../components/CropDialog';

const GROUPS: Array<{ key: Candidate['group']; title: string; hint: string }> = [
  { key: 'confirmed', title: 'Corrispondenza confermata', hint: 'Codice a barre letto nella foto e presente nel catalogo.' },
  { key: 'possible', title: 'Possibili corrispondenze', hint: 'Molto simili a foto del catalogo: verifica marca, variante e confezione prima di ordinare.' },
  { key: 'similar', title: 'Prodotti simili', hint: 'Alternative con aspetto simile: non sono lo stesso prodotto.' },
];

export default function PhotoResultsPage() {
  useDocumentTitle('Risultati ricerca per foto');
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const initial = (location.state as { result?: PhotoSearchResult } | null)?.result;
  const search = useQuery({
    queryKey: ['photo-search', id],
    queryFn: () => api.get<PhotoSearchResult>(`/api/search/photo/${id}`),
    initialData: initial?.searchId === id ? initial : undefined,
  });
  const [cropOpen, setCropOpen] = useState(false);
  const [sent, setSent] = useState<Record<string, string>>({});

  const recrop = useMutation({
    mutationFn: (crop: RelativeCrop | null) => api.post<PhotoSearchResult>(`/api/search/photo/${id}/recrop`, { crop }),
    onSuccess: (r) => {
      setCropOpen(false);
      navigate(`/ricerca/${r.searchId}`, { state: { result: r } });
    },
  });
  const feedback = useMutation({
    mutationFn: (b: { verdict: string; productId?: string }) => api.post(`/api/search/photo/${id}/feedback`, b),
    onSuccess: (_, b) => {
      setSent((s) => ({ ...s, [b.productId ?? 'global']: b.verdict }));
      void qc.invalidateQueries({ queryKey: ['photo-search', id] });
    },
  });

  if (search.isLoading) return <Spinner label="Caricamento risultati…" />;
  if (search.isError) return <div className="page"><ErrorNotice error={search.error} /></div>;
  const r = search.data!;
  const photoSrc = `/api/search/photo/${id}/image`;
  const imageAvailable = r.imageAvailable !== false;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Risultati della ricerca per foto</h1>
          <p>Somiglianza visiva, non certezza: la conferma arriva dal codice a barre o dalla verifica dei dati.</p>
        </div>
        <Link className="btn" to="/">
          Nuova ricerca
        </Link>
      </div>
      <div className="photo-results">
        <aside className="stack">
          <div className="query-photo">{imageAvailable ? <img src={photoSrc} alt="Foto cercata" /> : <span className="muted" style={{ padding: 40 }}>Foto non più conservata</span>}</div>
          {imageAvailable && (
            <button className="btn" onClick={() => setCropOpen(true)}>
              Ritaglia di nuovo e ricerca
            </button>
          )}
          {r.barcode && (
            <Notice kind={r.barcode.status === 'valid' ? 'info' : 'warning'}>
              Codice letto: <span className="mono">{r.barcode.text}</span>{' '}
              {r.barcode.status === 'valid'
                ? r.barcode.matchedProducts > 0
                  ? '(presente nel catalogo)'
                  : '(valido, ma nessun prodotto del catalogo ha questo EAN)'
                : r.barcode.status === 'restricted'
                  ? '(codice interno/negozio: non identifica il prodotto in modo univoco)'
                  : '(non valido: ignorato)'}
            </Notice>
          )}
          <button className="btn btn-danger" disabled={!!sent.global || feedback.isPending} onClick={() => feedback.mutate({ verdict: 'none_relevant' })}>
            {sent.global ? 'Segnalazione registrata' : 'Nessun risultato pertinente'}
          </button>
          <p className="muted small">
            Le segnalazioni servono a valutare la qualità della ricerca: non modificano il catalogo né uniscono prodotti.
            {r.imageExpiresAt && ` La foto viene cancellata automaticamente il ${new Date(r.imageExpiresAt).toLocaleDateString('it-IT')}.`}
          </p>
        </aside>

        <section className="stack" aria-live="polite">
          {r.status === 'provider_unavailable' && <Notice kind="warning">{r.message ?? 'Ricerca per immagine non disponibile.'}</Notice>}
          {r.coverage && r.coverage.pending > 0 && (
            <Notice kind="info">{r.coverage.pending.toLocaleString('it-IT')} immagini del catalogo sono ancora in elaborazione e non sono state considerate.</Notice>
          )}
          {r.model && !r.model.calibrated && r.candidates.length > 0 && (
            <p className="muted small">Classificazione provvisoria: le soglie di somiglianza non sono ancora state tarate su foto reali del vostro catalogo.</p>
          )}
          {r.status === 'ok' && r.abstained && (
            <div className="card empty">
              <h2>Nessuna corrispondenza affidabile</h2>
              <p>Il prodotto fotografato non sembra presente nel catalogo, oppure la foto non basta a riconoscerlo. Prova a ritagliare solo il prodotto, a fotografare l’etichetta o il codice a barre, oppure cerca per nome o EAN.</p>
            </div>
          )}
          {GROUPS.map((g) => {
            const list = r.candidates.filter((c) => c.group === g.key);
            if (!list.length) return null;
            return (
              <div key={g.key} className="result-group">
                <header>
                  <h2 style={{ margin: 0 }}>{g.title}</h2>
                  <span className="muted small">{g.hint}</span>
                </header>
                {list.map((c) => (
                  <article key={c.product.id} className="candidate">
                    <figure>
                      {c.product.imageId ? <img src={imageUrl(c.product.imageId)} alt="" loading="lazy" /> : <div className="muted small">Nessuna immagine</div>}
                      <figcaption>Scheda</figcaption>
                    </figure>
                    <figure className="matched">
                      {c.matchedImageId ? <img src={imageUrl(c.matchedImageId)} alt="" loading="lazy" /> : <div className="muted small">—</div>}
                      <figcaption>Immagine simile</figcaption>
                    </figure>
                    <div className="stack" style={{ gap: 6 }}>
                      <div>
                        <Link to={`/prodotti/${c.product.id}`} style={{ fontWeight: 600 }}>
                          {c.product.title}
                        </Link>
                        <div className="product-meta">
                          {c.product.brand && <span>{c.product.brand}</span>}
                          <span>{c.product.gtin ? `EAN ${c.product.gtin}` : 'EAN assente'}</span>
                          <span>
                            {c.product.supplierCount} {c.product.supplierCount === 1 ? 'fornitore' : 'fornitori'}
                          </span>
                        </div>
                      </div>
                      <div className="row" style={{ gap: 8 }}>
                        <AvailabilityLine card={c.product} />
                      </div>
                      <div className="product-price" style={{ paddingTop: 0 }}>
                        <BestPriceBlock summary={c.product.bestPrice} />
                      </div>
                      <ul className="evidence">
                        {c.evidence.map((e) => (
                          <li key={e.text}>{e.text}</li>
                        ))}
                      </ul>
                      <div className="row" style={{ gap: 6 }}>
                        <Link className="btn btn-sm btn-primary" to={`/prodotti/${c.product.id}`}>
                          Confronta offerte
                        </Link>
                        {sent[c.product.id] ? (
                          <span className="badge badge-neutral">Grazie, segnalazione registrata</span>
                        ) : (
                          <>
                            <button className="btn btn-sm" onClick={() => feedback.mutate({ verdict: 'correct', productId: c.product.id })}>
                              È questo
                            </button>
                            <button className="btn btn-sm" onClick={() => feedback.mutate({ verdict: 'wrong', productId: c.product.id })}>
                              Non è questo
                            </button>
                            {c.group === 'similar' && (
                              <button className="btn btn-sm" onClick={() => feedback.mutate({ verdict: 'useful_alternative', productId: c.product.id })}>
                                Alternativa utile
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            );
          })}
          <ErrorNotice error={feedback.error} />
        </section>
      </div>
      <CropDialog open={cropOpen} imageSrc={cropOpen ? photoSrc : null} busy={recrop.isPending} onCancel={() => setCropOpen(false)} onConfirm={(c) => recrop.mutate(c)} />
      {recrop.isError && <ErrorNotice error={recrop.error} />}
    </div>
  );
}
