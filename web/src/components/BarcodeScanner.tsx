import { useEffect, useRef, useState } from 'react';
import { Modal, Notice } from './ui';
import { expandUpcE, isGtinCheckDigitValid } from './imagePrep';

// Live barcode scanning: native BarcodeDetector when available (Chrome/Android), otherwise zxing-wasm
// served from our own origin (no CDN). Manual entry is always available.
type Detector = (source: HTMLVideoElement | HTMLCanvasElement) => Promise<string | null>;

/** The code to search: a UPC-E symbol is expanded to its UPC-A. */
const searchable = (text: string, format: string | undefined) => (/^upc_?e$/i.test(format ?? '') ? expandUpcE(text) ?? text : text);

async function createDetector(): Promise<Detector> {
  const BD = (window as any).BarcodeDetector;
  if (BD) {
    try {
      const supported: string[] = await BD.getSupportedFormats();
      const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter((f) => supported.includes(f));
      if (formats.length) {
        const det = new BD({ formats });
        return async (src) => {
          const codes = await det.detect(src);
          return codes[0] ? searchable(codes[0].rawValue, codes[0].format) : null;
        };
      }
    } catch {
      /* fall back to zxing */
    }
  }
  const [{ readBarcodes, prepareZXingModule }, wasm] = await Promise.all([import('zxing-wasm/reader'), import('zxing-wasm/reader/zxing_reader.wasm?url')]);
  prepareZXingModule({ overrides: { locateFile: (p: string, prefix: string) => (p.endsWith('.wasm') ? wasm.default : prefix + p) } });
  const canvas = document.createElement('canvas');
  return async (src) => {
    const video = src as HTMLVideoElement;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0, w, h);
    const results = await readBarcodes(ctx.getImageData(0, 0, w, h), { formats: ['EAN13', 'EAN8', 'UPCA', 'UPCE'], tryHarder: true, maxNumberOfSymbols: 1 });
    const found = results.find((r) => r.isValid);
    return found ? searchable(found.text, found.format) : null;
  };
}

export function BarcodeScanner({ open, onClose, onCode }: { open: boolean; onClose: () => void; onCode: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualWarnedFor, setManualWarnedFor] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // The latest onCode without restarting the camera: parents often pass a new function on every render.
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: number | undefined;
    const release = () => stream?.getTracks().forEach((t) => t.stop());
    setError(null);
    setManual('');
    setManualError(null);
    setManualWarnedFor(null);
    (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError('La fotocamera richiede una connessione sicura (HTTPS) e un browser compatibile. Inserisci il codice a mano.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
      } catch {
        setError('Accesso alla fotocamera non consentito o non disponibile. Inserisci il codice a mano.');
        return;
      }
      // Closed while the permission prompt was open: the cleanup ran before the stream existed.
      if (stopped) {
        release();
        return;
      }
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setScanning(true);
      let detect: Detector;
      try {
        detect = await createDetector();
      } catch {
        release();
        setError('Lettore di codici non disponibile su questo dispositivo. Inserisci il codice a mano.');
        return;
      }
      if (stopped) {
        release();
        return;
      }
      const tick = async () => {
        if (stopped) return;
        try {
          const code = await detect(video);
          if (code && /^\d{8,14}$/.test(code)) {
            stopped = true;
            navigator.vibrate?.(60);
            onCodeRef.current(code);
            return;
          }
        } catch {
          /* keep scanning */
        }
        timer = window.setTimeout(tick, 250);
      };
      tick();
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      release();
      setScanning(false);
    };
  }, [open]);

  const submitManual = (e: React.FormEvent) => {
    e.preventDefault();
    const code = manual.replace(/[\s-]/g, '');
    if (!/^\d{6,14}$/.test(code)) {
      setManualError('Inserisci solo cifre (8, 12, 13 o 14 per EAN/UPC/GTIN, oppure un codice interno)');
      return;
    }
    // A wrong check digit is usually a typo: warn first, search as typed only if confirmed.
    if (/^\d{8}$|^\d{12,14}$/.test(code) && !isGtinCheckDigitValid(code) && manualWarnedFor !== code) {
      setManualWarnedFor(code);
      setManualError('La cifra di controllo non è valida: controlla il codice, oppure premi di nuovo «Cerca codice» per cercarlo così com’è.');
      return;
    }
    setManualError(null);
    onCode(code);
  };

  return (
    <Modal open={open} onClose={onClose} title="Leggi codice a barre">
      <div className="stack">
        {error ? <Notice kind="warning">{error}</Notice> : <video ref={videoRef} className="scanner-video" muted playsInline aria-label="Anteprima fotocamera" />}
        {scanning && !error && <p className="muted small">Inquadra il codice EAN/UPC della confezione: la lettura è automatica.</p>}
        <form onSubmit={submitManual} className="stack" aria-label="Inserimento manuale">
          <div className="field">
            <label htmlFor="manual-code">Oppure inserisci il codice a mano</label>
            <div className="row">
              <input id="manual-code" className="input" inputMode="numeric" autoComplete="off" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="es. 8001234567890" style={{ flex: 1 }} />
              <button className="btn btn-primary" type="submit">
                Cerca codice
              </button>
            </div>
            {manualError && <span className="error-text">{manualError}</span>}
          </div>
        </form>
      </div>
    </Modal>
  );
}
