import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import type { ColumnMapping, ImportDefaults, ImportRun, Supplier, TargetField } from '../types';
import { ErrorNotice, Notice, Spinner, useDocumentTitle } from '../components/ui';
import { dateTime, money } from '../format';

interface Inspect {
  run: ImportRun;
  headers: string[];
  sample: Array<{ rowNumber: number; values: Record<string, unknown> }>;
  detected: { encoding?: string; delimiter?: string; sheet?: string; sheets?: string[]; decimalSeparator?: '.' | ',' };
  warnings: string[];
  suggestedMapping: ColumnMapping;
  suggestedDefaults: ImportDefaults;
  duplicateOf: { id: string; createdAt: string; status: string } | null;
}

interface Preview {
  totalSampled: number;
  rows: Array<{
    rowNumber: number; sku: string | null; barcode: { raw: string | null; status: string }; title: string | null; brand: string | null; price: string | null;
    currency: string | null; unitPrice: string | null; priceNote: string | null; stock: { quantity: number | null; status: string; raw: string | null };
    images: number; existingOffer: boolean; gtinInCatalog: boolean; issues: Array<{ severity: string; code: string; message: string; field: string | null }>;
  }>;
  summary: { errors: number; warnings: number; byCode: Array<{ code: string; severity: string; count: number; message: string }>; barcode: Record<string, number>; newOffers: number; updatedOffers: number; gtinMatches: number };
}

const STEPS = ['File', 'Lettura', 'Colonne', 'Anteprima e conferma'];

