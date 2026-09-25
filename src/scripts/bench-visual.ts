// Reproducible visual-search benchmark on a LABELLED query set against the current catalogue index.
//
//   pnpm bench:visual -- --set fixtures/demo/queries.json [--crop] [--out bench-results]
//
// Query set format (JSON): { "queries": [ { "file": "x.jpg", "expectedEan": "800..." | null,
//   "sameImageEans": ["..."], "bbox": {x,y,width,height} (optional, relative), "kind": "...", "note": "..." } ] }
// Files are resolved relative to the JSON file's folder "queries/" subfolder or the JSON folder itself.
//
// Metrics: Recall@1/@5 on queries whose product is in the catalogue (strict = exact EAN; lenient = any
// product sharing the same catalogue photo), false matches and abstention on out-of-catalogue queries,
// score distributions and SUGGESTED thresholds, latency. Leakage check: a query byte-identical to a
// catalogue image is flagged (it proves the pipeline, not real-world quality).
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { pool } from '../db/pool.ts';
import { sha256 } from '../lib/hash.ts';
import { parseBarcode } from '../lib/gtin.ts';
import { makeInferImage } from '../vision/preprocess.ts';
import { getEmbedder } from '../vision/embedder.ts';
import { getActiveModel, indexCoverage } from '../vision/index-admin.ts';
import { decodeRetailBarcodes } from '../vision/barcode.ts';
import { aggregateByProduct, nearestImages } from '../search/photo.ts';

const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== '--'), options: { set: { type: 'string', default: 'fixtures/demo/queries.json' }, crop: { type: 'boolean', default: false }, out: { type: 'string', default: 'bench-results' } } });
const setPath = path.resolve(values.set!);
const set = JSON.parse(await readFile(setPath, 'utf8'));
const active = await getActiveModel(pool);
if (!active) throw new Error('Nessun modello attivo');
const coverage = await indexCoverage(pool, active.key);
const embedder = getEmbedder(active.spec.id);
await embedder.load();

const gtinToProduct = new Map<string, string>(
  (await pool.query(`SELECT value, product_id FROM product_identifiers WHERE kind = 'gtin'`)).rows.map((r) => [r.value, r.product_id]),
);
const catalogueShas = new Set((await pool.query(`SELECT sha256 FROM image_assets`)).rows.map((r) => r.sha256));
const productOf = (ean: string | null) => (ean ? gtinToProduct.get(parseBarcode(ean).gtin14 ?? '') ?? null : null);

interface Row {
  file: string;
  kind: string;
  expected: string | null;
  inCatalogue: boolean;
  rankStrict: number | null;
  rankLenient: number | null;
  top1Score: number | null;
  expectedScore: number | null;
  top5: Array<{ productId: string; score: number }>;
  barcode: string | null;
  barcodeMatches: boolean;
  leakage: boolean;
  ms: { preprocess: number; embed: number; ann: number; aggregate: number };
}

