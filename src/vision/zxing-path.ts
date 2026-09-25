// Absolute path of a zxing-wasm binary inside node_modules (the package does not export package.json).
import { createRequire } from 'node:module';
import path from 'node:path';

export function zxingWasmPath(kind: 'reader' | 'writer'): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve(`zxing-wasm/${kind}`);
  const marker = `${path.sep}dist${path.sep}`;
  const root = entry.slice(0, entry.lastIndexOf(marker));
  return path.join(root, 'dist', kind, `zxing_${kind}.wasm`);
}
