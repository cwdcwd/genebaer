import { deflateSync } from "node:zlib";

/**
 * Minimal PNG encoder for raw 8-bit RGB.
 *
 * Deliberately dependency-free. The obvious alternative is sharp, but that is a
 * native module and the server does not otherwise need one — pulling in a
 * platform-specific binary to write a handful of bytes would be a poor trade,
 * especially for a format this well specified. Node ships zlib, which is the
 * only genuinely hard part.
 *
 * Produces a non-interlaced, 8-bit, truecolour PNG: colour type 2, filter
 * method 0, with every scanline using filter type 0 (None). Filtering exists to
 * help compression on photographic data; these are evolved images and the
 * simplicity is worth more than the bytes.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 table, built once. Required by every PNG chunk. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

export interface PngInput {
  width: number;
  height: number;
  /** Raw RGB bytes, width * height * 3, row-major. */
  rgb: Uint8Array | readonly number[];
}

/** Encode raw RGB bytes as a PNG. */
export function encodePng({ width, height, rgb }: PngInput): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(
      `PNG dimensions must be positive integers, got ${String(width)}x${String(height)}`,
    );
  }
  const expected = width * height * 3;
  if (rgb.length !== expected) {
    throw new RangeError(
      `Expected ${String(expected)} RGB bytes for ${String(width)}x${String(height)}, ` +
        `got ${String(rgb.length)}`,
    );
  }
  const pixels = rgb instanceof Uint8Array ? rgb : Uint8Array.from(rgb);

  // Each scanline is prefixed with its filter type byte.
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: None
    Buffer.from(pixels.subarray(y * stride, (y + 1) * stride)).copy(
      raw,
      rowStart + 1,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type 2 = truecolour RGB
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter method 0
  ihdr.writeUInt8(0, 12); // non-interlaced

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** True when the buffer starts with the PNG signature. */
export function isPng(buffer: Buffer): boolean {
  return buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}
