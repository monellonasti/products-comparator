// Registry of supported image encoders. Revisions are pinned: the same key always means the same
// weights + preprocessing, so catalogue and query vectors are comparable. See docs/VISUAL_SEARCH.md.

export interface ModelSpec {
  id: string;
  label: string;
  repo: string;
  revision: string;
  dim: number;
  license: string;
  licenseUrl: string;
  modelClass: 'siglip' | 'clip';
  outputName: 'pooler_output' | 'image_embeds';
  preprocess: 'pp1';
  /**
   * Initial, UNCALIBRATED thresholds on cosine similarity (not a probability of identity).
   * possible: shown as "possibile corrispondenza"; similar: shown as "prodotto simile"; below: hidden.
   * Replace with values from `pnpm bench:visual` on real labelled photos.
   */
  thresholds: { possible: number; similar: number; calibrated: boolean };
}

export const MODELS: Record<string, ModelSpec> = {
  'siglip2-base-p16-224': {
    id: 'siglip2-base-p16-224',
    label: 'SigLIP 2 base patch16 224',
    repo: 'onnx-community/siglip2-base-patch16-224-ONNX',
    revision: 'ba1f3b0843f24bc5417d38e19c37b287d719b2f4',
    dim: 768,
    license: 'Apache-2.0 (google/siglip2-base-patch16-224)',
    licenseUrl: 'https://huggingface.co/google/siglip2-base-patch16-224',
    modelClass: 'siglip',
    outputName: 'pooler_output',
    preprocess: 'pp1',
    thresholds: { possible: 0.78, similar: 0.55, calibrated: false },
  },
  'clip-vit-b32': {
    id: 'clip-vit-b32',
    label: 'OpenAI CLIP ViT-B/32',
    repo: 'Xenova/clip-vit-base-patch32',
    revision: 'd15189d7028b43f1d3e65039190477f6af591c2a',
    dim: 512,
    license: 'MIT (openai/CLIP)',
    licenseUrl: 'https://github.com/openai/CLIP/blob/main/LICENSE',
    modelClass: 'clip',
    outputName: 'image_embeds',
    preprocess: 'pp1',
    thresholds: { possible: 0.85, similar: 0.7, calibrated: false },
  },
};

export function modelKey(spec: ModelSpec): string {
  return `${spec.id}@${spec.revision.slice(0, 7)}/${spec.preprocess}`;
}

export function specForKey(key: string): ModelSpec | undefined {
  return Object.values(MODELS).find((m) => modelKey(m) === key);
}

export function getModelSpec(id: string): ModelSpec {
  const spec = MODELS[id];
  if (!spec) throw new Error(`Unknown VISION_MODEL "${id}". Available: ${Object.keys(MODELS).join(', ')}`);
  return spec;
}
