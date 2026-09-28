# Benchmark

> **Tutti i risultati qui sotto sono su dati SINTETICI.** Dimostrano che la pipeline funziona e misurano latenze e carico. **Non** dimostrano la qualità della ricerca visiva sul catalogo reale, che resta **da validare** con il protocollo in fondo. I report completi sono in `docs/benchmarks/`.

## Hardware e condizioni delle misure (2026-09-25)

Laptop Snapdragon X Elite X1E80100 (12 core Oryon, ARM64), 15,6 GB di RAM, Windows 11, Node 24.15 nativo ARM64. PostgreSQL 18.6 + pgvector 0.8.1 e SeaweedFS 4.47 nella VM WSL2 (Ubuntu 26.04), raggiunti via port forwarding: ogni round-trip al DB costa più che su un server. Macchina **a batteria** con piano "Bilanciato" e altri processi attivi (browser, API e worker di sviluppo). Le misure hanno una varianza alta tra un'esecuzione e l'altra: l'ANN da solo ha dato p95 38 ms in un run e 269 ms in un altro. Vanno ripetute sull'hardware di produzione.

## 1. Qualità visiva sul set sintetico (`pnpm bench:visual`)

**Aggiornamento 2026-09-28: demo neutra.** La demo è stata rigenerata con un catalogo neutro (cura della persona, igiene, piccoli elettrodomestici, accessori), prezzi realistici tra fornitori e 3 gemelli OEM a marchio del grossista. Stessa struttura: 19 foto sintetiche, 14 a catalogo (2 con barcode leggibile) e 5 fuori catalogo, 47 immagini indicizzate, leakage 0. Report: `docs/benchmarks/2026-09-28-visual-synthetic-neutral-*.json`.

| Metrica (SigLIP 2) | Foto intera | Con ritaglio |
|---|---|---|
| Recall@1 (EAN esatto) | 71,4% | 78,6% |
| Recall@5 (EAN esatto) | 92,9% | 100% |
| Falsi match sui fuori catalogo (score ≥ 0,78) | 0/5 | 0/5 |
| Astensione completa sui fuori catalogo (score < 0,55) | 0/5 | 0/5 |
| Barcode letti / conferme corrette | 2 / 1 | 2 / 1 |
| Score top-1 corretti (min/med/max) | 0,703 / 0,777 / 0,869 | 0,801 / 0,863 / 0,914 |
| Score top-1 negativi (min/med/max) | 0,627 / 0,677 / 0,700 | 0,550 / 0,671 / 0,772 |
| Inferenza p50/p95 | 811 / 966 ms | 812 / 961 ms |

Gemelli OEM (stesso prodotto con marchio ed EAN del grossista): nella ricerca con la foto dell'originale compaiono tra i "Prodotti simili" nelle posizioni 5, 7 e 11 su 24, non in cima. Il modello pesa anche il marchio stampato sul prodotto: da verificare sulle foto reali.

Le tabelle che seguono si riferiscono al set sintetico precedente (2026-09-25), con un catalogo del settore reale.

Catalogo demo: 36 prodotti, 45 immagini indicizzate (SigLIP 2, `siglip2-base-p16-224@ba1f3b0/pp1`). Query: 19 foto sintetiche "tipo smartphone" (sfondo texture, rotazione fino a ±18°, prospettiva, sfocatura, JPEG 62-78), di cui 14 di prodotti a catalogo (2 primi piani con barcode leggibile) e 5 di oggetti assenti. Leakage 0: nessuna query è byte-identica a un'immagine indicizzata.

