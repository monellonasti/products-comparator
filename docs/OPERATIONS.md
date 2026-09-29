# Operatività: deploy, backup, monitoraggio, sicurezza, costi

> Stato: la configurazione di produzione (Dockerfile, `deploy/docker-compose.prod.yml`, Caddy) è **scritta ma non eseguita**: Docker Desktop non partiva sulla macchina di sviluppo (vedi DECISIONS D-009). Va provata su un server di staging prima dell'uso reale. Questa V1 **non è production-ready** finché non ci sono benchmark su dati reali e una prova di deploy.

## Deploy consigliato (singola VM)

1. VM Linux (x86-64 o ARM64) con 4-8 vCPU e 8-16 GB di RAM (vedi [VISUAL_SEARCH.md](VISUAL_SEARCH.md)), Docker Engine con il plugin compose e firewall aperto solo su 22/80/443.
2. Bucket S3 **privato** (provider gestito) con credenziali limitate a quel bucket. In alternativa, SeaweedFS su un volume dedicato.
3. `deploy/.env.production` preparato da `deploy/.env.production.example`, con `chmod 600`, mai nel repository. Password e token generati in modo casuale: `openssl rand -hex 32` per la password di Postgres (un `/` o un `+` del base64 romperebbe `DATABASE_URL`), `openssl rand -base64 32` per `SECRETS_KEY`. In produzione l'app non parte senza `PUBLIC_ORIGIN` in https e con una `SECRETS_KEY` malformata.
4. `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d --build`. Solo Caddy pubblica le porte 80/443, con HTTPS automatico. Postgres, API e worker restano sulla rete interna di compose.
5. Primo amministratore: `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production exec api node src/scripts/create-user.ts --email … --name … --role admin` (password richiesta a terminale o via `COMPARATOR_PASSWORD`). Tutti i comandi compose di produzione vogliono `--env-file deploy/.env.production`: senza, l'interpolazione di `POSTGRES_USER` e `APP_DOMAIN` fallisce.
6. Pesi del modello: al primo avvio vengono scaricati nel volume `models`, con revisione fissata. In un ambiente senza Internet si costruisce l'immagine con `PREFETCH_MODEL=true` nel file di ambiente (passato come argomento di build dal compose) oppure si copia il volume, poi si imposta `VISION_ALLOW_REMOTE_MODELS=false`.
7. Verifiche: `https://<dominio>/healthz` (processo), `/readyz` (DB e storage; lo stato della visione è solo informativo), Impostazioni › Stato del sistema.

Aggiornamenti: `git pull`, nuovo `APP_VERSION` nel file di ambiente, poi `docker compose … up -d --build`. Le migrazioni si applicano all'avvio con advisory lock, quindi API e worker possono ripartire insieme. Il worker ha 5 minuti per chiudere i job in corso. Rollback: rimettere il valore precedente di `APP_VERSION` e rilanciare `up -d` (le immagini sono taggate, non serve ricostruire). Le migrazioni sono solo additive, per cui un rollback applicativo con schema più recente è sicuro finché una migrazione non rimuove colonne (da valutare caso per caso).

## Backup e ripristino

| Cosa | Come | Frequenza consigliata |
|---|---|---|
| PostgreSQL (dati, audit, code, vettori) | `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc comparator' > backup/comparator-$(date +%F).dump` | ogni notte più prima di ogni aggiornamento; conservazione 14-30 giorni, copia fuori sede |
| Object storage (immagini, file di import) | versioning e lifecycle del provider, oppure `rclone copy s3:bucket backup:bucket` (**copy**, non sync: una cancellazione per errore non deve propagarsi al backup) | ogni notte |
| Configurazione | `deploy/.env.production` in un password manager o secret store aziendale | a ogni modifica |
| **`SECRETS_KEY`** | insieme ai backup del DB, nel password manager: senza la chiave le credenziali dei feed salvate non sono leggibili e vanno reinserite | a ogni rotazione |

Ripristino (provato in V1 solo come comandi, **non esercitato**):
```bash
DC="docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production"
$DC stop api worker
$DC exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" comparator && createdb -U "$POSTGRES_USER" comparator'
$DC exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d comparator --no-owner' < backup/comparator-AAAA-MM-GG.dump
rclone copy backup:bucket s3:bucket   # oggetti del bucket, se persi
$DC start api worker
```
Le immagini sono content-addressed: dopo il ripristino di DB e bucket basta verificare `/readyz` e la copertura dell'indice. Il job di manutenzione non cancella oggetti "orfani" se il catalogo è vuoto o se troppi oggetti risultano senza riga nel database (un DB sbagliato o appena creato), per non svuotare il bucket dopo un ripristino parziale. I vettori si possono sempre rigenerare dalle derivate `infer.jpg` con `pnpm model:prepare`. Da fare prima della produzione: una prova di ripristino completa, cronometrata.

## Monitoraggio

- **Log** JSON su stdout (pino), con redazione di cookie e header Authorization. Mai segreti o contenuti dei file.
- **`GET /metrics`** (formato Prometheus) solo con `Authorization: Bearer $METRICS_TOKEN`, bloccato su Caddy (da interrogare dalla rete interna). Espone latenze HTTP per route (p50/p95/p99), `photo_search_server_ms`, errori di ricerca e di lettura barcode, `http_5xx_total`, profondità della coda e job con errori, download falliti e pendenti, copertura dell'indice (immagini, indicizzate, fallite), offerte obsolete, import falliti negli ultimi 7 giorni.
- **Feed**: gauge `feeds_failed` (feed il cui ultimo tentativo è fallito), `feeds_overdue` (feed in ritardo di oltre 2 ore: worker fermo?), `offer_changes_24h`.
- **Allarmi suggeriti**: `/readyz` diverso da 200; import falliti > 0; `feeds_failed` > 0 o `feeds_overdue` > 0; `image_download_failures` in crescita; `vision_index_failed` > 0; coda con più di 1.000 job per oltre un'ora; p95 della ricerca foto > 5 s; offerte obsolete in crescita per un fornitore.
- **UI**: Impostazioni › Stato del sistema (modello, copertura, soglie, code, fallimenti e retry) e pagina Importazioni.

