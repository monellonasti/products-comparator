// Text normalisation helpers used for matching (never for display).

export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const LEGAL_SUFFIXES = new Set(['srl', 'srls', 'spa', 'sas', 'snc', 'inc', 'ltd', 'llc', 'gmbh', 'ag', 'sa', 'sl', 'bv', 'co', 'corp', 'limited', 'company', 'group', 'kg', 'ohg', 'sarl', 'ab', 'oy', 'as']);

/** "LELO Inc." -> "lelo", "We-Vibe" -> "wevibe". Returns null for empty input. */
export function normalizeBrand(s: string | null | undefined): string | null {
  if (!s) return null;
  const tokens = foldText(s).split(' ').filter((t) => t && !LEGAL_SUFFIXES.has(t));
  const joined = tokens.join('');
  return joined || null;
}

/** "100 ML" -> "100ml", "Rosa Fucsia" -> "rosafucsia". */
export function normalizeAttribute(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const v = foldText(String(s)).replace(/\s+/g, '');
  return v || null;
}

/** Trigram similarity (same definition as pg_trgm, on folded text), for suggestions in memory. */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const set = new Set<string>();
    for (const word of foldText(s).split(' ')) {
      if (!word) continue;
      const padded = `  ${word} `;
      for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
    }
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let common = 0;
  for (const g of ga) if (gb.has(g)) common++;
  return common / (ga.size + gb.size - common);
}
