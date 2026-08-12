import type { RandomSource } from "../random.js";
import { Encoding } from "../encoding.js";

export const ALL_ENCODINGS = [BinaryEncodingRef, NumericRef, StringRef] as const;

// Re-export friendly refs for registry default wiring.
import { BinaryEncoding as BinaryEncodingRef } from "../encodings/binary.js";
import { NumericVectorEncoding as NumericRef } from "../encodings/numeric.js";
import { StringEncoding as StringRef } from "../encodings/string.js";

export { BinaryEncodingRef as BinaryEncoding };
export { NumericRef as NumericVectorEncoding };
export { StringRef as StringEncoding };
export { Encoding };
