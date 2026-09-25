# Stato di avanzamento — V1

Ultimo aggiornamento: 2026-09-25. Per riprendere il lavoro: leggere questo file e [DECISIONS.md](DECISIONS.md).

## Verificato (eseguito in questa sessione)

| Area | Evidenza |
|---|---|
| Ambiente locale | PostgreSQL 18.6 + pgvector 0.8.1 e SeaweedFS 4.47 in WSL Ubuntu (`scripts/dev/`), app Node 24 nativa su Windows ARM64 |
| Migrazioni | `pnpm migrate` idempotente (seconda esecuzione: nessuna modifica) |
| Encoder visivo reale | SigLIP 2 ONNX (rev. fissata, SHA-256 verificato), caricato in ~1,3-2 s, embedding reali di catalogo e query |
| Test unitari | 49/49: GTIN (zeri iniziali, check digit, UPC-A↔EAN-13, GTIN-14 confezione ≠ pezzo, RCN, notazione scientifica, UPC-E), decimali esatti, confrontabilità prezzi (casi F/G, IVA, valute, esaurito), stock nullo vs zero, parser CSV (cp1252, `;`, BOM, intestazioni duplicate), mappatura e template, SSRF (IP privati/metadata/IPv6 mappati, allowlist, redirect), barcode zxing |
| Test d'integrazione (Postgres reale) | 36/36: casi A, B, C, E, I, J; conflitti EAN in revisione; EAN corretto → offerta spostata; snapshot/delta/snapshot parziale; fuori ordine; SKU duplicati; concorrenza (4 import paralleli, un prodotto per GTIN); un solo import attivo per fornitore; unione/separazione/override reversibili; "prodotti diversi" ricordato; autorizzazioni per ruolo, CSRF, sessioni; ricerca per testo/refuso/EAN/SKU/filtri; aggregazione visiva con pgvector (caso D, niente monopolio di un prodotto con molte foto) |
| Test end-to-end | 6/6: login → import CSV+XLSX via API → worker reale (download, S3, embedding) → accorpamento → ricerca foto → confronto offerte → 403 per l'operatore → reimport idempotente |
| Demo | `pnpm demo:fixtures` + `demo:seed` + `demo:images` + `worker`: 36 prodotti, 62 offerte, 53 URL → 45 asset (8 deduplicati), 45/45 indicizzati, 1 conflitto EAN, 2 suggerimenti |
| UI (browser integrato) | Catalogo con filtri e stati, risultati foto (confermato via barcode, simili, feedback), scheda prodotto (desktop e mobile), importazioni, wizard, corrispondenze e dettaglio, stato del sistema |
| Benchmark | vedi [BENCHMARK.md](BENCHMARK.md): visivo sintetico (R@5 100% con ritaglio) e carico con 60.000 vettori (API p95 150 ms; foto p95 4,8 s con 5 utenti) |
| Typecheck | `tsc` pulito su server e web; build Vite riuscita |

## Implementato ma non eseguito

- `Dockerfile`, `docker-compose.yml`, `deploy/docker-compose.prod.yml` + Caddy: Docker Desktop non si avvia su questa macchina (D-009). Tag delle immagini verificati su Docker Hub, build mai eseguita.
- Procedura di backup e ripristino (`docs/OPERATIONS.md`): comandi scritti, ripristino non esercitato.
- Switch di modello `pnpm model:prepare` (registrazione, indice, reindicizzazione, attivazione): codice presente, flusso completo mai eseguito. Il meccanismo di coesistenza dei modelli è coperto indirettamente dal test di aggregazione (modello di test a 4 dimensioni).
- Upload di file dal wizard, fotocamera, scansione barcode live e incolla/trascina nel browser: componenti scritti e compilati; i percorsi server corrispondenti sono coperti dai test, ma l'interazione con il selettore file e la fotocamera non è automatizzabile qui ed è stata verificata solo nel rendering.
- Metriche Prometheus `/metrics`: implementate, non collegate a un sistema di monitoraggio.

## Bloccato o in attesa di dati

- **Qualità visiva reale**: servono listini e foto reali e un set di almeno 100 query etichettate (protocollo in BENCHMARK.md). Le soglie attuali **non sono calibrate**.
- **Connettori specifici dei fornitori**: servono documentazione e accessi (interfaccia pronta).
- **Hosting**: provider, dominio e budget non ancora decisi. Nessun servizio acquistato.
- **Docker Desktop** locale: si chiude all'avvio sui socket AF_UNIX (dopo `dockerInference`, `docker-secrets-engine`). Probabilmente serve un riavvio di Windows o una reinstallazione/aggiornamento di Docker Desktop.

## Prossimi passi consigliati

1. Importare 1-2 listini reali, verificare la mappatura e le regole IVA/confezione con un buyer.
2. Indicizzare un sottoinsieme (1.000-2.000 immagini) e misurare tempi e spazio reali.
3. Costruire il set di 100+ query reali, confrontare SigLIP 2 e CLIP, calibrare le soglie.
4. Deploy di staging (VM più S3), prova di backup e ripristino, e `bench:load` sull'hardware reale.
5. Revisione UX con gli operatori su smartphone: foto e codice a barre in magazzino.