const rows: Row[] = [];
for (const q of set.queries) {
  const candidates = [path.join(path.dirname(setPath), 'queries', q.file), path.join(path.dirname(setPath), q.file)];
  const file = candidates.find((c) => existsSync(c));
  if (!file) throw new Error(`File query non trovato: ${q.file}`);
  const bytes = await readFile(file);
  const t0 = performance.now();
  const crop = values.crop && q.bbox ? q.bbox : null;
  const infer = await makeInferImage(bytes, crop);
  const t1 = performance.now();
  const vec = await embedder.embed(infer);
  const t2 = performance.now();
  const hits = await nearestImages(active.key, active.spec.dim, vec);
  const t3 = performance.now();
  const byProduct = [...(await aggregateByProduct(hits)).entries()].sort((a, b) => b[1].score - a[1].score);
  const t4 = performance.now();
  const expected = productOf(q.expectedEan);
  const siblings = new Set((q.sameImageEans ?? []).map(productOf).filter(Boolean));
  if (expected) siblings.add(expected);
  const rankStrict = expected ? byProduct.findIndex(([pid]) => pid === expected) : -1;
  const rankLenient = byProduct.findIndex(([pid]) => siblings.has(pid));
  let barcode: string | null = null;
  try {
    const found = await decodeRetailBarcodes(bytes);
    barcode = found.find((f) => f.parsed.status === 'valid')?.parsed.gtin14 ?? null;
  } catch {}
  rows.push({
    file: q.file,
    kind: q.kind ?? (q.expectedEan ? 'in_catalog' : 'out_of_catalog'),
    expected: q.expectedEan ?? null,
    inCatalogue: !!expected,
    rankStrict: rankStrict >= 0 ? rankStrict + 1 : null,
    rankLenient: rankLenient >= 0 ? rankLenient + 1 : null,
    top1Score: byProduct[0]?.[1].score ?? null,
    expectedScore: expected ? byProduct.find(([pid]) => pid === expected)?.[1].score ?? null : null,
    top5: byProduct.slice(0, 5).map(([productId, v]) => ({ productId, score: Math.round(v.score * 1000) / 1000 })),
    barcode,
    barcodeMatches: !!barcode && !!expected && gtinToProduct.get(barcode) === expected,
    leakage: catalogueShas.has(sha256(bytes)),
    ms: { preprocess: t1 - t0, embed: t2 - t1, ann: t3 - t2, aggregate: t4 - t3 },
  });
}

const pos = rows.filter((r) => r.inCatalogue);
// Ground truth "not in catalogue": no label, or a label whose EAN is not in this catalogue.
const neg = rows.filter((r) => !r.inCatalogue);
const missingLabels = rows.filter((r) => r.expected && !r.inCatalogue);
const recall = (k: number, key: 'rankStrict' | 'rankLenient') => (pos.length ? pos.filter((r) => r[key] !== null && r[key]! <= k).length / pos.length : null);
const t = active.thresholds;
const falseMatches = neg.filter((r) => (r.top1Score ?? 0) >= t.possible).length;
const abstained = neg.filter((r) => (r.top1Score ?? 0) < t.similar).length;
const q = (arr: number[], p: number) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(p * arr.length))] : null);

// Threshold suggestion (on THIS set only): lowest "possible" threshold with no negative above it and
// the best recall of correct top-1; "similar" at the 10th percentile of correct top-1 scores.
const correctTop1 = pos.filter((r) => r.rankLenient === 1).map((r) => r.top1Score!).sort((a, b) => a - b);
const negTop1 = neg.map((r) => r.top1Score ?? 0).sort((a, b) => a - b);
const maxNeg = negTop1.at(-1) ?? 0;
const suggestedPossible = correctTop1.find((s) => s > maxNeg) ?? null;
// The "similar" floor decides which ALTERNATIVES are worth showing: it needs operator judgements on
// alternative quality (not derivable from identity labels), so it is not suggested automatically.
const suggestedSimilar = null;

const lat = (k: keyof Row['ms']) => ({ p50: round(q(rows.map((r) => r.ms[k]), 0.5)), p95: round(q(rows.map((r) => r.ms[k]), 0.95)) });
const report = {
  generatedAt: new Date().toISOString(),
  set: path.relative(process.cwd(), setPath),
  synthetic: !!set.synthetic,
  crop: values.crop,
  model: { key: active.key, thresholds: t },
  catalogue: coverage,
  hardware: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGb: Math.round(os.totalmem() / 1e9), platform: `${process.platform}/${process.arch}`, node: process.version },
  counts: { queries: rows.length, inCatalogue: pos.length, outOfCatalogue: neg.length, missingLabels: missingLabels.length, leakage: rows.filter((r) => r.leakage).length },
  metrics: {
    recallAt1Strict: recall(1, 'rankStrict'),
    recallAt5Strict: recall(5, 'rankStrict'),
    recallAt1Lenient: recall(1, 'rankLenient'),
    recallAt5Lenient: recall(5, 'rankLenient'),
    negatives: { falseMatchesAtPossible: falseMatches, abstainedBelowSimilar: abstained, total: neg.length },
    barcode: { decoded: rows.filter((r) => r.barcode).length, confirmedCorrect: rows.filter((r) => r.barcodeMatches).length },
    scores: {
      correctTop1: { min: correctTop1[0] ?? null, p50: q(correctTop1, 0.5), max: correctTop1.at(-1) ?? null },
      negativeTop1: { min: negTop1[0] ?? null, p50: q(negTop1, 0.5), max: negTop1.at(-1) ?? null },
    },
    suggestedThresholds: { possible: suggestedPossible, similar: suggestedSimilar, note: 'possible: minimo score top-1 corretto sopra il massimo dei negativi, SOLO su questo set; similar: richiede valutazione delle alternative da parte di un operatore.' },
  },
  latencyMs: { preprocess: lat('preprocess'), embed: lat('embed'), ann: lat('ann'), aggregate: lat('aggregate') },
  rows,
};

