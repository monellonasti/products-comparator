# Catalogo fornitori B2B con ricerca per foto (V1)

Web app interna per gli acquisti: raccoglie i listini dei fornitori abituali in un **catalogo visivo unificato**. Le offerte con lo stesso EAN valido finiscono in un'unica scheda, mentre le offerte dei singoli fornitori restano distinte. La funzione centrale è la **ricerca con una foto**, caricata o scattata: trova il prodotto oppure alternative simili, e da lì si confrontano prezzi netti, confezioni, MOQ e disponibilità fino alla pagina del fornitore.

## Il problema

Le aziende con un catalogo molto ampio, multibrand e multicategoria, si riforniscono da molti fornitori, ognuno con il proprio listino, i propri codici e il proprio formato.

- **Nessuna visione d'insieme.** I prodotti di ogni fornitore stanno in file e portali separati: per sapere chi ha un articolo, a che prezzo e con quale disponibilità bisogna aprirli uno per uno.
- **Lo stesso prodotto può costare anche il 20% in più.** Nello stesso periodo, alle stesse condizioni di porto franco e con gli stessi tempi di consegna, un articolo può costare anche il 20% in più da un fornitore, mentre un altro costa il 20% in meno da un altro. Su ordini da migliaia di euro lo spreco è importante. Il confronto a mano è lento e porta a errori: un prezzo IVA inclusa sembra più alto di uno netto, una confezione da 6 sembra più cara del pezzo singolo.
- **Lo stesso articolo con marchi diversi.** Con l'abbassamento delle barriere commerciali molti wholesaler vendono marchi propri che sono prodotti OEM delle stesse fabbriche, spesso cinesi. L'oggetto è lo stesso, ma marchio ed EAN cambiano: nessuna ricerca per codice li mette uno accanto all'altro, e l'alternativa più conveniente resta invisibile.
- **I listini cambiano di continuo.** Prezzi e giacenze si aggiornano ogni giorno, in formati diversi (CSV, Excel, colonne con nomi diversi), e le variazioni passano inosservate.
- **Spesso si ha in mano il prodotto, non il suo codice.** In magazzino, o davanti a un campione, manca il codice con cui ciascun fornitore lo identifica nel proprio listino.

## Come lo risolve

- **Una dashboard centralizzata.** I listini di tutti i fornitori, caricati a mano o scaricati ogni giorno da un feed, confluiscono in un unico catalogo normalizzato, filtrabile per fornitore, marca, categoria, prezzo e disponibilità. Le offerte con lo stesso EAN valido finiscono nella stessa scheda prodotto, restando distinte per fornitore.
- **Il fornitore più conveniente a colpo d'occhio.** Il confronto usa il prezzo netto per pezzo, IVA esclusa, nella stessa valuta. Le offerte non confrontabili vengono segnalate invece di essere mescolate, e un prezzo più basso ma esaurito è mostrato a parte. La scheda affianca tutte le offerte con confezione, MOQ, scaglioni, stock, tempi di consegna e link al fornitore.
- **Dalla foto a tutti i marchi dello stesso articolo.** Da una foto, scattata o caricata, la ricerca visiva trova il prodotto e gli affianca gli articoli simili venduti da altri wholesaler con i propri marchi, ciascuno con il miglior prezzo confrontabile e il numero di fornitori che lo hanno disponibile. Legge anche il codice a barre quando è visibile. Per confrontare un'intera tipologia, il catalogo si filtra per categoria e si ordina per prezzo.
- **Variazioni sotto controllo.** A ogni aggiornamento dei listini si registra cosa è cambiato: prezzi (con la %), disponibilità, quantità, immagini, prodotti nuovi o usciti.

Esempio: un operatore fotografa un flacone in magazzino. L'app riconosce il prodotto, mostra quali fornitori lo vendono e a che prezzo netto per pezzo, e gli affianca gli articoli simili venduti con altri marchi, ciascuno con il suo prezzo migliore. La somiglianza visiva indica un candidato, non una certezza: che due articoli siano davvero lo stesso prodotto OEM lo conferma l'operatore, guardando scheda e formato (per esempio 50 o 100 ml; il prezzo è confrontato per pezzo, non per unità di misura).

