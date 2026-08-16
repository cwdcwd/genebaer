import type { OperatorMeta, WorkerCapability } from "@genebaer/shared-types";

/**
 * Which evaluator contract this browser can actually satisfy.
 *
 * The scoring code here implements CLIP image/text similarity, so the id is a
 * genuine property of this build. The *version* is not: it is whatever the
 * server's registered evaluator declares, and it changes whenever the meaning
 * of a score changes.
 */
export const BROWSER_EVALUATOR_ID = "clip-similarity";

/**
 * Resolve the capability to register from server metadata.
 *
 * This exists because hardcoding the version was a real bug (genebaer-vnb) with
 * a silent failure mode. The worker registry matches on `id@version`, so a tab
 * compiled against an older version registers successfully, polls happily, and
 * is simply never offered a job — indistinguishable, to a user, from "no runs
 * need scoring right now". Nothing anywhere raises an error.
 *
 * Returns null when the server has no such evaluator registered, which the
 * caller must surface rather than paper over: registering with a guessed
 * version recreates exactly the silent failure this replaces.
 */
export function capabilityFromOperators(
  operators: readonly OperatorMeta[],
): WorkerCapability | null {
  const meta = operators.find(
    (o) => o.kind === "evaluator" && o.id === BROWSER_EVALUATOR_ID,
  );
  if (!meta?.version) return null;
  return { evaluatorId: meta.id, version: meta.version };
}

/** Message for the panel when the server offers nothing this tab can score. */
export function unsupportedMessage(operators: readonly OperatorMeta[]): string {
  const present = operators.some(
    (o) => o.kind === "evaluator" && o.id === BROWSER_EVALUATOR_ID,
  );
  return present
    ? `The server's '${BROWSER_EVALUATOR_ID}' evaluator did not report a version, so this tab cannot know what it would be scoring.`
    : `This server has no '${BROWSER_EVALUATOR_ID}' evaluator registered, so there is nothing this browser can score.`;
}
