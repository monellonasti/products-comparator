import { useEffect, useState } from 'react';
import ReactCrop, { type PercentCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { Modal } from './ui';

export interface RelativeCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Optional crop before searching: the user can isolate the product from a cluttered background. */
export function CropDialog({
  open, imageSrc, initial, onCancel, onConfirm, busy,
}: {
  open: boolean;
  imageSrc: string | null;
  initial?: RelativeCrop | null;
  onCancel: () => void;
  onConfirm: (crop: RelativeCrop | null) => void;
  busy?: boolean;
}) {
  const [crop, setCrop] = useState<PercentCrop | undefined>();
  useEffect(() => {
    setCrop(initial ? { unit: '%', x: initial.x * 100, y: initial.y * 100, width: initial.width * 100, height: initial.height * 100 } : undefined);
  }, [imageSrc, initial]);
  const valid = crop && crop.width > 2 && crop.height > 2;
  const toRelative = (c: PercentCrop): RelativeCrop => ({
    x: Math.max(0, c.x / 100), y: Math.max(0, c.y / 100), width: Math.min(1, c.width / 100), height: Math.min(1, c.height / 100),
  });
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Ritaglia il prodotto (facoltativo)"
      footer={
        <>
          <button className="btn" onClick={onCancel} disabled={busy}>
            Annulla
          </button>
          <button className="btn" onClick={() => onConfirm(null)} disabled={busy}>
            Cerca con la foto intera
          </button>
          <button className="btn btn-primary" onClick={() => valid && onConfirm(toRelative(crop!))} disabled={!valid || busy}>
            {busy ? 'Ricerca in corso…' : 'Cerca nell’area selezionata'}
          </button>
        </>
      }
    >
      <p className="muted small">Trascina sulla foto per selezionare solo il prodotto: migliora i risultati quando lo sfondo è confuso o ci sono più oggetti.</p>
      {imageSrc && (
        <div className="crop-area">
          <ReactCrop crop={crop} onChange={(_, pc) => setCrop(pc)} keepSelection ruleOfThirds>
            <img src={imageSrc} alt="Foto da cercare" />
          </ReactCrop>
        </div>
      )}
    </Modal>
  );
}