## Sicurezza: checklist per la messa in produzione

- [ ] HTTPS attivo; `COOKIE_SECURE=true`; `PUBLIC_ORIGIN` uguale al dominio pubblico.
- [ ] Porte di Postgres, S3 e API **non** pubblicate (solo Caddy); firewall della VM chiuso.
- [ ] Bucket privato, senza policy pubbliche; credenziali limitate al bucket.
- [ ] `IMAGE_FETCH_DEV_ALLOW` vuoto (con `NODE_ENV=production` l'app rifiuta di partire altrimenti).
- [ ] Host immagini autorizzati configurati per ogni fornitore.
- [ ] Password di almeno 12 caratteri; account disattivati alla cessazione; revisione periodica dei ruoli.
- [ ] Backup notturni verificati e prova di ripristino.
- [ ] `METRICS_TOKEN` impostato e non esposto.
- [ ] `SECRETS_KEY` generata (`openssl rand -base64 32`), diversa da sviluppo, salvata con i backup. Rotazione: impostare la nuova chiave e reinserire le credenziali dei feed.
- [ ] Aggiornamenti di sicurezza di immagini base e dipendenze (`pnpm audit`).

Rischi residui noti: la lettura XLSX avviene interamente in memoria e costa circa 15 MB di RAM per MB decompresso (misurato: listino da 100.000 righe, 8 MB di XLSX, ~1,3 GB di picco). I file "bomba" e quelli oltre `XLSX_MAX_UNCOMPRESSED_BYTES` (default 100 MB, ~1,5 GB di picco) vengono rifiutati prima della lettura, e si legge un XLSX alla volta per processo (D-021). Resta consigliato un limite di memoria per i container di API e worker, dimensionato su quel picco più il modello visivo. I rate limit sono in memoria e valgono per singola istanza.

## Scalabilità

- Più traffico web: più istanze `api` dietro Caddy (sessioni in DB, nessuno stato locale tranne il modello caricato).
- Indicizzazione più veloce: `EMBED_QUEUE_SHARDS` > 1 e/o più processi worker; `VISION_THREADS × VISION_CONCURRENCY ≤ vCPU`.
- Più download: `IMAGE_FETCH_PER_HOST` (rispettando i fornitori) e `WORKER_CONCURRENCY`.
- Ricontrollo delle immagini dopo ogni import (`IMAGE_RECHECK_HOURS`, default 20; `IMAGE_RECHECK_MAX_PER_RUN`, default 5.000): con server che rispondono 304 costa una richiesta leggera per immagine al giorno; con fornitori senza ETag/Last-Modified ogni controllo riscarica l'immagine, quindi per cataloghi grandi conviene alzare l'intervallo (per esempio 168 h). Le versioni precedenti delle immagini sostituite restano nello storage.
- Oltre qualche centinaio di migliaia di immagini: rivedere `m`/`ef_construction` di HNSW, `maintenance_work_mem` e la memoria del DB.

## Costi stimati (indicativi, da verificare prima dell'acquisto)

Nessun servizio è stato acquistato. Prezzi IVA esclusa, consultati il 25/09/2026:

| Voce | Ipotesi | Fonte (data) | Stima |
|---|---|---|---|
| VM applicativa | Hetzner CAX31 (8 vCPU ARM64, 16 GB, 160 GB) | costgoat.com, aggregatore terzo, prezzi al 05/09/2026: €20,99/mese | ~€21/mese |
| Alternativa x86 | Hetzner CX43 (8 vCPU, 16 GB) | stessa fonte: €15,99/mese | ~€16/mese |
| Object storage | 60.000 immagini × (thumb ~30 KB + display ~120 KB + infer ~40 KB) ≈ **11 GB**, più file di import e foto temporanee: largamente sotto 1 TB | Hetzner Object Storage €6,49/mese con 1 TB incluso (prezzo da aprile 2026 riportato da fonti terze); Cloudflare R2 $0,015/GB-mese con egress gratuito (documentazione ufficiale R2) | €6,49/mese (Hetzner) oppure ~$0,20/mese più operazioni (R2) |
| Backup DB | dump compresso stimato 1-3 GB (vettori inclusi) × 30 giorni | stesso storage | incluso nella quota sopra |
| Dominio e TLS | Let's Encrypt | — | €0 (dominio a parte) |

Totale indicativo: **circa €25-30/mese** per una VM più object storage, esclusi dominio, tempo di gestione e backup fuori sede. Le derivate reali dipendono dalle immagini dei fornitori: le dimensioni sopra sono stime e vanno misurate sulle prime 1.000 immagini reali (`image_assets.bytes` più la dimensione degli oggetti). L'intervallo di 6-30 GB citato nei requisiti per 60.000 immagini "ottimizzate" è coerente con l'ordine di grandezza, ma non è misurato. I prezzi Hetzner 2026 sono cambiati più volte (aumenti ad aprile e giugno 2026 riportati da più fonti): verificarli sulla console del provider.
