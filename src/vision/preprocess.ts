// Image validation and derivatives. The "infer" derivative is produced by the SAME function for
// catalogue images and query photos (preprocessing version pp1), so vectors are comparable:
//   EXIF auto-orient -> optional crop -> flatten on white -> fit inside 448x448 on white square -> JPEG q90
import sharp from 'sharp';
import { config } from '../config.ts';

export const INFER_SIZE = 448;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff']);

export class ImageInputError extends Error {}

export interface Crop {
  x: number; // relative 0..1, in the auto-oriented image
  y: number;
  width: number;
  height: number;
}

export interface ValidatedImage {
  format: string;
  width: number;
  height: number;
}

/** Validates real content (never trusts extension/MIME) and pixel limits. */
export async function validateImage(bytes: Buffer): Promise<ValidatedImage> {
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(bytes, { limitInputPixels: config.IMAGE_MAX_PIXELS, failOn: 'error' }).metadata();
  } catch (err) {
    const msg = (err as Error).message;
    if (/pixel limit/i.test(msg)) throw new ImageInputError('Immagine troppo grande (troppi pixel)');
    if (/heif|heic/i.test(msg)) throw new ImageInputError('Formato HEIC non supportato: usare JPEG (su iPhone: Impostazioni › Fotocamera › Formati › Più compatibile)');
    throw new ImageInputError('File non riconosciuto come immagine valida');
  }
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
    if (meta.format === 'heif') throw new ImageInputError('Formato HEIC non supportato: usare JPEG (su iPhone: Impostazioni › Fotocamera › Formati › Più compatibile)');
    throw new ImageInputError(`Formato immagine non supportato (${meta.format ?? 'sconosciuto'})`);
  }
  if (!meta.width || !meta.height || meta.width * meta.height > config.IMAGE_MAX_PIXELS) throw new ImageInputError('Dimensioni immagine non valide');
  if (meta.width < 32 || meta.height < 32) throw new ImageInputError('Immagine troppo piccola per il confronto');
  return { format: meta.format, width: meta.width, height: meta.height };
}

function base(bytes: Buffer) {
  return sharp(bytes, { limitInputPixels: config.IMAGE_MAX_PIXELS, animated: false }).rotate();
}

async function oriented(bytes: Buffer, crop?: Crop | null): Promise<Buffer> {
  const img = base(bytes);
  if (!crop) return img.toBuffer();
  const buf = await img.toBuffer({ resolveWithObject: true });
  const W = buf.info.width;
  const H = buf.info.height;
  const left = clamp(Math.round(crop.x * W), 0, W - 1);
  const top = clamp(Math.round(crop.y * H), 0, H - 1);
  const width = clamp(Math.round(crop.width * W), 16, W - left);
  const height = clamp(Math.round(crop.height * H), 16, H - top);
  if (width < 16 || height < 16) throw new ImageInputError('Ritaglio troppo piccolo');
  return sharp(buf.data).extract({ left, top, width, height }).toBuffer();
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export async function makeInferImage(bytes: Buffer, crop?: Crop | null): Promise<Buffer> {
  const src = await oriented(bytes, crop);
  return sharp(src)
    .flatten({ background: '#ffffff' })
    .resize(INFER_SIZE, INFER_SIZE, { fit: 'contain', background: '#ffffff', kernel: 'lanczos3' })
    .removeAlpha()
    .jpeg({ quality: 90, mozjpeg: false })
    .toBuffer();
}

export async function makeDerivatives(bytes: Buffer): Promise<{ thumb: Buffer; display: Buffer; infer: Buffer; dhash: string; width: number; height: number }> {
  const src = await base(bytes).toBuffer({ resolveWithObject: true });
  const [thumb, display, infer, dhash] = await Promise.all([
    sharp(src.data).resize(400, 400, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).webp({ quality: 80 }).toBuffer(),
    sharp(src.data).resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).webp({ quality: 85 }).toBuffer(),
    makeInferImage(src.data),
    differenceHash(src.data),
  ]);
  return { thumb, display, infer, dhash, width: src.info.width, height: src.info.height };
}

/** Query photo kept for the result page (short retention), EXIF metadata stripped. */
export async function makeQueryDisplay(bytes: Buffer): Promise<Buffer> {
  return base(bytes).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
}

/** 64-bit dHash (hex). Near-duplicate hint only — never proof of identity. */
export async function differenceHash(bytes: Buffer): Promise<string> {
  const { data } = await sharp(bytes).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (data[y * 9 + x] > data[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}
