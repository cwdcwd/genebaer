/**
 * CLIP scoring backend for worker threads.
 *
 * Real inference needs @huggingface/transformers plus ~150MB of model weights,
 * which is a heavy and network-dependent thing to require. So the backend is
 * swappable: production loads transformers.js lazily on first use, and tests
 * inject a fake.
 *
 * What it deliberately does NOT do is fall back to some cheap made-up signal
 * when the model is unavailable. A stand-in metric would look like it was
 * working while steering an entire run toward something that has nothing to do
 * with the prompt, and no gate anywhere would notice. Failing loudly is the
 * only honest option.
 */

/** @type {null | { embedImage: Function, embedText: Function }} */
let backend = null;
/** @type {Map<string, Float32Array>} */
const textCache = new Map();

/** Swap the backend. Tests use this; production leaves it alone. */
export function setClipBackend(next) {
  backend = next;
  textCache.clear();
}

export function getClipBackend() {
  return backend;
}

/**
 * Lazily construct the real transformers.js backend.
 *
 * Loading is deferred to first use and the pipeline is kept alive afterwards:
 * model load is slow and must happen once per process, never per batch.
 */
async function loadDefaultBackend() {
  let transformers;
  try {
    transformers = await import("@huggingface/transformers");
  } catch (cause) {
    throw new Error(
      "CLIP scoring requires @huggingface/transformers, which is not installed. " +
        "Install it in the worker's environment, or inject a backend with " +
        "setClipBackend(). No substitute scoring is used, because a stand-in " +
        "metric would silently steer the run.",
      { cause },
    );
  }

  const modelId = "Xenova/clip-vit-base-patch32";
  const [imageModel, processor, textModel, tokenizer] = await Promise.all([
    transformers.CLIPVisionModelWithProjection.from_pretrained(modelId),
    transformers.AutoProcessor.from_pretrained(modelId),
    transformers.CLIPTextModelWithProjection.from_pretrained(modelId),
    transformers.AutoTokenizer.from_pretrained(modelId),
  ]);

  return {
    async embedImage({ width, height, rgb }) {
      const image = new transformers.RawImage(Uint8Array.from(rgb), width, height, 3);
      const inputs = await processor(image);
      const { image_embeds: embeds } = await imageModel(inputs);
      return Float32Array.from(embeds.data);
    },
    async embedText(text) {
      const inputs = tokenizer([text], { padding: true, truncation: true });
      const { text_embeds: embeds } = await textModel(inputs);
      return Float32Array.from(embeds.data);
    },
  };
}

async function ensureBackend() {
  backend ??= await loadDefaultBackend();
  return backend;
}

/** Cosine similarity of two equal-length vectors. */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(
      `Cannot compare embeddings of different sizes (${a.length} vs ${b.length}); ` +
        "this usually means the image and text models are not a matched pair.",
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  // Two zero vectors are not "perfectly similar"; they carry no information.
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Score one rendered image against a prompt.
 *
 * The text embedding is cached: it is identical for every individual of every
 * generation of a run, so embedding it per image would multiply the text-side
 * cost by the population size for nothing.
 *
 * With `augmentations > 1` the score is the MEAN similarity over that many
 * random crops/flips of the image. Adversarial patterns depend on exact pixel
 * alignment and collapse under a change of viewpoint, while a genuinely
 * recognisable image survives one - so the mean prices in robustness. The views
 * are seeded from the pixels, keeping the score an exact function of the image.
 * Costs N times the image-side inference; the text side is unaffected.
 */
export async function scoreImageAgainstPrompt(payload, prompt, augmentations = 1) {
  const impl = await ensureBackend();
  let textEmbedding = textCache.get(prompt);
  if (!textEmbedding) {
    textEmbedding = await impl.embedText(prompt);
    textCache.set(prompt, textEmbedding);
  }

  const { augmentedViews } = await import("@genebaer/vision");
  const views = augmentedViews(payload, augmentations);
  let total = 0;
  for (const view of views) {
    const imageEmbedding = await impl.embedImage(view);
    total += cosineSimilarity(imageEmbedding, textEmbedding);
  }
  return total / views.length;
}

/** How many prompts are currently embedded. Exposed for tests. */
export function textCacheSize() {
  return textCache.size;
}