> **Stato** (aggiornato al 2026-09-28): V1 funzionante in locale, con feed automatici e report delle variazioni, verificata con test automatici, un test end-to-end e benchmark **su dati sintetici**. **Non è production-ready**: mancano la calibrazione della ricerca visiva su foto reali, una prova di deploy e una prova di ripristino. Dettagli in [docs/PROGRESS.md](docs/PROGRESS.md).

## Cosa fa

- **Catalogo** a griglia con card (immagine, marca, EAN, numero di fornitori, miglior prezzo netto confrontabile, "disponibile presso N fornitori", dati non aggiornati); filtri per fornitore, marca, categoria, prezzo, disponibilità, EAN, immagini; paginazione lato server.
- **Ricerca per foto**: trascina, incolla, scegli un file o scatta; ritaglio facoltativo; risultati in tre gruppi (confermati da barcode, possibili, simili) con l'immagine che ha generato il match, astensione quando nessun risultato è affidabile, nuovo ritaglio, feedback.
- **Ricerca testuale, EAN e SKU** (tollera i refusi; UPC-A ed EAN-13 equivalenti); **lettura barcode** live (BarcodeDetector o zxing-wasm locale) e inserimento manuale sempre disponibile.
- **Scheda prodotto**: galleria, dati canonici con fornitore di provenienza, EAN e loro origine, offerte in tabella (su mobile come schede) con prezzo di listino, trattamento IVA, netto per pezzo, confezione, MOQ, scaglioni, stock, tempi, aggiornamento e link.
- **Feed automatici**: per ogni fornitore si può impostare l'indirizzo del listino (CSV/XLSX, anche con utente/password o token, salvati cifrati) da scaricare **una volta al giorno** a un orario scelto (o ogni N ore); il file viene importato con la mappatura salvata.
- **Report delle variazioni**: a ogni aggiornamento (feed o manuale) si registra cosa è cambiato: **prezzi** (con %), **disponibilità e quantità**, **immagini** aggiunte, tolte o sostituite dal fornitore allo stesso indirizzo (con miniature prima/dopo), offerte nuove, uscite o tornate a listino, EAN corretti. Si consulta in Importazioni › Variazioni (filtri, CSV), nel dettaglio import e nella scheda prodotto.
- **Fornitori e import CSV/XLSX**: wizard con lettura, mappatura salvabile, anteprima validata, snapshot/delta, stato e avanzamento, errori per riga (anche in CSV), ripresa dal checkpoint, immagini scaricate e indicizzate in background.
- **Corrispondenze da verificare**: conflitti EAN e possibili doppioni; unione, separazione, override e relativo annullamento, tutto tracciato.
- **Ruoli** amministratore e operatore, applicati lato server su ogni risorsa.

## Stack

TypeScript su Node 24 (senza transpiler: type stripping nativo) · Fastify 5 · React 19 + Vite 8 · PostgreSQL 18 + pgvector 0.8 (HNSW) + FTS/trigram · coda graphile-worker su Postgres · storage S3-compatibile (SeaweedFS in locale) · encoder visivo **SigLIP 2** ONNX locale (Transformers.js / onnxruntime-node, CPU). Motivazioni in [docs/DECISIONS.md](docs/DECISIONS.md).

## Avvio locale

Prerequisiti: Node ≥ 24, pnpm 11. Poi **una** delle due opzioni per PostgreSQL + S3.

**A) Docker (ambiente di riferimento, non eseguito su questa macchina: vedi PROGRESS):**
```bash
cp .env.example .env
docker compose up -d --build
docker compose exec api node src/scripts/create-user.ts --email tu@azienda.it --name "Nome Cognome" --role admin
```
App su http://localhost:3000.

**B) Senza Docker, con WSL Ubuntu (percorso usato e verificato durante lo sviluppo su Windows):**
```bash
pnpm install
wsl -d Ubuntu -- bash scripts/dev/setup-wsl-postgres.sh
wsl -d Ubuntu -- bash scripts/dev/wsl-seaweedfs.sh start
cp .env.example .env
pnpm migrate
pnpm build
pnpm user:create -- --email tu@azienda.it --name "Nome Cognome" --role admin
```
Poi, in due terminali:
```bash
pnpm start
pnpm worker
```
App su http://127.0.0.1:3000.

In sviluppo, al posto dei due terminali: `pnpm dev` avvia API (riavvio automatico alle modifiche), worker e frontend con hot reload su http://127.0.0.1:5173 (proxy `/api` verso 3000). Ctrl+C ferma tutto; se uno dei tre processi si chiude, vengono fermati anche gli altri. Il worker non si riavvia da solo: dopo modifiche ai job, rilanciare `pnpm dev`.

