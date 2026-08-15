import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, encodePng, isPng } from "./png.js";
import { ImagePrompt } from "./image-prompt.js";

/** Pull the chunks back out, so assertions are about a real PNG. */
function readChunks(png: Buffer): { type: string; data: Buffer; crcOk: boolean }[] {
  const chunks: { type: string; data: Buffer; crcOk: boolean }[] = [];
  let offset = 8; // past the signature
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    const stored = png.readUInt32BE(offset + 8 + length);
    const computed = crc32(png.subarray(offset + 4, offset + 8 + length));
    chunks.push({ type, data, crcOk: stored === computed });
    offset += 12 + length;
  }
  return chunks;
}

describe("encodePng", () => {
  it("writes a real PNG signature", () => {
    const png = encodePng({ width: 1, height: 1, rgb: [1, 2, 3] });
    expect(isPng(png)).toBe(true);
  });

  it("emits IHDR, IDAT and IEND in order, each with a valid CRC", () => {
    const png = encodePng({ width: 2, height: 2, rgb: new Array<number>(12).fill(7) });
    const chunks = readChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    // A bad CRC makes a file that decoders reject, which is the kind of thing
    // that looks fine until something else tries to open it.
    expect(chunks.every((c) => c.crcOk)).toBe(true);
  });

  it("records the right dimensions and colour format in IHDR", () => {
    const png = encodePng({ width: 7, height: 3, rgb: new Array<number>(63).fill(0) });
    const ihdr = readChunks(png).find((c) => c.type === "IHDR")!.data;
    expect(ihdr.readUInt32BE(0)).toBe(7);
    expect(ihdr.readUInt32BE(4)).toBe(3);
    expect(ihdr.readUInt8(8)).toBe(8); // bit depth
    expect(ihdr.readUInt8(9)).toBe(2); // truecolour RGB
    expect(ihdr.readUInt8(12)).toBe(0); // non-interlaced
  });

  it("round-trips the exact pixels through the compressed data", () => {
    // The real proof: inflate IDAT, strip the per-scanline filter byte, and
    // check the pixels that come back are the ones that went in.
    const rgb = [
      255, 0, 0, 0, 255, 0,
      0, 0, 255, 255, 255, 255,
    ];
    const png = encodePng({ width: 2, height: 2, rgb });
    const idat = readChunks(png).find((c) => c.type === "IDAT")!.data;
    const raw = inflateSync(idat);

    const stride = 2 * 3;
    const recovered: number[] = [];
    for (let y = 0; y < 2; y++) {
      const rowStart = y * (stride + 1);
      expect(raw[rowStart]).toBe(0); // filter type None
      recovered.push(...raw.subarray(rowStart + 1, rowStart + 1 + stride));
    }
    expect(recovered).toEqual(rgb);
  });

  it("accepts a Uint8Array as readily as a number array", () => {
    const bytes = Uint8Array.from([9, 8, 7]);
    expect(isPng(encodePng({ width: 1, height: 1, rgb: bytes }))).toBe(true);
  });

  it("rejects a byte count that does not match the dimensions", () => {
    expect(() => encodePng({ width: 2, height: 2, rgb: [1, 2, 3] })).toThrow(
      /Expected 12 RGB bytes/,
    );
  });

  it("rejects nonsensical dimensions", () => {
    expect(() => encodePng({ width: 0, height: 1, rgb: [] })).toThrow(/positive integers/);
    expect(() => encodePng({ width: 1.5, height: 1, rgb: [] })).toThrow(
      /positive integers/,
    );
  });
});

describe("exporting an evolved genome", () => {
  it("encodes what the problem renders, at the problem's size", () => {
    const problem = new ImagePrompt({ width: 4, height: 4 });
    const genome = new Array<number>(problem.genomeLength).fill(1);
    const png = encodePng({
      width: problem.shape.width,
      height: problem.shape.height,
      rgb: problem.render(genome),
    });

    expect(isPng(png)).toBe(true);
    const ihdr = readChunks(png).find((c) => c.type === "IHDR")!.data;
    expect(ihdr.readUInt32BE(0)).toBe(4);
    expect(ihdr.readUInt32BE(4)).toBe(4);

    // All-ones bits render white, and that must survive to the file.
    const raw = inflateSync(readChunks(png).find((c) => c.type === "IDAT")!.data);
    expect(raw[1]).toBe(255);
  });

  it("matches the bytes the canvas preview is given", () => {
    // The exported file and the on-screen preview must be the same image, or
    // people will trust a picture that is not what they downloaded.
    const problem = new ImagePrompt({ width: 3, height: 2, prompt: "x" });
    const genome = Array.from({ length: problem.genomeLength }, (_, i) => i % 2);
    const frame = problem.visualize(genome)!.data as { rgb: number[] };
    const png = encodePng({ width: 3, height: 2, rgb: problem.render(genome) });

    const raw = inflateSync(readChunks(png).find((c) => c.type === "IDAT")!.data);
    const stride = 3 * 3;
    const fromPng: number[] = [];
    for (let y = 0; y < 2; y++) {
      const rowStart = y * (stride + 1);
      fromPng.push(...raw.subarray(rowStart + 1, rowStart + 1 + stride));
    }
    expect(fromPng).toEqual(frame.rgb);
  });
});
