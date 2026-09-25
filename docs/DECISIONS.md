# Registro decisioni (ADR sintetici)

Ogni voce: contesto → decisione → conseguenze. Le date sono assolute.

## D-001 · 2026-09-25 · Monolite modulare TypeScript + worker separato
- **Contesto**: una sola organizzazione, pochi utenti, carichi pesanti (import, download immagini, embedding) da isolare dalle richieste web.
- **Decisione**: un solo pacchetto Node 24 / TypeScript. Processo `server` (Fastify 5, API + SPA React/Vite compilata) e processo `worker` (graphile-worker). Il codice di dominio è condiviso (`src/domain`, `src/imports`, `src/vision`).
- **Conseguenze**: un solo deploy da scalare in verticale; il worker si replica aumentando `WORKER_CONCURRENCY` o le istanze. Nessun microservizio.

## D-002 · 2026-09-25 · Node esegue TypeScript nativamente (type stripping)
- Node 24 esegue `.ts` senza transpiler. Vincolo: solo sintassi "erasable" (niente `enum`, namespace o parameter properties). `tsc --noEmit` (TypeScript 7) serve solo per il typecheck. Niente ts-node/tsx.

## D-003 · 2026-09-25 · Coda persistente su PostgreSQL (graphile-worker), niente Redis
- **Motivazione**: persistenza e backup già coperti da Postgres; i job si accodano **nella stessa transazione** dei dati (`graphile_worker.add_job`), quindi non ci sono job orfani né perdite; retry con backoff esponenziale; code nominate serializzate (per host e per shard di embedding); `job_key` per deduplicare.
- **Conseguenze**: un servizio in meno. Oltre ~1000 job/s servirebbe rivalutare la scelta, ma è molto sopra il fabbisogno.

## D-004 · 2026-09-25 · PostgreSQL 18 + pgvector 0.8 (HNSW) + full-text/trigram
- Vettori in `image_embeddings.embedding` (tipo `vector` non dimensionato) con **indice HNSW parziale per modello** su cast di dimensione: più modelli convivono durante uno switch.
- Ricerca con `hnsw.iterative_scan = relaxed_order` e oversampling (K=200 immagini → aggregazione per prodotto) per non perdere recall quando si filtra dopo l'ANN.
- Testo: `tsvector('simple')` + `unaccent` + `pg_trgm`, perché i titoli mescolano lingue e marchi.

## D-005 · 2026-09-25 · Storage S3-compatibile; SeaweedFS in locale
- MinIO community è archiviato (aprile 2026), quindi in locale uso SeaweedFS 4.47 (Apache-2.0). In produzione va bene qualsiasi S3 (AWS, R2, Hetzner, Scaleway…).
- Bucket privato: le immagini passano dall'API con controllo di sessione. Chiavi content-addressed (`img/<sha[0:2]>/<sha>/…`), quindi cache `immutable`.
- Driver `fs` per test e installazioni su singola macchina.

## D-006 · 2026-09-25 · Encoder visivo: SigLIP 2 base patch16-224 (ONNX, locale)
- **Scelta V1**: `google/siglip2-base-patch16-224` (Apache-2.0), export ONNX `onnx-community/siglip2-base-patch16-224-ONNX` rev. `ba1f3b0843f24bc5417d38e19c37b287d719b2f4`, `vision_model.onnx` fp32 (372 MB), embedding a 768 dimensioni, eseguito in-process con Transformers.js 4.3 / onnxruntime-node 1.30 (CPU). Le foto non escono dall'azienda.
- **Prove (2026-09-25, Snapdragon X Elite, a batteria, piano "Bilanciato", carico di fondo ~58%)**: su 6 prodotti sintetici con query "tipo smartphone" (rotazione, sfocatura, sfondo), SigLIP2 6/6 top-1 con margine 0,85-0,89 contro ≤0,73; CLIP B/32 6/6 con margine minore; DINOv2-small 4/6 (confonde varianti di colore). Latenza SigLIP2 ~0,8-1,0 s/immagine con 2-4 thread (peggiora con più thread); CLIP B/32 43-430 ms a seconda del carico. Variante q8 scartata (coseno 0,93-0,97 rispetto a fp32). **Sono fixture sintetiche: non misurano la qualità reale.**
- **Alternativa registrata**: `clip-vit-b32` (OpenAI CLIP, MIT), molto più veloce, da confrontare con `pnpm bench:visual` sui dati reali prima di indicizzare tutte le 60.000 immagini.
- **Conseguenze**: l'interfaccia `ImageEmbedder` isola il modello. Ogni cambio di modello crea un nuovo indice, reindicizza e fa uno switch controllato (`embedding_models.status`).

