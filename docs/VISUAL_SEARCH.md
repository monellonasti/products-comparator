# Ricerca per foto: modello, pipeline, soglie, requisiti

## Decisione V1

| | |
|---|---|
| Modello | **SigLIP 2 base patch16-224**: `google/siglip2-base-patch16-224` |
| Licenza | Apache-2.0 (model card Google su Hugging Face) |
| Pesi usati | Export ONNX `onnx-community/siglip2-base-patch16-224-ONNX`, revisione **`ba1f3b0843f24bc5417d38e19c37b287d719b2f4`**, file `onnx/vision_model.onnx` (fp32, 371.807.752 byte, SHA-256 `c0573e3f4140c3a7c4e9cc5912bd6b26a033b46a6a8e8af26cbea262b163bcad`, verificato il 2026-09-25 contro l'OID LFS pubblicato) |
| Runtime | Transformers.js 4.3.0 + onnxruntime-node 1.30.0 (CPU), dentro i processi Node (API per le query, worker per il catalogo). Nessun servizio Python, nessuna chiamata a terzi: le foto restano sull'infrastruttura aziendale. |
| Vettore | 768 dimensioni (`pooler_output`), normalizzato L2, distanza coseno |
| Chiave indice | `siglip2-base-p16-224@ba1f3b0/pp1` (modello + revisione + preprocessing) |
| Alternativa registrata | `clip-vit-b32`: `Xenova/clip-vit-base-patch32` rev. `d15189d7028b43f1d3e65039190477f6af591c2a` (OpenAI CLIP, licenza MIT del repository openai/CLIP), 512 dimensioni, SHA-256 `fd6e1402…7d40`. Molto più veloce, qualità attesa inferiore. |

**Perché SigLIP 2.** Nel test tecnico del 2026-09-25 (6 prodotti sintetici, query "tipo smartphone"), SigLIP 2 ha separato meglio i candidati corretti da quelli sbagliati: margine 0,85-0,89 contro ≤ 0,73. CLIP B/32 ha trovato gli stessi top-1 con margini minori. DINOv2-small ha sbagliato 2 casi su 6, confondendo prodotti uguali in colori diversi: è addestrato per essere insensibile al colore, e questo è un limite serio con varianti colore. La variante quantizzata q8 di SigLIP 2 è stata scartata perché dava coseno 0,93-0,97 rispetto a fp32. Sono fixture sintetiche: **la scelta va confermata con `pnpm bench:visual` sulle foto reali** prima di indicizzare le 60.000 immagini.

**Contenuti adult wellness.** Con un modello open-weight eseguito localmente non ci sono condizioni d'uso di terzi sui contenuti né invio di immagini all'esterno. La qualità su questo dominio non è documentata dall'autore del modello e va misurata con il benchmark reale.

Scartati in V1: Marqo-Ecommerce (Apache-2.0, specializzato e-commerce ma senza pesi ONNX: servirebbe un export Python, da rivalutare con il benchmark); modelli con licenza non commerciale; servizi esterni di embedding (condizioni d'uso e privacy da verificare, dipendenza di rete).

## Pipeline

1. **Validazione**: formato riconosciuto dal contenuto (JPEG, PNG, WebP, GIF, AVIF, TIFF), limite di pixel (`IMAGE_MAX_PIXELS`), dimensione dell'upload (`UPLOAD_MAX_IMAGE_BYTES`). HEIC è rifiutato con istruzioni chiare, ma il browser prova prima a convertirlo in JPEG: iOS Safari lo decodifica.
2. **Preprocessing `pp1`**, identico per catalogo e query (`src/vision/preprocess.ts`): orientamento EXIF → ritaglio facoltativo (coordinate relative) → appiattimento su bianco → inserimento in un quadrato bianco 448×448 senza deformare → JPEG q90. Il processor del modello porta poi l'immagine a 224×224 e la normalizza.
3. **Embedding** con il modello attivo; inferenze serializzate nel processo e thread configurabili (`VISION_THREADS`); timeout di 30 s.
4. **ANN** su pgvector HNSW (`m=16`, `ef_construction=64`). Per ogni query: `ef_search = 200`, `iterative_scan = relaxed_order`, K = 200 immagini (oversampling). L'indice è parziale per modello e contiene solo immagini `done`: le immagini non elaborate non sono ricercabili per foto.
5. **Aggregazione per prodotto**: una card per prodotto, con il punteggio della sua immagine migliore e l'immagine che ha generato il match. Un prodotto con molte foto non occupa tutta la lista. Se un'immagine è collegata a più prodotti (foto generica di varianti diverse) entrambi vengono proposti con l'avviso "verificare variante e confezione".
6. **Filtri strutturati** (fornitore, marca, categoria, disponibilità) applicati dopo l'aggregazione, sull'insieme sovracampionato.
7. **Barcode come evidenza**: codice letto dalla foto sul server (zxing-wasm, WASM locale) oppure dalla scansione live. Viene validato come GTIN; se corrisponde a un prodotto a catalogo, quel prodotto va nel gruppo **"Corrispondenza confermata"**. Non si usa OCR: un testo letto non darebbe certezza.
8. **Classificazione** sullo score coseno, che **non è una probabilità di identità** e non viene mai mostrato come "98%":
   - `possible` (≥ soglia "possibile") → "Possibili corrispondenze — da verificare";
   - `similar` (≥ soglia "simili") → "Prodotti simili — non sono lo stesso prodotto";
   - sotto la soglia "simili": nascosto. Se non resta nulla il sistema **si astiene** ("Nessuna corrispondenza affidabile", caso H).
9. **Risposta** con tempi per fase, copertura dell'indice e avviso se le soglie non sono calibrate. La ricerca viene salvata (`photo_searches`); la foto si cancella dopo `PHOTO_SEARCH_RETENTION_HOURS` (default 72 h, job `maintenance`) e **non** entra mai nel catalogo.

Il feedback ("È questo", "Non è questo", "Alternativa utile", "Nessun risultato pertinente") viene solo registrato per la valutazione: non unisce prodotti e non addestra nulla.

Se il modello non è disponibile, la ricerca per foto restituisce `provider_unavailable` con un messaggio chiaro, mentre catalogo, testo, EAN e SKU restano pienamente utilizzabili. `/readyz` non fallisce per questo.

## Soglie

Valori iniziali **non calibrati**, salvati in `embedding_models.thresholds` e modificabili da Impostazioni › Stato del sistema:

| Modello | possibile | simili |
|---|---|---|
| siglip2-base-p16-224 | 0,78 | 0,55 |
| clip-vit-b32 | 0,85 | 0,70 |

Sul set sintetico (vedi [BENCHMARK.md](BENCHMARK.md)) i corretti con ritaglio hanno avuto score 0,75-0,86 e i negativi al massimo 0,75. Anche per questo le soglie vanno ricalibrate su foto reali: `bench:visual` propone la soglia "possibile" come il minimo score top-1 corretto sopra il massimo dei negativi. La soglia "simili" richiede il giudizio di un operatore sulla qualità delle alternative.

## Cambio modello (switch controllato)

1. `pnpm model:prepare -- --model clip-vit-b32`: registra il modello (`building`), crea il suo indice HNSW parziale e accoda gli embedding di tutte le immagini. I nuovi download vengono indicizzati sia per il modello attivo sia per quello in costruzione.
2. Confronto dei due modelli con `pnpm bench:visual` sullo stesso set etichettato.
3. `pnpm model:prepare -- --model clip-vit-b32 --activate`, solo a copertura completa (`--force` per forzare). La ricerca legge il modello attivo dal database e lo usa **subito**, senza riavvio (il primo utilizzo carica i pesi, ~1 s). Aggiornare comunque `VISION_MODEL=clip-vit-b32` nel `.env`: serve per le nuove installazioni e per gli script; il precaricamento all'avvio dell'API segue il modello attivo. Il vecchio modello passa a `retired`: i suoi vettori restano per un eventuale ritorno e si possono eliminare in seguito.
4. **Ritorno al modello precedente**: `pnpm model:prepare -- --model siglip2-base-p16-224` lo riporta da `retired` a `building` e calcola i vettori delle immagini arrivate nel frattempo (mentre era ritirato non venivano indicizzate per lui); poi `--activate` come al punto 3.

Procedura eseguita per intero il 2026-09-28 sul catalogo demo (SigLIP 2 → CLIP → SigLIP 2): vedi [PROGRESS.md](PROGRESS.md) e, per il confronto sintetico, [BENCHMARK.md](BENCHMARK.md).

Vettori di modelli diversi non vengono mai confrontati tra loro: la chiave include modello, revisione e preprocessing.

## Requisiti e tempi (V1)

| Risorsa | Indicazione |
|---|---|
| CPU | x86-64 con AVX2 o ARM64, **4+ vCPU** dedicate all'inferenza. GPU non necessaria. |
| RAM | ~1,5 GB per processo con il modello caricato (pesi fp32 372 MB più runtime). API + worker + Postgres: **8 GB** consigliati, 16 GB comodi. |
| Disco | Modello ~0,4 GB (volume `models`); vettori ~3 KB/immagine più l'indice HNSW (60.000 immagini ≈ 0,2-0,4 GB, da misurare). |

**Tempi misurati** su un Snapdragon X Elite, Windows ARM64, a batteria, con altri processi attivi, quindi valori rumorosi: inferenza SigLIP 2 **0,19-1,0 s per immagine** con 2-4 thread. Nel benchmark visivo la mediana è 0,4-1,0 s. Più di 4 thread peggiora.

**Stima di indicizzazione iniziale** (da verificare sull'hardware di produzione): 60.000 immagini × 0,5-1,0 s ≈ **8-17 ore** con un solo shard di embedding su questa macchina, più download e derivate (limitati dalla banda dei fornitori e dal limite per host). Con `EMBED_QUEUE_SHARDS=2` e 2 thread per shard su una VM da 8 vCPU il tempo scende circa in proporzione ai core, finché la banda di memoria regge. Va misurato con un sottoinsieme di 1.000-2.000 immagini prima di lanciare l'intero catalogo. È un costo una tantum: dopo si indicizzano solo le immagini nuove o modificate (dedupe per SHA-256), e una variazione di prezzo non tocca le immagini.
