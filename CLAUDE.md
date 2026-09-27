# Note per chi riprende il lavoro

- Comunicazione in italiano; identificatori e codice in inglese.
- Stato e prossimi passi: `docs/PROGRESS.md`. Decisioni motivate: `docs/DECISIONS.md` (aggiungere una voce D-0xx per ogni scelta rilevante).
- Node 24 esegue direttamente i `.ts` (type stripping): solo sintassi "erasable" (niente `enum`, parameter properties, namespace). Import con estensione `.ts`.
- Sviluppo: `pnpm dev` (API con riavvio automatico + worker + Vite su 5173). Postgres e S3 devono essere già avviati.
- Test: `pnpm test` (unit + integrazione, **svuota** `TEST_DATABASE_URL`), `pnpm test:e2e` (modello e S3 reali). Typecheck: `pnpm typecheck`.
- Su questa macchina (Windows ARM64) Docker Desktop non parte: Postgres e SeaweedFS girano in WSL (`scripts/dev/`). S3 va raggiunto su `localhost:8333`, non su `127.0.0.1`.
- Mai simulare risultati della ricerca visiva e mai presentare benchmark sintetici come qualità reale.
