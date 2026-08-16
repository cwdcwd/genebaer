/**
 * Translucent-triangle image representation.
 *
 * The measured problem with a raw pixel bit string (genebaer-kz9) is not that
 * it cannot be optimised — it optimises very well — but that the optimum is an
 * adversarial pattern CLIP rates far above a real photograph. Nothing confines
 * an unconstrained per-pixel search to the manifold of plausible images.
 *
 * A polygon genome constrains it structurally. A few dozen flat translucent
 * triangles simply cannot express high-frequency per-pixel noise; every
 * mutation moves or recolours a whole shape. This is the classic
 * "evolving Mona Lisa" representation, and here it is a defence rather than an
 * aesthetic choice.
 *
 * Genome layout: `polygons * GENES_PER_POLYGON` numbers, all in [0, 1].
 * Per polygon: x1, y1, x2, y2, x3, y3, r, g, b, a.
 */

export const GENES_PER_POLYGON = 10;

export interface PolygonShape {
  width: number;
  height: number;
}

/** Genes a genome needs for this many polygons. */
export function polygonGenomeLength(polygons: number): number {
  return polygons * GENES_PER_POLYGON;
}

interface Triangle {
  xs: [number, number, number];
  ys: [number, number, number];
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Read a flat numeric genome as triangles in image coordinates. */
export function decodePolygons(
  genome: readonly number[],
  shape: PolygonShape,
): Triangle[] {
  const count = Math.floor(genome.length / GENES_PER_POLYGON);
  const out: Triangle[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * GENES_PER_POLYGON;
    const at = (k: number): number => clamp01(genome[o + k] ?? 0);
    out.push({
      xs: [at(0) * shape.width, at(2) * shape.width, at(4) * shape.width],
      ys: [at(1) * shape.height, at(3) * shape.height, at(5) * shape.height],
      r: at(6) * 255,
      g: at(7) * 255,
      b: at(8) * 255,
      // Floor alpha above zero: a fully transparent polygon is a dead gene
      // that selection cannot distinguish from a useful one it cannot see.
      // The top of the range stays 1 so a polygon can still be solid — capping
      // it lower would leave the white background showing through everywhere,
      // which is an expressiveness limit rather than a constraint worth having.
      a: 0.05 + at(9) * 0.95,
    });
  }
  return out;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Rasterise triangles onto an opaque white background, painter's algorithm.
 *
 * Software rasterisation on purpose: this runs in the engine's process and in
 * worker threads, neither of which has a canvas, and pulling a native graphics
 * dependency in to draw a few dozen triangles would be a poor trade.
 */
export function renderPolygons(
  genome: readonly number[],
  shape: PolygonShape,
): Uint8Array {
  const { width, height } = shape;
  const rgb = new Uint8Array(width * height * 3).fill(255);

  for (const tri of decodePolygons(genome, shape)) {
    const minX = Math.max(0, Math.floor(Math.min(...tri.xs)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(...tri.xs)));
    const minY = Math.max(0, Math.floor(Math.min(...tri.ys)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...tri.ys)));
    if (minX > maxX || minY > maxY) continue;

    const area = edge(tri.xs[0], tri.ys[0], tri.xs[1], tri.ys[1], tri.xs[2], tri.ys[2]);
    // A degenerate triangle covers nothing; skipping avoids a divide by zero.
    if (Math.abs(area) < 1e-9) continue;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        // Sample pixel centres, so a triangle covers what it visually covers.
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = edge(tri.xs[1], tri.ys[1], tri.xs[2], tri.ys[2], px, py) / area;
        const w1 = edge(tri.xs[2], tri.ys[2], tri.xs[0], tri.ys[0], px, py) / area;
        const w2 = edge(tri.xs[0], tri.ys[0], tri.xs[1], tri.ys[1], px, py) / area;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        const i = (y * width + x) * 3;
        rgb[i] = blend(rgb[i] as number, tri.r, tri.a);
        rgb[i + 1] = blend(rgb[i + 1] as number, tri.g, tri.a);
        rgb[i + 2] = blend(rgb[i + 2] as number, tri.b, tri.a);
      }
    }
  }
  return rgb;
}

/** Signed area of the triangle (a, b, c), doubled. */
function edge(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function blend(dst: number, src: number, alpha: number): number {
  return Math.round(dst * (1 - alpha) + src * alpha);
}