Al primo avvio i pesi del modello (~372 MB, revisione fissata) vengono scaricati in `.models/`. Per scaricarli in anticipo: `node --env-file=.env src/scripts/model-download.ts`.

### Demo con dati sintetici

```bash
pnpm demo:fixtures
pnpm demo:seed
pnpm demo:images
pnpm worker
```
`demo:fixtures` genera 3 listini (CSV cp1252 con `;`, XLSX, CSV UTF-8), le immagini e 19 foto di prova in `fixtures/demo/`. `demo:seed` crea fornitori, categorie, utenti `admin@demo.local` e `operatore@demo.local` (password da `DEMO_ADMIN_PASSWORD` / `DEMO_OPERATOR_PASSWORD`, altrimenti generate e stampate una sola volta) ed esegue gli import. `demo:images` serve le immagini (e il listino demo del "giorno 2" in `/feeds/`) su 127.0.0.1:4010, ammesso solo in sviluppo tramite `IMAGE_FETCH_DEV_ALLOW`. Marche, prodotti ed EAN demo sono **fittizi**.

Per provare il feed e il report delle variazioni: nella pagina del fornitore *Alfa Distribuzione (demo)* impostare l'indirizzo `http://127.0.0.1:4010/feeds/alfa-listino-giorno2.csv`, salvare e premere **Aggiorna ora**. Il listino del giorno 2 ha prezzi cambiati, un prodotto esaurito, una quantità diversa, un'immagine in più, un prodotto uscito e uno nuovo. Richiede `SECRETS_KEY` nel `.env`.

## Test e benchmark

| Comando | Cosa verifica | Esito al 2026-09-28 |
|---|---|---|
| `pnpm typecheck` | TypeScript server + web | pulito |
| `pnpm test:unit` | GTIN, prezzi, stock, parser, SSRF, barcode, template, pianificazione feed, cifratura, variazioni | 62/62 |
| `pnpm test` | unit + integrazione su Postgres reale (`TEST_DATABASE_URL`, **viene svuotato**), feed e ricontrollo immagini inclusi | 109/109 |
| `pnpm test:e2e` | flusso completo con HTTP, S3, download e modello reali | 6/6 |
| `pnpm bench:visual -- --set fixtures/demo/queries.json [--crop]` | Recall@1/@5, falsi match, astensione, soglie suggerite | sintetico, SigLIP 2: R@5 92,9% a foto intera, 100% con ritaglio (CLIP B/32: 78,6% / 100%) |
| `pnpm bench:load -- --products 60000 --users 5` | latenza API e ricerca foto su 60.000 vettori (DB `comparator_bench` separato) | API p95 150 ms; foto p95 4,8 s lato server con 5 utenti |

Risultati, hardware e limiti: [docs/BENCHMARK.md](docs/BENCHMARK.md).

## Documentazione

| Documento | Contenuto |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Componenti, flussi, scelte trasversali |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | ERD, vincoli, invarianti, storage |
| [docs/IDENTITY.md](docs/IDENTITY.md) | Normalizzazione GTIN, accorpamento, conflitti, reversibilità |
| [docs/IMPORTS.md](docs/IMPORTS.md) | Import CSV/XLSX, upsert, snapshot, ripresa, connettori, dati richiesti ai fornitori |
| [docs/VISUAL_SEARCH.md](docs/VISUAL_SEARCH.md) | Modello e licenza, pipeline, soglie, cambio modello, requisiti e tempi |
| [docs/BENCHMARK.md](docs/BENCHMARK.md) | Risultati e protocollo per il benchmark reale |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Deploy, backup/ripristino, monitoraggio, sicurezza, costi stimati |
| [docs/DECISIONS.md](docs/DECISIONS.md) · [docs/PROGRESS.md](docs/PROGRESS.md) | Registro decisioni e stato di avanzamento |
| `templates/listino-template.csv` / `.xlsx` | Modello di listino riconosciuto automaticamente dal wizard |

## Configurazione

Tutte le variabili sono in [.env.example](.env.example), validate all'avvio (`src/config.ts`). Nessun segreto nel repository; in produzione vanno in `deploy/.env.production` (vedi `deploy/.env.production.example`).
