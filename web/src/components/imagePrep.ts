// Client-side preparation of a photo before upload: applies EXIF orientation, downsizes large phone
// photos (faster upload on mobile) and converts formats the browser can decode (e.g. HEIC on iOS Safari)
// to JPEG. Falls back to the original file when the browser cannot decode it (the server then explains).
const MAX_SIDE = 2048;

export async function prepareImage(file: Blob): Promise<Blob> {
  if (!('createImageBitmap' in window)) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && (file.type === 'image/jpeg' || file.type === 'image/png' || file.type === 'image/webp') && file.size < 4 * 1024 * 1024) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  return blob ?? file;
}

/**
 * UPC-E (8 digits, zero-suppressed) to UPC-A, as on the server (src/lib/gtin.ts). A live scan decoded as
 * UPC-E must be searched as its UPC-A: the same 8 digits would otherwise be read as an EAN-8.
 */
export function expandUpcE(upce: string): string | null {
  if (!/^[01]\d{7}$/.test(upce)) return null;
  const d = upce.split('');
  const [d1, d2, d3, d4, d5, d6] = d.slice(1, 7);
  let body: string;
  if (d6 === '0' || d6 === '1' || d6 === '2') body = `${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  else if (d6 === '3') body = `${d1}${d2}${d3}00000${d4}${d5}`;
  else if (d6 === '4') body = `${d1}${d2}${d3}${d4}00000${d5}`;
  else body = `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  const upca = `${d[0]}${body}${d[7]}`;
  return isGtinCheckDigitValid(upca) ? upca : null;
}

export function isGtinCheckDigitValid(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  let sum = 0;
  for (let i = code.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(code[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(code[code.length - 1]);
}
