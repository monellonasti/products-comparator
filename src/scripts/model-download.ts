// Downloads (or verifies in cache) the pinned weights of VISION_MODEL into VISION_CACHE_DIR.
// Run once on a machine with Internet access; afterwards set VISION_ALLOW_REMOTE_MODELS=false.
process.env.VISION_ALLOW_REMOTE_MODELS = 'true';
const { getEmbedder } = await import('../vision/embedder.ts');
const { config } = await import('../config.ts');
const e = getEmbedder(config.VISION_MODEL);
await e.load();
console.log(`modello pronto: ${e.key} in ${config.VISION_CACHE_DIR} (${JSON.stringify(e.status())})`);
