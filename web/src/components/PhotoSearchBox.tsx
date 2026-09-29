import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import type { PhotoSearchResult } from '../types';
import { CropDialog, type RelativeCrop } from './CropDialog';
import { BarcodeScanner } from './BarcodeScanner';
import { prepareImage } from './imagePrep';
import { ErrorNotice } from './ui';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif,image/gif';

export async function runPhotoSearch(file: Blob, crop: RelativeCrop | null, barcode?: string | null): Promise<PhotoSearchResult> {
  const form = new FormData();
  if (crop) form.append('crop', JSON.stringify(crop));
  if (barcode) form.append('barcode', barcode);
  form.append('image', file, 'foto.jpg');
  return api.upload<PhotoSearchResult>('/api/search/photo', form);
}

export function PhotoSearchBox({ onTextSearch, initialText }: { onTextSearch: (q: string) => void; initialText: string }) {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [text, setText] = useState(initialText);

  useEffect(() => setText(initialText), [initialText]);

  const accept = useCallback(async (file: File | Blob | null | undefined) => {
    setError(null);
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) {
      setError(new Error('Il file selezionato non è un’immagine'));
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setError(new Error('Immagine troppo grande (massimo 25 MB)'));
      return;
    }
    const blob = await prepareImage(file);
    setPending((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { blob, url: URL.createObjectURL(blob) };
    });
  }, []);

  // Paste an image anywhere on the page (Ctrl/Cmd+V), where the browser supports it.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // In a text field a normal text paste wins; a pasted screenshot (no text) still starts a photo search.
      const target = e.target as HTMLElement | null;
      const inTextField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if (inTextField && e.clipboardData?.types.includes('text/plain')) return;
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
      if (item) {
        e.preventDefault();
        void accept(item.getAsFile());
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [accept]);

  const search = async (crop: RelativeCrop | null) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runPhotoSearch(pending.blob, crop);
      URL.revokeObjectURL(pending.url);
      setPending(null);
      navigate(`/ricerca/${result.searchId}`, { state: { result } });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const onBarcode = useCallback(
    (code: string) => {
      setScannerOpen(false);
      onTextSearch(code);
    },
    [onTextSearch],
  );

  return (
    <section className="search-hero" aria-labelledby="search-title">
      <h1 id="search-title" className="sr-only">
        Cerca un prodotto
      </h1>
      <div className="search-hero-grid">
        <div
          className={`dropzone${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void accept(e.dataTransfer.files?.[0]);
          }}
        >
          <strong>Cerca con una foto</strong>
          <span className="muted small">Trascina qui un’immagine, incollala (Ctrl+V) oppure:</span>
          <div className="dropzone-actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={() => cameraRef.current?.click()}>
              📷 Scatta foto
            </button>
            <button type="button" className="btn btn-lg" onClick={() => fileRef.current?.click()}>
              Scegli immagine
            </button>
          </div>
          <input ref={fileRef} type="file" accept={ACCEPT} hidden onChange={(e) => { void accept(e.target.files?.[0]); e.target.value = ''; }} />
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void accept(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
        <div className="text-search">
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              onTextSearch(text.trim());
            }}
          >
            <label htmlFor="q" className="sr-only">
              Cerca per testo, EAN o codice fornitore
            </label>
            <input id="q" className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Nome, marca, EAN o codice fornitore" autoComplete="off" />
            <button className="btn btn-primary" type="submit">
              Cerca
            </button>
          </form>
          <div className="row">
            <button type="button" className="btn" onClick={() => setScannerOpen(true)}>
              ▦ Leggi codice a barre
            </button>
            <span className="muted small">Fotocamera sui dispositivi compatibili, inserimento manuale sempre disponibile.</span>
          </div>
        </div>
      </div>
      {error && !pending ? <div style={{ marginTop: 12 }}><ErrorNotice error={error} /></div> : null}
      <CropDialog
        open={!!pending}
        imageSrc={pending?.url ?? null}
        busy={busy}
        error={pending ? error : null}
        onCancel={() => {
          if (pending) URL.revokeObjectURL(pending.url);
          setPending(null);
          setError(null);
        }}
        onConfirm={(crop) => void search(crop)}
      />
      <BarcodeScanner open={scannerOpen} onClose={() => setScannerOpen(false)} onCode={onBarcode} />
    </section>
  );
}
