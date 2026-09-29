# Importazione listini (CSV/XLSX) e connettori

## Flusso

```
upload ─► lettura (foglio / separatore / codifica / riga intestazioni / separatore decimale)
       ─► mappatura colonne (proposta automatica, salvabile per fornitore)
       ─► anteprima validata (prime 200 righe: errori, avvisi, nuove/aggiornate, EAN già a catalogo)
       ─► conferma (snapshot o delta, data dei dati) ─► job `import_run` (coda `import:<fornitore>`)
       ─► staging (tutte le righe grezze in import_staging_rows)
       ─► batch da 500 righe: normalizzazione, upsert, accorpamento, immagini, checkpoint (una transazione per batch)
       ─► finalizzazione: regola snapshot, stato fornitore, job `suggest_matches`
       ─► report: contatori, problemi per riga (UI + CSV), avanzamento immagini
```

Il file originale resta nello storage (`imports/<run>/<sha256>`) per la tracciabilità. Le celle sono **dati**: formule mai eseguite (in XLSX si usa il valore memorizzato, con avviso), HTML delle descrizioni ridotto a testo, CSV esportati con protezione dalla formula injection.

## Lettura dei file (src/imports/parsers.ts)

- Tipo riconosciuto dal contenuto (firma ZIP per XLSX), non dall'estensione. Il vecchio `.xls` binario viene rifiutato con un messaggio esplicito.
- XLSX (`src/imports/xlsx-guard.ts`): prima di aprirlo si controlla l'archivio senza fidarsi delle intestazioni. Al massimo 5.000 parti; contenuto decompresso entro `XLSX_MAX_UNCOMPRESSED_BYTES` (default 100 MB, circa 110.000 righe da 15 colonne); ogni parte viene davvero decompressa con un tetto pari alla dimensione dichiarata, per scoprire le dimensioni falsificate; niente DTD o entità nelle parti XML; archivi cifrati, divisi in più parti o con compressione diversa da deflate rifiutati. Un file rifiutato dà un errore esplicito nel wizard (o fa fallire il feed) e non lascia né bozze d'import né il file nello storage. Si legge un XLSX alla volta per processo. Per listini più grandi: CSV.
- Codifica: BOM UTF-8/UTF-16, poi UTF-8 rigoroso, altrimenti Windows-1252 (tipica di Excel italiano). Si può forzare dal wizard.
- Separatore: rilevato per coerenza sulle prime 25 righe (`;` `,` tab `|`), modificabile.
- Separatore decimale dichiarato (`,` o `.`). Un valore con il separatore opposto (`12.50` con `,` configurata) è un errore esplicito, mai un'interpretazione a caso.
- Intestazioni duplicate rinominate (`Img`, `Img (2)`); righe vuote ignorate; numero di riga originale conservato.
- XLSX: un codice salvato come **numero** è segnalato quando risulta non valido. Oltre 2^53 il valore diventa la sua notazione esponenziale e quindi viene marcato come "precisione persa". Zeri iniziali persi non vengono ricostruiti.

## Campi e regole di riga (src/imports/fields.ts, normalize.ts)