| Metrica | Foto intera | Con ritaglio del prodotto |
|---|---|---|
| Recall@1 (EAN esatto) | 64,3% | **85,7%** |
| Recall@5 (EAN esatto) | 92,9% | **100%** |
| Recall@1 (accettando le varianti che condividono la foto) | 71,4% | 85,7% |
| Falsi match sui fuori catalogo (score ≥ 0,78 "possibile") | 0/5 | 0/5 |
| Astensione completa sui fuori catalogo (score < 0,55) | 1/5 | 1/5 |
| Barcode letti / conferme corrette | 2 / 1 (l'altro EAN non è in nessun listino: correttamente non confermato) | 2 / 1 |
| Score top-1 corretti (min/med/max) | 0,660 / 0,713 / 0,757 | 0,748 / 0,817 / 0,860 |
| Score top-1 negativi (min/med/max) | 0,542 / 0,639 / 0,696 | 0,550 / 0,578 / 0,749 |
| Inferenza p50/p95 | 923 / 1068 ms | 900 / 983 ms |

Cosa emerge (su dati sintetici):
- il ritaglio del prodotto migliora molto il risultato, e per questo l'interfaccia lo propone prima di ogni ricerca;
- con la soglia provvisoria 0,78 non ci sono falsi match, ma con la foto intera anche i prodotti giusti restano "simili" (score < 0,78): **le soglie vanno calibrate su foto reali**;
- i fuori catalogo ottengono comunque alternative "simili" perché hanno forme simili a prodotti presenti. È il comportamento voluto dal caso H (alternative esplicitamente simili, nessuna identità dichiarata).

### Confronto con CLIP B/32 (2026-09-28, stesso set sintetico)

Eseguito durante la prova del cambio di modello (`pnpm model:prepare`), stesso catalogo demo (46 immagini) e stesse 19 query. Ciascun modello con le proprie soglie provvisorie (SigLIP 2: 0,78/0,55; CLIP: 0,85/0,70). Report: `docs/benchmarks/2026-09-28-visual-synthetic-clip-*.json`.

| Metrica | SigLIP 2, foto intera | CLIP, foto intera | SigLIP 2, ritaglio | CLIP, ritaglio |
|---|---|---|---|---|
| Recall@1 (EAN esatto) | 64,3% | 42,9% | 85,7% | 64,3% |
| Recall@5 (EAN esatto) | 92,9% | 78,6% | 100% | 100% |
| Falsi match sui fuori catalogo | 0/5 | 0/5 | 0/5 | 0/5 |
| Astensione completa sui fuori catalogo | 1/5 | 4/5 | 1/5 | 5/5 |
| Inferenza p50 | 792 ms | 195 ms | 729 ms | 83 ms |

Su questo set SigLIP 2 mette più spesso il prodotto giusto al primo posto; CLIP è 4-9 volte più veloce. L'astensione più alta di CLIP dipende soprattutto dalle sue soglie provvisorie più alte, non è un confronto a parità di soglie. **Sono 19 foto sintetiche**: la scelta del modello va confermata sulle foto reali (protocollo sotto).

## 2. Carico: 60.000 prodotti e 60.000 vettori (`pnpm bench:load`)

Database separato (`comparator_bench`): 60.000 prodotti, 110.000 offerte su 3 fornitori, 60.000 vettori casuali a 768 dimensioni (HNSW m=16, ef_construction=64). App reale via HTTP, **5 utenti concorrenti con account distinti**, 200 richieste API, 25 ricerche per foto con il modello reale.

| Setup (una tantum) | Tempo |
|---|---|
| Inserimento di prodotti e offerte (SQL) | 8,3 s |
| Inserimento di 60.000 vettori | 12,1 s |
| **Costruzione dell'indice HNSW su 60.000 × 768** | **130 s** |
| Ricalcolo dei dati canonici di 60.000 prodotti | 77 s (prima dell'ottimizzazione a batch) |

| API catalogo, 5 utenti concorrenti (report finale) | p50 | p95 |
|---|---|---|
| Tutte le richieste (200, **0 errori**) | 59 ms | **150 ms** |
| Catalogo pagina 1 / pagina profonda (offset 5000) | 59 / 64 ms | 73 / 82 ms |
| Testo "gel rosa" / con refuso "vibratre" | 114 / 147 ms | 129 / 162 ms |
| EAN esatto | 16 ms | 25 ms |
| Filtri fornitore + disponibilità + prezzo | 63 ms | 141 ms |
| Scheda prodotto / facet | 18 / 4 ms | 28 / 8 ms |
| **Obiettivo: p95 ≤ 800 ms a caldo** | | **rispettato** |

| Ricerca per foto (lato server, esclusi upload e cold start) | p50 | p95 |
|---|---|---|
| ANN puro su 60.000 vettori, 5 concorrenti | 52 ms | 253 ms |
| 1 utente | 1.220 ms | 1.793 ms |
| **5 utenti concorrenti** | 4.519 ms | **4.797 ms** |
| 5 utenti, lato client (inclusi upload locale e parsing multipart) | 4.683 ms | 5.861 ms |
| Cold start (caricamento del modello) | 1,8 s | una volta per processo |
| **Obiettivo: p95 ≤ 5 s lato server** | | **rispettato al limite su questo laptop** |

Correzioni nate da questo benchmark (il report `…-BEFORE-fixes.json` conserva la prima misura):
1. la ricerca testuale restituiva 500 (numero di parametri della query di conteggio) → corretto e coperto da test;
2. la ricerca per EAN impiegava 1,2 s (sottoquery correlate in `OR`) → lookup indicizzate preliminari, ora 16 ms;
3. la validazione UUID troppo rigida rifiutava id validi per Postgres → formato GUID;
4. il rate limit per IP penalizzava più utenti dietro lo stesso NAT → limite per utente;
5. inferenze strettamente seriali → semaforo `VISION_CONCURRENCY` (default 2 × 2 thread);
6. la lettura barcode in WASM bloccava l'event loop (~0,4 s a foto) → pool di worker thread;
7. salvataggio della foto, barcode e visione eseguiti in sequenza → ora in parallelo.

Sulla stessa macchina, prima delle correzioni 5-7, la ricerca concorrente aveva un p95 lato server di 6,1 s.

## 3. Test end-to-end (`pnpm test:e2e`)

Login → creazione di 2 fornitori → import CSV (`;`, decimali con virgola) e XLSX (prezzi IVA inclusa, confezioni da 5) tramite le API del wizard → worker reale (graphile-worker, download HTTP, S3 SeaweedFS, embedding SigLIP 2) → accorpamento per EAN (4 prodotti, un'offerta per fornitore sugli EAN comuni) → 7/7 immagini indicizzate → ricerca con foto sintetica ruotata e ritagliata: prodotto atteso tra i primi 5 → scheda con netti unitari 11,00 € contro 10,00 € (50 € lordi / 5 pz, IVA 22% scorporata) → operatore bloccato sugli import (403) → reimport identico senza nuovi prodotti, offerte, download o embedding. **6/6 superati, 18,8 s.**

## Protocollo per il benchmark reale (da eseguire quando arrivano i dati)

1. **Catalogo**: importare i listini reali e attendere copertura dell'indice al 100% (Impostazioni › Stato del sistema).
2. **Set di query**: almeno **100** foto etichettate, raccolte **indipendentemente** dalle immagini indicizzate (mai riusare le foto del listino: sarebbe leakage, e il benchmark lo segnala):
   - 40+ foto da smartphone di prodotti a catalogo (confezione, prodotto fuori confezione, angolazioni diverse);
   - 15+ su sfondi complessi o con più oggetti;
   - 15+ di **varianti quasi identiche** (colori e misure diversi, 50 vs 100 ml);
   - 10+ di confezioni con codice a barre visibile;
   - 20+ di **oggetti assenti** dal catalogo, anche simili a prodotti presenti.
3. **Etichette**: `queries.json` con `expectedEan` (oppure `null` per gli assenti), `sameImageEans` per le varianti che condividono una foto, `bbox` facoltativo per simulare il ritaglio. Formato in `src/scripts/bench-visual.ts`.
4. **Esecuzione**: `pnpm bench:visual -- --set percorso/queries.json`, poi con `--crop`. Stessa cosa con `clip-vit-b32` preparato via `pnpm model:prepare` per il confronto.
5. **Valutazione separata**:
   - Recall@1/@5 per identità nota (obiettivo proposto: **Recall@5 ≥ 90%**, da validare e non garantito);
   - falsi match e astensione sugli assenti;
   - **qualità delle alternative giudicata da un operatore** (per ogni query assente: le alternative "simili" sono utili sì/no), da cui si ricava la soglia "simili";
   - risultati per categoria (flaconi, dispositivi, confezioni…) e limiti osservati.
6. **Calibrazione**: impostare le soglie da Impostazioni › Stato del sistema e segnarle come calibrate, annotando set e data.
7. **Carico reale**: `pnpm bench:load` sul server di produzione (o su una macchina equivalente), dichiarando l'hardware.
