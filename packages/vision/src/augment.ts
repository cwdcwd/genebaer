/**
 * Random-augmentation views of an image, for robust CLIP scoring.
 *
 * The measured failure in docs/experiments/clip-gradient.md is that an
 * unconstrained search finds an adversarial pattern CLIP rates far above a real
 * photograph. Such patterns are brittle: they depend on precise pixel
 * alignment, and a crop or a flip destroys them. Scoring the MEAN similarity
 * over N augmented views therefore prices in robustness — an image must look
 * like the prompt from several viewpoints, which is much closer to what
 * "recognisable" means than a single aligned score.
 *
 * This is the standard defence in CLIP-guided generation, and it costs N times
 * the inference. It is independent of the polygon representation
 * (docs/experiments/polygon-constraint.md): one constrains what can be drawn,
 * this one changes what is rewarded. Either can be used alone.
 */

/**
 * Any buffer of RGB bytes. All three forms show up in practice: plain arrays
 * over the wire, Uint8Array from the renderer, Uint8ClampedArray in the browser.
 */
export type RgbBytes = readonly number[] | Uint8Array | Uint8ClampedArray;

export interface RgbImage {
  width: number;
  height: number;
  /** Raw RGB bytes, 3 per pixel, row-major. */
  rgb: RgbBytes;
}

/** Smallest fraction of each axis a crop may keep. */
const MIN_CROP = 0.6;
/** Largest, kept below 1 so every extra view is a genuine change of viewpoint. */
const MAX_CROP = 0.95;

/**
 * A deterministic seed for an image's augmentations.
 *
 * Augmentation MUST NOT be freshly random per call. Fitness would stop being a
 * function of the genome: the same individual would score differently on a
 * re-evaluation, elitism would carry forward a score its genome cannot
 * reproduce, and the score cache would return a number measured under
 * augmentations the caller never saw. Seeding from the pixels keeps a genome's
 * score exactly reproducible while still giving *different* genomes different
 * augmentations — so the search cannot overfit one fixed transform.
 *
 * FNV-1a over the bytes: cheap, and its avalanche is more than enough here.
 */
export function imageSeed(rgb: RgbBytes): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < rgb.length; i++) {
    h ^= (rgb[i] as number) & 0xff;
    // 32-bit FNV prime multiply, kept in range via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Crop length along one axis: at least 1 pixel, at most one short of the source. */
function cropExtent(size: number, scale: number): number {
  if (size <= 1) return size;
  return Math.min(size - 1, Math.max(1, Math.round(size * scale)));
}

/** mulberry32, matching the engine's RNG so seeded behaviour is familiar. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * N augmented views of one image.
 *
 * The first view is always the image itself, unmodified. That keeps `count: 1`
 * exactly equivalent to no augmentation at all — the default must not silently
 * change what every existing run measures — and it keeps the aligned score in
 * the mean, so a genuinely good image is never penalised by bad luck in the
 * random draws.
 *
 * Each further view is a random crop, resized back to the original dimensions,
 * flipped horizontally half the time.
 */
export function augmentedViews(
  image: RgbImage,
  count: number,
  seed = imageSeed(image.rgb),
): RgbImage[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(
      `augmentedViews: count must be a positive integer, got ${String(count)}`,
    );
  }
  const expected = image.width * image.height * 3;
  if (image.rgb.length !== expected) {
    throw new RangeError(
      `augmentedViews: ${String(image.width)}x${String(image.height)} RGB needs ` +
        `${String(expected)} bytes, got ${String(image.rgb.length)}`,
    );
  }

  const views: RgbImage[] = [{ ...image }];
  const rng = mulberry32(seed);
  for (let i = 1; i < count; i++) {
    const scale = MIN_CROP + rng() * (MAX_CROP - MIN_CROP);
    // Clamped at both ends. At least one pixel, because a zero-width crop has
    // nothing to resize; and strictly smaller than the source, because rounding
    // on a small image otherwise yields the full frame — a view identical to
    // the original, which costs a whole inference and adds nothing to the mean.
    const cw = cropExtent(image.width, scale);
    const ch = cropExtent(image.height, scale);
    const x0 = Math.floor(rng() * (image.width - cw + 1));
    const y0 = Math.floor(rng() * (image.height - ch + 1));
    const flip = rng() < 0.5;
    views.push(cropResize(image, x0, y0, cw, ch, flip));
  }
  return views;
}

/**
 * Crop a region and scale it back to the full size, nearest-neighbour.
 *
 * Nearest-neighbour rather than bilinear on purpose: interpolation is a
 * low-pass filter, and smoothing away high-frequency detail would blunt
 * adversarial patterns for the wrong reason. The defence should come from
 * requiring the image to survive a change of viewpoint, not from quietly
 * blurring it.
 */
function cropResize(
  image: RgbImage,
  x0: number,
  y0: number,
  cw: number,
  ch: number,
  flip: boolean,
): RgbImage {
  const { width, height, rgb } = image;
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const sy = y0 + Math.min(ch - 1, Math.floor((y * ch) / height));
    for (let x = 0; x < width; x++) {
      const col = flip ? width - 1 - x : x;
      const sx = x0 + Math.min(cw - 1, Math.floor((col * cw) / width));
      const src = (sy * width + sx) * 3;
      const dst = (y * width + x) * 3;
      out[dst] = rgb[src] as number;
      out[dst + 1] = rgb[src + 1] as number;
      out[dst + 2] = rgb[src + 2] as number;
    }
  }
  return { width, height, rgb: out };
}
