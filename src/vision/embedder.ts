// Image embedding behind a replaceable interface. The V1 implementation runs an open-weight ONNX model
// locally (Transformers.js + onnxruntime-node, CPU): photos never leave the company infrastructure.
import sharp from 'sharp';
import { config } from '../config.ts';
import { getModelSpec, modelKey, type ModelSpec } from './models.ts';

export interface ImageEmbedder {
  readonly spec: ModelSpec;
  readonly key: string;
  status(): { state: 'idle' | 'loading' | 'ready' | 'failed'; error: string | null; loadMs: number | null };
  load(): Promise<void>;
  /** Input: the "infer" JPEG from makeInferImage(). Output: L2-normalised vector of spec.dim floats. */
  embed(inferJpeg: Buffer, opts?: { waitMs?: number }): Promise<Float32Array>;
}

export class EmbedderUnavailableError extends Error {}

const MAX_WAITERS = 64;

class OnnxImageEmbedder implements ImageEmbedder {
  readonly spec: ModelSpec;
  readonly key: string;
  private processor: any = null;
  private model: any = null;
  private loading: Promise<void> | null = null;
  private state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private error: string | null = null;
  private loadMs: number | null = null;

  constructor(spec: ModelSpec) {
    this.spec = spec;
    this.key = modelKey(spec);
  }

  status() {
    return { state: this.state, error: this.error, loadMs: this.loadMs };
  }

  load(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    this.loading ??= this.doLoad().catch((err) => {
      this.state = 'failed';
      this.error = err instanceof Error ? err.message : String(err);
      this.loading = null;
      throw new EmbedderUnavailableError(`Modello visivo non disponibile: ${this.error}`);
    });
    return this.loading;
  }

  private async doLoad() {
    this.state = 'loading';
    const t0 = performance.now();
    const tf = await import('@huggingface/transformers');
    tf.env.cacheDir = config.VISION_CACHE_DIR;
    tf.env.allowRemoteModels = config.VISION_ALLOW_REMOTE_MODELS;
    tf.env.allowLocalModels = false;
    const opts = { revision: this.spec.revision };
    this.processor = await tf.AutoProcessor.from_pretrained(this.spec.repo, opts);
    const Cls = this.spec.modelClass === 'siglip' ? tf.SiglipVisionModel : tf.CLIPVisionModelWithProjection;
    this.model = await (Cls as any).from_pretrained(this.spec.repo, {
      ...opts,
      dtype: 'fp32',
      device: 'cpu',
      session_options: { intraOpNumThreads: config.VISION_THREADS, interOpNumThreads: 1 },
    });
    this.RawImage = tf.RawImage;
    this.loadMs = Math.round(performance.now() - t0);
    this.state = 'ready';
    this.error = null;
  }

  private RawImage: any = null;

  /**
   * `waitMs` bounds the time spent waiting for a free slot (interactive searches): a request that gave up
   * leaves the queue instead of running an inference nobody will read.
   */
  async embed(inferJpeg: Buffer, opts: { waitMs?: number } = {}): Promise<Float32Array> {
    // Bounded parallelism: at most VISION_CONCURRENCY inferences at a time (ONNX Runtime sessions accept
    // concurrent runs); more would oversubscribe the CPU threads.
    await this.acquire(opts.waitMs);
    try {
      return await this.embedNow(inferJpeg);
    } finally {
      this.release();
    }
  }

  private running = 0;
  private waiters: Array<{ grant: () => void }> = [];
  private acquire(waitMs?: number): Promise<void> {
    if (this.running < config.VISION_CONCURRENCY) {
      this.running++;
      return Promise.resolve();
    }
    // Fail fast under overload rather than piling up requests that will all time out.
    if (this.waiters.length >= MAX_WAITERS) {
      return Promise.reject(new EmbedderUnavailableError('Troppe analisi di foto in coda: riprova tra qualche secondo'));
    }
    return new Promise((resolve, reject) => {
      const waiter = { grant: () => {
        clearTimeout(timer);
        resolve();
      } };
      const timer = waitMs === undefined ? undefined : setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new EmbedderUnavailableError('Tempo scaduto in attesa dell’analisi della foto'));
      }, waitMs);
      this.waiters.push(waiter);
    });
  }
  private release() {
    const next = this.waiters.shift();
    if (next) next.grant(); // the slot passes to the next waiter
    else this.running--;
  }

  private async embedNow(inferJpeg: Buffer): Promise<Float32Array> {
    await this.load();
    const { data, info } = await sharp(inferJpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const image = new this.RawImage(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height, 3);
    const inputs = await this.processor(image);
    const out = await this.model(inputs);
    const tensor = out[this.spec.outputName];
    if (!tensor) throw new Error(`Output ${this.spec.outputName} assente dal modello`);
    const vec = Float32Array.from(tensor.data as Float32Array);
    if (vec.length !== this.spec.dim) throw new Error(`Dimensione embedding ${vec.length} diversa da ${this.spec.dim}`);
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding non valido');
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }
}

const instances = new Map<string, ImageEmbedder>();

export function getEmbedder(modelId: string = config.VISION_MODEL): ImageEmbedder {
  let e = instances.get(modelId);
  if (!e) {
    e = new OnnxImageEmbedder(getModelSpec(modelId));
    instances.set(modelId, e);
  }
  return e;
}

export function setEmbedderForTests(modelId: string, e: ImageEmbedder) {
  instances.set(modelId, e);
}

export async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new EmbedderUnavailableError(message)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
