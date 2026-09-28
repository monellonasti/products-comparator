# Stato di avanzamento — V1

Ultimo aggiornamento: 2026-09-28 (`pnpm dev`, immagini sostituite allo stesso indirizzo, cambio di modello provato per intero, protezione XLSX, demo neutra e screenshot per il portfolio). Per riprendere il lavoro: leggere questo file e [DECISIONS.md](DECISIONS.md).

## Verificato (eseguito in questa sessione)

| Area | Evidenza |
|---|---|
| Ambiente locale | PostgreSQL 18.6 + pgvector 0.8.1 e SeaweedFS 4.47 in WSL Ubuntu (`scripts/dev/`), app Node 24 nativa su Windows ARM64 |
| Migrazioni | `pnpm migrate` idempotente (seconda esecuzione: nessuna modifica) |
| Encoder visivo reale | SigLIP 2 ONNX (rev. fissata, SHA-256 verificato), caricato in ~1,3-2 s, embedding reali di catalogo e query |
| Feed automatici + report variazioni (2026-09-27) | Dal vivo sul DB demo: configurazione del feed di Alfa (URL con token cifrato, mai restituito dall'API), "Aggiorna ora" → 7 variazioni attese (prezzi +9,99% e −8,01%, esaurito, quantità, immagine aggiunta, uscita, nuova offerta); esecuzione **pianificata** tramite il tick del worker → import riuscito, 0 variazioni su file identico, prossima esecuzione alle 06:00 ora italiana. UI verificata: pannello feed, pagina Variazioni, variazioni nella scheda prodotto |
| Immagini sostituite allo stesso indirizzo (2026-09-28) | Dal vivo sul DB demo: immagine demo sostituita mantenendo l'URL, feed di Alfa → 24 immagini ricontrollate (richieste condizionali, ETag salvati), 1 sostituita → variazione "Immagine sostituita" sulle 3 offerte che la usano, con miniature prima/dopo nella pagina Variazioni e nell'export CSV; nuova immagine indicizzata. Ripristino dell'originale → nuova variazione e ritorno all'asset originale (nessun ricalcolo dei vettori). Il server demo risponde 304 alle richieste condizionali |
| Cambio di modello (2026-09-28) | Eseguito per intero sul DB demo: `model:prepare` CLIP (46/46 immagini in 40 s, indice HNSW separato, ricerca rimasta su SigLIP durante la costruzione) → `--activate` → ricerca per foto via API con CLIP, senza riavvio → immagine nuova aggiunta con CLIP attivo (indicizzata solo per CLIP) → ritorno a SigLIP: attivazione rifiutata finché manca un vettore, `model:prepare` lo calcola, poi attivazione. Benchmark sintetico SigLIP identico prima e dopo. Trovato e corretto un difetto: un modello ritirato non tornava a indicizzare le immagini nuove (D-019) |
| `pnpm dev` (2026-09-28) | API, worker e Vite in un terminale; proxy `/api` verificato; se un processo termina gli altri vengono fermati, con chiusura dell'intero albero di processi su Windows (nessun processo residuo sulle porte 3000/5173) |
| Demo neutra e screenshot (2026-09-28) | Demo rigenerata con catalogo neutro (39 prodotti, 65 offerte, 46 immagini distinte, 3 gemelli OEM a marchio del grossista, prezzi con differenze fino al 31% tra fornitori) e database demo ricreato; feed del giorno 2 e un'immagine sostituita per popolare le variazioni. Benchmark visivo rifatto sul nuovo set (R@5 92,9% intera, 100% con ritaglio). 16 screenshot desktop e mobile catturati con Playwright e verificati uno per uno, più 7 immagini esplicative (5 schermate annotate, il flusso in 4 passi, il prima e dopo); 10 versioni leggere in `docs/screenshots/` per il README |
| Protezione XLSX (2026-09-28) | Misurato su listini realistici da 15 colonne: ExcelJS usa ~15 MB di RAM per MB decompresso (100.000 righe: 8,3 MB di file, 90 MB decompressi, ~1,3 GB di picco); il controllo preventivo costa ~5% del tempo di lettura. Senza protezione un file da 286 KB che si espande a 300 MB veniva letto per intero, e una dimensione falsificata veniva scoperta solo dopo aver decompresso tutto. Dal vivo via API: listino da 10.000 righe accettato (1,2 s); "bomba" da 147 KB → 150 MB e bomba con dimensione falsificata rifiutate in 0,06 s con messaggio chiaro, import annullato e file rimosso dallo storage. ExcelJS rifiuta già da sé le entità definite in una DTD: il controllo sulla DTD è una difesa aggiuntiva |
| Test unitari | 69/69 (7 nuovi sulla protezione XLSX: file ExcelJS e XLSX minimo accettati, zip bomb, dimensioni falsificate in più e in meno, DTD anche in UTF-16, troppe parti, parti cifrate, compressione non supportata, archivi danneggiati, ZIP64; 13 sui feed: pianificazione con ora legale, cifratura e manomissioni, calcolo variazioni, credenziali non inoltrate su redirect cross-origin) — prima 49/49: GTIN (zeri iniziali, check digit, UPC-A↔EAN-13, GTIN-14 confezione ≠ pezzo, RCN, notazione scientifica, UPC-E), decimali esatti, confrontabilità prezzi (casi F/G, IVA, valute, esaurito), stock nullo vs zero, parser CSV (cp1252, `;`, BOM, intestazioni duplicate), mappatura e template, SSRF (IP privati/metadata/IPv6 mappati, allowlist, redirect), barcode zxing |
| Test d'integrazione (Postgres reale) | 48/48 (1 nuovo: XLSX "bomba" rifiutato all'upload con import annullato e file rimosso; 4 sul ricontrollo delle immagini: 304, byte identici senza ETag, immagine sostituita su più offerte con prima/dopo e contatori, errore che conserva l'immagine; 7 sui feed: segreti cifrati, credenziali solo in HTTPS, variazioni complete, file identico, download fallito con ritentativo, mappatura mancante, rinvio, pianificatore) — prima 36/36: casi A, B, C, E, I, J; conflitti EAN in revisione; EAN corretto → offerta spostata; snapshot/delta/snapshot parziale; fuori ordine; SKU duplicati; concorrenza (4 import paralleli, un prodotto per GTIN); un solo import attivo per fornitore; unione/separazione/override reversibili; "prodotti diversi" ricordato; autorizzazioni per ruolo, CSRF, sessioni; ricerca per testo/refuso/EAN/SKU/filtri; aggregazione visiva con pgvector (caso D, niente monopolio di un prodotto con molte foto) |
| Test end-to-end | 6/6: login → import CSV+XLSX via API → worker reale (download, S3, embedding) → accorpamento → ricerca foto → confronto offerte → 403 per l'operatore → reimport idempotente |
| Demo | `pnpm demo:fixtures` + `demo:seed` + `demo:images` + `worker`: 36 prodotti, 62 offerte, 53 URL → 45 asset (8 deduplicati), 45/45 indicizzati, 1 conflitto EAN, 2 suggerimenti |
| UI (browser integrato) | Catalogo con filtri e stati, risultati foto (confermato via barcode, simili, feedback), scheda prodotto (desktop e mobile), importazioni, wizard, corrispondenze e dettaglio, stato del sistema |
| Benchmark | vedi [BENCHMARK.md](BENCHMARK.md): visivo sintetico (R@5 100% con ritaglio) e carico con 60.000 vettori (API p95 150 ms; foto p95 4,8 s con 5 utenti) |
| Typecheck | `tsc` pulito su server e web; build Vite riuscita |

## Implementato ma non eseguito

- `Dockerfile`, `docker-compose.yml`, `deploy/docker-compose.prod.yml` + Caddy: Docker Desktop non si avvia su questa macchina (D-009). Tag delle immagini verificati su Docker Hub, build mai eseguita.
- Procedura di backup e ripristino (`docs/OPERATIONS.md`): comandi scritti, ripristino non esercitato.
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
3. Costruire il set di 100+ query reali, confrontare SigLIP 2 e CLIP (procedura di cambio modello già provata), calibrare le soglie.
4. Deploy di staging (VM più S3), prova di backup e ripristino, e `bench:load` sull'hardware reale.
5. Revisione UX con gli operatori su smartphone: foto e codice a barre in magazzino.