export default function ImportWizardPage() {
  useDocumentTitle('Nuovo import');
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<{ items: Supplier[] }>('/api/suppliers') });
  const fields = useQuery({ queryKey: ['import-fields'], queryFn: () => api.get<{ fields: TargetField[] }>('/api/imports/fields') });
  const [step, setStep] = useState(0);
  const [supplierId, setSupplierId] = useState(params.get('supplier') ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<Inspect | null>(null);
  const [opts, setOpts] = useState<Record<string, any>>({});
  const [mapping, setMapping] = useState<ColumnMapping>({ fields: {} });
  const [defaults, setDefaults] = useState<ImportDefaults>({ currency: 'EUR', vatTreatment: 'unknown', vatRate: null, unitsPerPack: 1, salesUnit: null });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mode, setMode] = useState<'snapshot' | 'delta'>('delta');
  const [asOf, setAsOf] = useState('');
  const [saveProfile, setSaveProfile] = useState(true);

  useEffect(() => {
    if (inspect) {
      setOpts(inspect.run.parseOptions ?? {});
      setMapping(inspect.suggestedMapping);
      setDefaults(inspect.suggestedDefaults);
    }
  }, [inspect]);

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('supplierId', supplierId);
      form.append('file', file!, file!.name);
      return api.upload<Inspect>('/api/imports', form);
    },
    onSuccess: (r) => {
      setInspect(r);
      setStep(1);
    },
  });
  const reread = useMutation({
    mutationFn: () => api.post<Inspect>(`/api/imports/${inspect!.run.id}/inspect`, opts),
    onSuccess: (r) => setInspect((prev) => ({ ...prev!, ...r, suggestedDefaults: prev!.suggestedDefaults, duplicateOf: prev!.duplicateOf })),
  });
  const doPreview = useMutation({
    mutationFn: () => api.post<Preview>(`/api/imports/${inspect!.run.id}/preview`, { mapping: cleanMapping(mapping), defaults, parseOptions: opts }),
    onSuccess: (r) => {
      setPreview(r);
      setStep(3);
    },
  });
  const start = useMutation({
    mutationFn: () =>
      api.post<{ run: ImportRun }>(`/api/imports/${inspect!.run.id}/start`, {
        mapping: cleanMapping(mapping), defaults, parseOptions: opts, mode, asOf: asOf ? new Date(asOf).toISOString() : null, saveProfile,
      }),
    onSuccess: (r) => navigate(`/importazioni/${r.run.id}`),
  });

  const headers = inspect?.headers ?? [];
  const used = useMemo(() => new Set(Object.values(mapping.fields).flat()), [mapping]);
  if (!isAdmin) return <div className="page"><Notice kind="warning">Solo gli amministratori possono importare listini.</Notice></div>;

  return (
    <div className="page page-narrow">
      <nav className="small" style={{ marginBottom: 8 }}><Link to="/importazioni">Importazioni</Link> › Nuovo import</nav>
      <h1 style={{ marginTop: 0 }}>Importa un listino</h1>
      <ol className="row" aria-label="Passaggi" style={{ listStyle: 'none', padding: 0, gap: 6 }}>
        {STEPS.map((s, i) => (
          <li key={s} className={`badge ${i === step ? 'badge-info' : i < step ? 'badge-ok' : 'badge-neutral'}`} aria-current={i === step ? 'step' : undefined}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="card stack">
          <div className="field">
            <label htmlFor="w-supplier">Fornitore</label>
            <select id="w-supplier" className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Seleziona…</option>
              {suppliers.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {suppliers.data?.items.length === 0 && <span className="field-hint">Nessun fornitore: <Link to="/fornitori">creane uno</Link>.</span>}
          </div>
          <div className="field">
            <label htmlFor="w-file">File del listino (CSV o XLSX)</label>
            <input id="w-file" className="input" type="file" accept=".csv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <span className="field-hint">I file vengono letti come dati: formule e HTML non vengono eseguiti. Il file originale viene conservato per la tracciabilità.</span>
          </div>
          <ErrorNotice error={upload.error} />
          <div className="row">
            <span className="spacer" />
            <button className="btn btn-primary" disabled={!supplierId || !file || upload.isPending} onClick={() => upload.mutate()}>
              {upload.isPending ? 'Caricamento…' : 'Carica e leggi'}
            </button>
          </div>
        </div>
      )}

      {step === 1 && inspect && (
        <div className="card stack">
          {inspect.duplicateOf && (
            <Notice kind="info">
              Questo file è identico a uno già caricato il {dateTime(inspect.duplicateOf.createdAt)}. Reimportarlo non crea duplicati: aggiorna solo la data di verifica dei dati.
            </Notice>
          )}
          {inspect.warnings.map((w) => <Notice key={w} kind="warning">{w}</Notice>)}
          <div className="form-grid">
            {inspect.run.fileKind === 'csv' ? (
              <>
                <div className="field">
                  <label htmlFor="o-delim">Separatore</label>
                  <select id="o-delim" className="input" value={opts.delimiter === String.fromCharCode(9) ? '\\t' : opts.delimiter ?? ''} onChange={(e) => setOpts({ ...opts, delimiter: e.target.value })}>
                    <option value=";">Punto e virgola ;</option>
                    <option value=",">Virgola ,</option>
                    <option value="\t">Tabulazione</option>
                    <option value="|">Barra verticale |</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="o-enc">Codifica</label>
                  <select id="o-enc" className="input" value={opts.encoding ?? 'utf-8'} onChange={(e) => setOpts({ ...opts, encoding: e.target.value })}>
                    <option value="utf-8">UTF-8</option>
                    <option value="windows-1252">Windows-1252 (Excel italiano)</option>
                    <option value="iso-8859-1">ISO-8859-1</option>
                    <option value="utf-16le">UTF-16</option>
                  </select>
                </div>
              </>
            ) : (
              <div className="field">
                <label htmlFor="o-sheet">Foglio</label>
                <select id="o-sheet" className="input" value={opts.sheet ?? ''} onChange={(e) => setOpts({ ...opts, sheet: e.target.value })}>
                  {(inspect.detected.sheets ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="o-header">Riga intestazioni</label>
              <input id="o-header" className="input" type="number" min={1} max={50} value={opts.headerRow ?? 1} onChange={(e) => setOpts({ ...opts, headerRow: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label htmlFor="o-dec">Separatore decimale</label>
              <select id="o-dec" className="input" value={opts.decimalSeparator ?? '.'} onChange={(e) => setOpts({ ...opts, decimalSeparator: e.target.value })}>
                <option value=",">Virgola (12,50)</option>
                <option value=".">Punto (12.50)</option>
              </select>
            </div>
          </div>
          <div className="row">
            <button className="btn" onClick={() => reread.mutate()} disabled={reread.isPending}>Rileggi con queste impostazioni</button>
            <span className="muted small">Rilevati: {[inspect.detected.encoding, inspect.detected.delimiter && `separatore “${inspect.detected.delimiter === '\t' ? 'tab' : inspect.detected.delimiter}”`, inspect.detected.sheet].filter(Boolean).join(' · ')}</span>
          </div>
          <ErrorNotice error={reread.error} />
          <SampleTable headers={headers} rows={inspect.sample.slice(0, 8)} />
          <div className="row">
            <button className="btn" onClick={() => setStep(0)}>Indietro</button>
            <span className="spacer" />
            <button className="btn btn-primary" onClick={() => setStep(2)}>Avanti: colonne</button>
          </div>
        </div>
      )}

      {step === 2 && inspect && (
        <div className="card stack">
          <p className="muted small" style={{ margin: 0 }}>Associa le colonne del file ai campi. Il codice fornitore (SKU) è la chiave degli aggiornamenti: righe con lo stesso SKU aggiornano la stessa offerta.</p>
          <div className="form-grid">
            {fields.data?.fields.map((f) =>
              f.multi ? (
                <div className="field" key={f.key} style={{ gridColumn: '1 / -1' }}>
                  <span style={{ fontWeight: 500, fontSize: 14 }}>{f.label}</span>
                  <div className="row" style={{ gap: 10 }}>
                    {headers.map((h) => (
                      <label key={h} className="checkbox small">
                        <input
                          type="checkbox"
                          checked={((mapping.fields[f.key] as string[]) ?? []).includes(h)}
                          onChange={(e) => {
                            const cur = ((mapping.fields[f.key] as string[]) ?? []).filter((c) => c !== h);
                            setMapping({ ...mapping, fields: { ...mapping.fields, [f.key]: e.target.checked ? [...cur, h] : cur } });
                          }}
                        />
                        {h}
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="field" key={f.key}>
                  <label htmlFor={`m-${f.key}`}>
                    {f.label}
                    {f.required && ' *'}
                  </label>
                  <select
                    id={`m-${f.key}`}
                    className="input"
                    value={(mapping.fields[f.key] as string) ?? ''}
                    onChange={(e) => setMapping({ ...mapping, fields: { ...mapping.fields, [f.key]: e.target.value } })}
                  >
                    <option value="">— non presente —</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                        {used.has(h) && mapping.fields[f.key] !== h ? ' (già usata)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ),
            )}
          </div>
          <h3>Condizioni dei prezzi di questo file</h3>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="d-vat">I prezzi sono</label>
              <select id="d-vat" className="input" value={defaults.vatTreatment} onChange={(e) => setDefaults({ ...defaults, vatTreatment: e.target.value as any })}>
                <option value="net">IVA esclusa (netti)</option>
                <option value="gross">IVA inclusa</option>
                <option value="unknown">Non dichiarato (non confrontabili)</option>
              </select>
            </div>
            {defaults.vatTreatment === 'gross' && (
              <div className="field">
                <label htmlFor="d-rate">Aliquota IVA % (se non c’è la colonna)</label>
                <input id="d-rate" className="input" value={defaults.vatRate ?? ''} onChange={(e) => setDefaults({ ...defaults, vatRate: e.target.value.replace(',', '.') || null })} />
              </div>
            )}
            <div className="field">
              <label htmlFor="d-cur">Valuta (se non c’è la colonna)</label>
              <input id="d-cur" className="input mono" maxLength={3} value={defaults.currency ?? ''} onChange={(e) => setDefaults({ ...defaults, currency: e.target.value.toUpperCase() || null })} />
            </div>
            <div className="field">
              <label htmlFor="d-pack">Il prezzo si riferisce a (pezzi), se non c’è la colonna</label>
              <input id="d-pack" className="input" type="number" min={1} value={defaults.unitsPerPack ?? ''} placeholder="non dichiarato" onChange={(e) => setDefaults({ ...defaults, unitsPerPack: e.target.value ? Number(e.target.value) : null })} />
            </div>
          </div>
          <ErrorNotice error={doPreview.error} />
          <div className="row">
            <button className="btn" onClick={() => setStep(1)}>Indietro</button>
            <span className="spacer" />
            <button className="btn btn-primary" disabled={!mapping.fields.sku || doPreview.isPending} onClick={() => doPreview.mutate()}>
              {doPreview.isPending ? 'Verifica…' : 'Verifica anteprima'}
            </button>
          </div>
        </div>
      )}

      {step === 3 && preview && (
        <div className="stack">
          <div className="card">
            <h2>Anteprima sulle prime {preview.totalSampled} righe</h2>
            <div className="row">
              <span className="badge badge-info">{preview.summary.newOffers} nuove offerte</span>
              <span className="badge badge-neutral">{preview.summary.updatedOffers} aggiornamenti</span>
              <span className="badge badge-ok">{preview.summary.gtinMatches} EAN già nel catalogo</span>
              {preview.summary.errors > 0 && <span className="badge badge-bad">{preview.summary.errors} righe con errori (non importate)</span>}
              {preview.summary.warnings > 0 && <span className="badge badge-warn">{preview.summary.warnings} righe con avvisi</span>}
            </div>
            <p className="small muted">EAN: {Object.entries(preview.summary.barcode).map(([k, v]) => `${v} ${k === 'valid' ? 'validi' : k === 'missing' ? 'assenti' : k === 'invalid' ? 'non validi' : k === 'restricted' ? 'interni' : k}`).join(' · ')}</p>
            {preview.summary.byCode.length > 0 && (
              <ul className="small" style={{ paddingLeft: 18 }}>
                {preview.summary.byCode.map((c) => (
                  <li key={c.code} className={c.severity === 'error' ? 'error-text' : undefined}>
                    {c.count}× {c.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Riga</th><th>SKU</th><th>EAN</th><th>Titolo</th><th className="num">Prezzo</th><th className="num">Netto/pz</th><th>Stock</th><th>Esito</th></tr></thead>
              <tbody>
                {preview.rows.slice(0, 40).map((r) => (
                  <tr key={r.rowNumber}>
                    <td>{r.rowNumber}</td>
                    <td className="mono">{r.sku ?? '—'}</td>
                    <td className="mono">{r.barcode.raw ?? '—'}<div className="small muted">{r.barcode.status}{r.gtinInCatalog ? ' · già nel catalogo' : ''}</div></td>
                    <td>{r.title ?? '—'}<div className="small muted">{r.brand ?? ''}</div></td>
                    <td className="num">{money(r.price, r.currency)}</td>
                    <td className="num">{r.unitPrice ? money(r.unitPrice, r.currency) : <span className="small muted">{r.priceNote ?? '—'}</span>}</td>
                    <td className="small">{r.stock.quantity ?? r.stock.raw ?? '—'}</td>
                    <td className="small">
                      {r.issues.length === 0 ? <span className="badge badge-ok">ok</span> : r.issues.map((i) => <div key={i.code} className={i.severity === 'error' ? 'error-text' : 'muted'}>{i.message}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card stack">
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ fontWeight: 600, marginBottom: 6 }}>Tipo di file</legend>
              <label className="checkbox"><input type="radio" name="mode" checked={mode === 'delta'} onChange={() => setMode('delta')} /> Aggiornamento parziale: aggiorna le righe presenti, non tocca le altre offerte</label>
              <label className="checkbox"><input type="radio" name="mode" checked={mode === 'snapshot'} onChange={() => setMode('snapshot')} /> Listino completo: le offerte assenti dal file diventano “non più a listino” (solo se l’import riesce e il file non sembra parziale)</label>
            </fieldset>
            <div className="field" style={{ maxWidth: 320 }}>
              <label htmlFor="as-of">Data dei dati del listino <span className="field-hint">vuoto = adesso; dati più vecchi di quelli presenti non li sovrascrivono</span></label>
              <input id="as-of" className="input" type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </div>
            <label className="checkbox"><input type="checkbox" checked={saveProfile} onChange={(e) => setSaveProfile(e.target.checked)} /> Salva questa mappatura per i prossimi import del fornitore</label>
            <ErrorNotice error={start.error} />
            <div className="row">
              <button className="btn" onClick={() => setStep(2)}>Indietro</button>
              <span className="spacer" />
              <button className="btn btn-primary btn-lg" disabled={start.isPending} onClick={() => start.mutate()}>
                {start.isPending ? 'Avvio…' : 'Conferma e importa'}
              </button>
            </div>
          </div>
        </div>
      )}
      {(upload.isPending || reread.isPending) && <Spinner />}
    </div>
  );
}

function cleanMapping(m: ColumnMapping): ColumnMapping {
  const fields: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(m.fields)) {
    if (Array.isArray(v) ? v.length : v) fields[k] = v;
  }
  return { fields, tiers: m.tiers?.filter((t) => t.column) };
}

function SampleTable({ headers, rows }: { headers: string[]; rows: Array<{ rowNumber: number; values: Record<string, unknown> }> }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Riga</th>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rowNumber}>
              <td>{r.rowNumber}</td>
              {headers.map((h) => <td key={h} className="small">{String(r.values[h] ?? '').slice(0, 60)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
