// Identity checks when an offer carries a GTIN that already belongs to a product.
// Titles are NOT compared (suppliers name products differently: case A). Only attributes that change
// the identity of the trade item are: brand, colour, size, variant, net content, pieces per item.
import { normalizeAttribute, normalizeBrand } from '../lib/text.ts';

export const IDENTITY_ATTRIBUTES = ['color', 'size', 'variant', 'net_content', 'pieces'] as const;
export type IdentityAttribute = (typeof IDENTITY_ATTRIBUTES)[number];

export const ATTRIBUTE_LABELS: Record<string, string> = {
  color: 'Colore',
  size: 'Misura/taglia',
  variant: 'Variante',
  net_content: 'Contenuto netto',
  pieces: 'Pezzi per articolo',
  material: 'Materiale',
};

export interface IdentityConflict {
  code: 'brand_mismatch' | 'attribute_mismatch';
  field: string;
  offerValue: string;
  productValue: string;
  message: string;
}

export interface IdentityData {
  brand: string | null;
  attributes: Record<string, string | null | undefined>;
}

export function brandsConflict(a: string | null, b: string | null): boolean {
  const na = normalizeBrand(a);
  const nb = normalizeBrand(b);
  if (!na || !nb || na === nb) return false;
  // "lelo" vs "lelosweden": treat containment as the same brand when the shorter part is meaningful.
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return !(short.length >= 3 && long.includes(short));
}

export function detectIdentityConflicts(offer: IdentityData, product: IdentityData): IdentityConflict[] {
  const conflicts: IdentityConflict[] = [];
  if (brandsConflict(offer.brand, product.brand)) {
    conflicts.push({
      code: 'brand_mismatch',
      field: 'brand',
      offerValue: offer.brand!,
      productValue: product.brand!,
      message: `Marca diversa: "${offer.brand}" contro "${product.brand}"`,
    });
  }
  for (const attr of IDENTITY_ATTRIBUTES) {
    const a = offer.attributes[attr];
    const b = product.attributes[attr];
    const na = normalizeAttribute(a);
    const nb = normalizeAttribute(b);
    if (na && nb && na !== nb) {
      conflicts.push({
        code: 'attribute_mismatch',
        field: attr,
        offerValue: String(a),
        productValue: String(b),
        message: `${ATTRIBUTE_LABELS[attr]} diverso: "${a}" contro "${b}"`,
      });
    }
  }
  return conflicts;
}