## D-007 · 2026-09-25 · Identità prodotto
- GTIN canonico = forma a 14 cifre (padding a sinistra). Una sola riga `product_identifiers(kind='gtin', value)` per GTIN (vincolo UNIQUE) più advisory lock per GTIN durante l'import.
- I codici a circolazione limitata (prefissi 02x/04x/05x/2xx, coupon, RCN-8) sono validi ma **non** si accorpano automaticamente.
- Stesso GTIN ma marca o attributi di variante in conflitto: l'offerta finisce in un prodotto separato con `link_source='conflict_hold'` e viene aperta una revisione. Nessun campo viene sovrascritto.

## D-008 · 2026-09-25 · Import: staging + batch con checkpoint
- Il file originale va nello storage, le righe grezze in `import_staging_rows`. L'applicazione procede a batch da 500 righe, ciascuno in una transazione che salva anche il checkpoint, quindi un retry riprende dal punto in cui si era fermato.
- Upsert per `(supplier_id, supplier_sku)`, righe invariate riconosciute da `row_hash`. Guardia contro import fuori ordine su `source_as_of`. Al massimo un import attivo per fornitore (indice unico parziale più coda serializzata).
- Disattivazione degli assenti solo con **snapshot** riuscito e con i vincoli di sicurezza descritti in docs/IMPORTS.md.

## D-009 · 2026-09-25 · Docker Desktop non avviabile sulla macchina di sviluppo
- Docker Desktop 4.78 (Windows ARM64) si chiude all'avvio: i socket AF_UNIX (`dockerInference`, `docker-secrets-engine/engine.sock`) risultano inaccessibili per Win32. `docker-compose.yml` resta l'ambiente di riferimento. Per verificare in questa sessione: PostgreSQL 18.6 + pgvector 0.8.1 via apt e SeaweedFS 4.47 nella distro WSL Ubuntu 26.04 (script in `scripts/dev/`), app Node nativa su Windows.

## D-010 · 2026-09-25 · Concorrenza dell'inferenza e lettura barcode fuori dall'event loop
- Semaforo per processo (`VISION_CONCURRENCY`, default 2) con `VISION_THREADS` (default 2) thread intra-op per inferenza. Regola: `THREADS × CONCURRENCY ≤ vCPU`. Le sessioni ONNX Runtime accettano esecuzioni concorrenti.
- zxing-wasm gira in un pool di 2 worker thread: una decodifica costa ~0,4 s di CPU, che prima bloccava l'event loop dell'API. I worker tengono vivo il processo solo con richieste in corso.
- Nella ricerca per foto, salvataggio della foto, lettura barcode ed embedding/ANN sono eseguiti in parallelo.
- Esito misurato (60.000 vettori, 5 utenti concorrenti, laptop a batteria): p95 lato server da 6,1 s a 4,8 s.

## D-011 · 2026-09-25 · Ricerca per codice con lookup indicizzate preliminari
- SKU esatto, GTIN (identificativi e offerte) e barcode grezzo vengono cercati prima, con indici; la query del catalogo filtra poi per `p.id = ANY(...)`. Le sottoquery correlate in `OR` forzavano scansioni sequenziali (EAN: 1,2 s → 16 ms su 60.000 prodotti).
- Testo: `tsvector('simple')` con prefissi più word-similarity trigram (`%>`, espressione indicizzata a sinistra) per tollerare i refusi.

## D-012 · 2026-09-25 · Validazione degli id e rate limit
- Gli id nelle route si validano come GUID generico (`z.guid()`), non come UUID RFC con i bit di versione: Postgres accetta qualunque UUID a 128 bit (id importati o migrati).
- Rate limit per utente autenticato, per IP solo come ripiego: un ufficio dietro un unico NAT non deve condividere un limite.

## D-013 · 2026-09-25 · File statici della SPA
- `@fastify/static` risolve i file a ogni richiesta (`wildcard: true`): una nuova build viene servita senza riavvio. Asset con hash `immutable`, `index.html` `no-cache`. Un percorso con estensione mancante riceve 404 e mai l'HTML della SPA, che il browser rifiuterebbe come modulo JS.

## D-014 · 2026-09-25 · Verifica UI senza credenziali nel browser
- Durante lo sviluppo le schermate autenticate sono state verificate nel browser integrato tramite un proxy locale (fuori dal repository) che ottiene la sessione via API. Nessuna password viene digitata in campi web dall'agente. Il login dal form è stato verificato solo nel rendering; il flusso di login è coperto dai test API.