| Campo | Note |
|---|---|
| `sku` **obbligatorio** | Chiave di upsert. Riga senza SKU = errore (non importata). |
| `barcode` | Vedi [IDENTITY.md](IDENTITY.md). Un EAN non valido è un avviso, non un errore: la riga entra come prodotto distinto. |
| `price`, `currency`, `vat_rate` | Prezzo non interpretabile o fuori scala (oltre 9.999.999.999, tipicamente un EAN finito nella colonna sbagliata) = **errore di riga**: si mantiene il dato precedente di quello SKU e il resto del listino viene applicato. Prezzo 0 = avviso: l'offerta entra ma non partecipa al confronto prezzi ("su richiesta"). IVA dichiarata a livello di file/fornitore (netto, lordo con aliquota, sconosciuta). Una cella Excel in formato percentuale (0,22) vale 22%; un'aliquota scritta come frazione in una cella di testo è un errore di riga. |
| `units_per_pack` | Pezzi coperti dal prezzo (es. 50 € per confezione da 5). Il default si dichiara nel wizard; se non è dichiarato il prezzo non è confrontabile per unità. |
| `moq`, scaglioni (`tiers`) | Conservati e mostrati. Il miglior prezzo usa il prezzo base. |
| `stock_quantity`, `availability` | Vuoto = sconosciuto, `0` = esaurito, testo ("disponibile", ">10", "in arrivo") = stato qualitativo senza inventare quantità. Giacenza negativa = esaurito, con avviso. Giacenza oltre 2 miliardi = quantità non registrata, con avviso. |
| `lead_time` | Testo originale conservato; giorni ricavati prendendo il limite superiore ("3-5 giorni" → 5), solo fino a 3650. |
| `image_urls` | Più colonne o separatori (`|`, `;`, spazi). Solo http/https, al massimo 12 per riga e 2048 caratteri per URL. In un XLSX una cella con testo "Foto" e un collegamento usa la destinazione del collegamento; in tutte le altre colonne vale il testo visibile (uno SKU con link resta lo SKU). |
| attributi | colore, misura, variante, contenuto netto, pezzi, materiale (usati nei controlli d'identità). |

## Upsert, idempotenza e ordine

- **Chiave**: `(supplier_id, supplier_sku)`, con `UNIQUE` nel DB.
- **Riga invariata**: `row_hash` (SHA-256 della serializzazione stabile dei campi normalizzati) uguale a quello salvato. Si aggiornano solo `last_seen_at`, `last_import_id` e `source_as_of` (conferma della freschezza), senza nuove immagini, job o embedding (caso E, verificato anche nell'e2e).
- **Immagini**: `image_sources` è unico per `(supplier_id, url)`; il download si accoda solo per URL nuovi (`job_key` = `image_fetch:<id>`). I byte identici vengono deduplicati per SHA-256 su `image_assets`.
- **Fuori ordine**: ogni import ha una data dei dati (`as_of`, di default l'ora di caricamento). Se una riga è più vecchia del dato salvato (`source_as_of`) viene saltata con avviso `outdated_row`.
- **Sovrapposizioni**: al massimo un import `queued/running` per fornitore (indice unico parziale: chi perde la corsa riceve un 409, anche un feed che parte insieme a un caricamento manuale); lock di sessione per singolo run, così l'esecuzione non parte due volte. Nessuna coda graphile per fornitore: una coda bloccata da un worker terminato di colpo resterebbe ferma per ore (D-023).
- **SKU duplicato nello stesso file**: viene applicata la prima occorrenza, le successive sono errori `duplicate_sku`.

## Snapshot e delta

- **Delta**: aggiorna solo le righe presenti e non disattiva mai nulla.
- **Snapshot**: al termine di un import **riuscito**, le offerte attive del fornitore non viste in questo run passano a `active=false` (`deactivated_reason='assente_dallo_snapshot'`, con audit). La disattivazione **non** viene eseguita se:
  1. ci sono righe senza SKU leggibile (non si può sapere cosa manca);
  2. la data dei dati è precedente all'ultimo snapshot applicato;
  3. il file contiene meno del 50% dei codici attualmente attivi (probabile file troncato).
  
  Le righe con errori ma con SKU valido contano come "presenti". Un'offerta che ricompare viene riattivata, non duplicata. Il confronto delle date vale anche per la singola offerta: uno snapshot non disattiva un'offerta aggiornata da un delta con data più recente, e un delta più vecchio di uno snapshot non riattiva un'offerta che quello snapshot ha tolto.
- **Import fallito** (caso I): lo stato diventa `failed` con il messaggio d'errore. Il fornitore risulta con l'ultimo import fallito e UI e scheda mostrano i suoi dati come "non aggiornati". Le righe non elaborate mantengono i dati precedenti. Con "Riprova" l'import riparte dal checkpoint: lo staging viene conservato finché l'import non riesce.

## Retry, errori e ripresa

- Errori transitori (DB, storage): il job fallisce e graphile-worker lo ritenta con backoff esponenziale, fino a 3 tentativi per gli import. Errori permanenti (file illeggibile, colonne mappate assenti, un valore che il database rifiuta come dato non valido) non vengono ritentati: l'import fallisce con il motivo.
- Un import fermo da più di 15 minuti (heartbeat) si può riprovare dalla UI.
- Download immagini: coda per host (`fetch:<host>:<shard>`, al massimo `IMAGE_FETCH_PER_HOST` in parallelo per host), 6 tentativi con backoff. 404/403 e i blocchi SSRF sono definitivi (`failed`/`blocked`) e si possono ritentare dalle Impostazioni.

## Feed automatici (src/imports/feed.ts)

Una volta configurato il fornitore, dalla sua pagina (sezione **Aggiornamento automatico**, solo amministratori) si imposta:

| Impostazione | Note |
|---|---|
| Indirizzo del listino | URL http/https di un file CSV o XLSX. Viene salvato **cifrato**, perché spesso contiene un codice di accesso; l'interfaccia mostra solo host e percorso (`?…`). |
| Autenticazione | nessuna, utente e password (Basic), token Bearer o header personalizzato. Le credenziali sono **in sola scrittura** (mai restituite dall'API), inviate **solo in HTTPS** e **solo all'origine configurata**: un redirect verso un altro host non le riceve. |
| Frequenza | una volta al giorno all'orario indicato (ora italiana, cambio dell'ora legale gestito) oppure ogni N ore. |
| Tipo di file | listino completo (snapshot, con le regole di sicurezza sopra) oppure parziale (delta). |

Flusso: ogni 5 minuti il worker controlla i feed in scadenza e li "prenota" nel DB, così ognuno parte una sola volta. Poi scarica il file (downloader SSRF-safe, limite `UPLOAD_MAX_IMPORT_BYTES`, timeout `FEED_TIMEOUT_MS`) e crea un import con origine `feed`, usando la **mappatura salvata** del fornitore, con data dei dati uguale all'ora del download. Da lì in avanti è identico a un import manuale: staging, batch, snapshot, immagini, suggerimenti, report.

| Situazione | Comportamento |
|---|---|
| Mappatura non ancora salvata | Nessun download; stato "in attesa della mappatura". Con **Configura mappatura dal feed** il file viene scaricato e aperto nel wizard: basta salvare la mappatura una volta. |
| Import già in corso per il fornitore | Rinvio di 15 minuti. |
| Download non riuscito (errore di rete, 4xx/5xx, file vuoto) | Dati precedenti conservati e marcati **non aggiornati** (ultimo import del fornitore = fallito). Fino a 3 nuovi tentativi, dopo 30, 60 e 90 minuti, poi l'orario normale. L'errore compare nella pagina del fornitore senza la query string dell'URL. |
| Colonne del file cambiate | L'import fallisce con "Colonne mappate assenti nel file: …". **Prova connessione** mostra in anticipo le colonne mancanti. |
| File identico al giorno prima | Nessuna variazione registrata; la freschezza dei dati viene confermata. |

Azioni manuali: **Prova connessione** (scarica e legge le intestazioni senza importare), **Aggiorna ora** (esegue subito il feed), **Configura mappatura dal feed**.

## Report delle variazioni (src/domain/changes.ts)

A ogni import, da feed o manuale, per ogni offerta già esistente si registra in `offer_changes` cosa è cambiato rispetto al dato precedente:

| Tipo | Quando | Valori |
|---|---|---|
| Prezzo | prezzo, valuta, IVA o pezzi per prezzo cambiati | prima e dopo; la **percentuale** solo se valuta, IVA e confezione sono uguali (altrimenti "non confrontabile") |
| Disponibilità | lo stato cambia (disponibile / scarsa / esaurito / in arrivo / non dichiarata) | stato e quantità prima e dopo |
| Quantità | stessa disponibilità, quantità diversa | quantità prima e dopo |
| Immagini | URL di immagini aggiunti o tolti (solo se il file ha colonne immagine mappate) | elenco degli URL aggiunti e rimossi |
| Immagine sostituita | stesso URL, contenuto diverso (ricontrollo dopo l'import, vedi sotto) | immagine precedente e nuova (miniature prima/dopo) |
| Nuova offerta | SKU mai visto (non registrato al **primo** import del fornitore, per evitare migliaia di righe inutili) | prezzo e disponibilità |
| Uscita dal listino | offerta disattivata da uno snapshot | ultimo prezzo noto |
| Tornata a listino | offerta disattivata che ricompare | prezzo |
| EAN cambiato | il fornitore corregge l'EAN di uno SKU | vecchio e nuovo EAN (l'offerta viene anche spostata sul prodotto giusto) |

Dove si consulta: **Importazioni › Variazioni** (filtri per periodo, fornitore, tipo, variazione minima di prezzo in %, export CSV), il riquadro **Variazioni rilevate** nel dettaglio di ogni import, la sezione **Variazioni recenti delle offerte** nella scheda prodotto (ultimi 90 giorni) e il riepilogo dell'ultimo feed nella pagina del fornitore. Lo storico viene conservato per `CHANGE_HISTORY_DAYS` giorni (default 365) e poi eliminato dal job di manutenzione.

**Immagini sostituite allo stesso indirizzo** (`src/images/tasks.ts`). Al termine di ogni import il worker ricontrolla le immagini già scaricate del fornitore, usate da offerte attive e non ricontrollate da `IMAGE_RECHECK_HOURS` ore (default 20, quindi una volta al giorno con un feed giornaliero; 0 disattiva), al massimo `IMAGE_RECHECK_MAX_PER_RUN` per import (default 5.000, le più vecchie per prime). Il ricontrollo usa richieste condizionali (`If-None-Match` / `If-Modified-Since` con ETag e Last-Modified salvati al download): se il server risponde 304 non si scarica nulla. Senza questi header l'immagine viene riscaricata e confrontata byte per byte (SHA-256). Se il contenuto è cambiato, l'URL punta al nuovo asset (derivate e vettori calcolati come per un'immagine nuova, stesse protezioni SSRF e stesso limite per host), la scheda prodotto mostra la nuova immagine e per ogni offerta attiva che la usa si registra una variazione "Immagine sostituita", associata all'import che ha avviato il controllo. L'immagine precedente resta nello storage per il confronto prima/dopo. Se il ricontrollo fallisce (timeout, 404, file non valido) l'immagine attuale resta e si riprova dopo un import successivo.

Limiti noti:
- le immagini sostituite compaiono qualche minuto dopo la fine dell'import (il ricontrollo gira in background, dopo i nuovi download);
- nessuna notifica push o email: il report si consulta nell'app. Un riepilogo via email richiederà la configurazione SMTP.

## Connettori futuri (src/imports/connectors.ts)

L'interfaccia `SupplierConnector` restituisce un file (o delle righe) più `asOf` e `mode`, che passano **per la stessa pipeline** degli upload. Così le regole su identità, prezzi e snapshot restano in un solo punto. `suppliers.connector_kind`, `connector_config` (mai segreti: solo **nomi** di variabili d'ambiente) e `refresh_interval_minutes` sono già a schema. Il feed HTTP generico descritto sopra è già disponibile per qualsiasi fornitore che pubblichi un CSV/XLSX a un indirizzo fisso. I connettori **specifici** (API proprietarie, SFTP, portali con login) vanno scritti solo con documentazione e accessi reali del fornitore; le loro credenziali vanno cifrate in `supplier_secrets` come quelle dei feed.

Dati necessari per collegare un fornitore reale:
1. un listino completo reale (CSV/XLSX) e uno parziale, se il fornitore invia aggiornamenti;
2. conferma su trattamento IVA, valuta, unità del prezzo (pezzo/confezione) e significato della giacenza;
3. dominio/i delle immagini da inserire nella lista degli host autorizzati, e condizioni d'uso delle foto;
4. per i feed/API: documentazione, credenziali (in un secret manager, non nel repository), limiti di frequenza, orari di aggiornamento.

## Template

`templates/listino-template.csv` e `templates/listino-template.xlsx` (con foglio istruzioni) usano intestazioni riconosciute automaticamente dal wizard. Il test `import templates` lo verifica.