await mkdir(values.out!, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const base = path.join(values.out!, `visual-${values.crop ? 'crop-' : ''}${stamp}`);
await writeFile(`${base}.json`, JSON.stringify(report, null, 2));
const pct = (v: number | null) => (v === null ? 'n/d' : `${Math.round(v * 1000) / 10}%`);
const md = `# Benchmark visivo — ${report.generatedAt}

- Set: \`${report.set}\` ${report.synthetic ? '(**SINTETICO**: dimostra la pipeline, non la qualità reale)' : ''}
- Ritaglio simulato: ${values.crop ? 'sì (riquadro etichettato)' : 'no (foto intera)'}
- Modello: \`${active.key}\` — soglie possible=${t.possible} similar=${t.similar} calibrate=${t.calibrated}
- Catalogo indicizzato: ${coverage.indexed}/${coverage.assets} immagini
- Hardware: ${report.hardware.cpu}, ${report.hardware.cores} core, ${report.hardware.ramGb} GB, ${report.hardware.platform}, Node ${report.hardware.node}
- Query: ${rows.length} (a catalogo ${pos.length}, fuori catalogo ${neg.length} di cui ${missingLabels.length} con EAN non presente nel catalogo, leakage ${report.counts.leakage})

| Metrica | Valore |
|---|---|
| Recall@1 (EAN esatto) | ${pct(report.metrics.recallAt1Strict)} |
| Recall@5 (EAN esatto) | ${pct(report.metrics.recallAt5Strict)} |
| Recall@1 (anche varianti con stessa foto) | ${pct(report.metrics.recallAt1Lenient)} |
| Recall@5 (anche varianti con stessa foto) | ${pct(report.metrics.recallAt5Lenient)} |
| Falsi match su fuori catalogo (score ≥ possible) | ${falseMatches}/${neg.length} |
| Astensione su fuori catalogo (score < similar) | ${abstained}/${neg.length} |
| Barcode letti / confermati corretti | ${report.metrics.barcode.decoded} / ${report.metrics.barcode.confirmedCorrect} |
| Score top-1 corretti (min/mediana/max) | ${fmt(report.metrics.scores.correctTop1)} |
| Score top-1 negativi (min/mediana/max) | ${fmt(report.metrics.scores.negativeTop1)} |
| Soglia "possibile" suggerita su questo set | ${suggestedPossible?.toFixed(3) ?? 'n/d'} (la soglia "simili" richiede giudizio dell'operatore) |
| Latenza embed p50/p95 (ms) | ${report.latencyMs.embed.p50} / ${report.latencyMs.embed.p95} |
| Latenza ANN p50/p95 (ms) | ${report.latencyMs.ann.p50} / ${report.latencyMs.ann.p95} |
`;
await writeFile(`${base}.md`, md);
console.log(md);
console.log(`report: ${base}.json`);
await pool.end();

function round(v: number | null) {
  return v === null ? null : Math.round(v);
}
function fmt(s: { min: number | null; p50: number | null; max: number | null }) {
  return [s.min, s.p50, s.max].map((v) => (v === null ? 'n/d' : v.toFixed(3))).join(' / ');
}
