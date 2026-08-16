/** Types for the plain-ESM CLIP backend, which runs inside worker threads. */

export interface ClipImagePayload {
  width: number;
  height: number;
  rgb: readonly number[] | Uint8Array | Uint8ClampedArray;
}

export interface ClipBackend {
  embedImage(payload: ClipImagePayload): Promise<Float32Array>;
  embedText(text: string): Promise<Float32Array>;
}

export declare function setClipBackend(next: ClipBackend | null): void;
export declare function getClipBackend(): ClipBackend | null;
export declare function cosineSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number;
/**
 * @param augmentations Mean similarity over this many random crops/flips.
 *   1 (the default) is a single aligned view, i.e. no augmentation.
 */
export declare function scoreImageAgainstPrompt(
  payload: ClipImagePayload,
  prompt: string,
  augmentations?: number,
): Promise<number>;
export declare function textCacheSize(): number;
