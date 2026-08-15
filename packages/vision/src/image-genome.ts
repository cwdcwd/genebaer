/** Bytes per pixel: 8 bits each of R, G and B. */
export const CHANNELS = 3;
/** Bits per pixel. */
export const BITS_PER_PIXEL = CHANNELS * 8;

export interface ImageShape {
  width: number;
  height: number;
}

/** How many genes a bit-string genome needs for an image of this size. */
export function genomeLengthFor(shape: ImageShape): number {
  return shape.width * shape.height * BITS_PER_PIXEL;
}

/**
 * Turn a bit-string genome into raw RGB bytes.
 *
 * Raw bytes, not PNG, on purpose. A scorer needs pixels — CLIP builds an
 * ImageData or a tensor from them — so PNG-encoding in the evaluation loop
 * would be pure overhead paid on every genome of every generation. PNG belongs
 * at export, where a human actually wants a file.
 *
 * Bits are read most-significant-first within each byte, so the mapping is
 * stable and a genome renders identically everywhere.
 */
export function bitsToRgb(genome: readonly number[], shape: ImageShape): Uint8Array {
  const expected = genomeLengthFor(shape);
  if (genome.length !== expected) {
    throw new RangeError(
      `Genome has ${String(genome.length)} bits but a ${String(shape.width)}x` +
        `${String(shape.height)} RGB image needs exactly ${String(expected)} ` +
        `(width * height * ${String(BITS_PER_PIXEL)}). A mismatch would render a ` +
        `garbled image rather than fail, so it is rejected here.`,
    );
  }

  const bytes = new Uint8Array(shape.width * shape.height * CHANNELS);
  for (let byteIndex = 0; byteIndex < bytes.length; byteIndex++) {
    let value = 0;
    const base = byteIndex * 8;
    for (let bit = 0; bit < 8; bit++) {
      // Any truthy gene counts as 1: binary encodings store 0/1 numbers, but
      // a mutation operator is free to hand back anything array-shaped.
      value = (value << 1) | (genome[base + bit] ? 1 : 0);
    }
    bytes[byteIndex] = value;
  }
  return bytes;
}

/** Inverse of bitsToRgb, for round-trip testing and for seeding a population. */
export function rgbToBits(bytes: Uint8Array): number[] {
  const bits = new Array<number>(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i] as number;
    for (let bit = 0; bit < 8; bit++) {
      bits[i * 8 + bit] = (value >> (7 - bit)) & 1;
    }
  }
  return bits;
}
