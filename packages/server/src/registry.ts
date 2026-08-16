import { createDefaultRegistry, type OperatorRegistry } from "@genebaer/core";
import { ImagePrompt } from "@genebaer/vision";
import { ClipSimilarityEvaluator } from "./eval/clip-evaluator.js";

/**
 * The registry a genebaer server actually serves.
 *
 * `createDefaultRegistry()` lives in `core`, which is deliberately
 * dependency-light and knows nothing about images, models, or job queues. So
 * the image problem and the model-backed evaluator have to be registered by
 * whoever owns those dependencies — which is this package.
 *
 * Until this existed, a default server registered neither. Every test that
 * exercised them built its own registry and passed it in, so the whole
 * distributed-evaluation epic worked in tests and was unreachable from a
 * running server: `/api/problems` listed no `image-prompt`, `/api/operators`
 * listed no `clip-similarity`, and the new-run form could therefore not offer
 * either. Found while fixing genebaer-kns.
 */
export function createServerRegistry(): OperatorRegistry {
  return createDefaultRegistry()
    .register("problem", ImagePrompt)
    .register("evaluator", ClipSimilarityEvaluator);
}
