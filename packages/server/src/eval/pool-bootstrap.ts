import type { OperatorRegistry } from "@genebaer/core";
import type { WorkerCapability } from "@genebaer/shared-types";
import { QueuedEvaluator } from "./queued-evaluator.js";

/**
 * Starting the in-process worker pool, and being honest about what it can do.
 *
 * The pool has always existed and been tested, but nothing ever constructed
 * one, so a default server had no way to score a model-backed run — a browser
 * tab was the only worker available anywhere. That is genebaer-7hs.
 *
 * It stays OFF by default. Scoring threads that cannot load a model would
 * trade one confusing dead end for another, and the models are an optional
 * dependency by design.
 */

/** Contracts the in-process pool should advertise, read from the registry. */
export function poolCapabilities(registry: OperatorRegistry): WorkerCapability[] {
  const out: WorkerCapability[] = [];
  for (const meta of registry.listMetadata("evaluator")) {
    // Instantiating with no params is safe here: contract and version are
    // identity, fixed by the class, and never derived from run configuration.
    const instance = registry.create("evaluator", meta.id, {});
    if (instance instanceof QueuedEvaluator) {
      out.push({ evaluatorId: instance.contract, version: instance.version });
    }
  }
  return out;
}

/** How many threads to run, from an env var. Absent or 0 means the pool is off. */
export function threadsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env["GENEBAER_WORKER_THREADS"];
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(
      `GENEBAER_WORKER_THREADS must be a non-negative integer, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/**
 * Whether the optional model runtime is installed.
 *
 * Checked once when the pool starts rather than discovered per job. Without it
 * every model-backed job fails individually with the same message, which reads
 * as a broken run rather than a missing install.
 */
export async function modelRuntimeAvailable(): Promise<boolean> {
  // Specifier held in a variable so TypeScript does not try to resolve it: the
  // package is deliberately absent from the workspace, and a literal import()
  // would fail the typecheck gate on every machine that has not installed it.
  const specifier = "@huggingface/transformers";
  try {
    await import(specifier);
    return true;
  } catch {
    return false;
  }
}

/** What to tell the operator at startup, given what is actually installed. */
export function startupReport(
  threads: number,
  capabilities: readonly WorkerCapability[],
  runtimeAvailable: boolean,
): string {
  if (capabilities.length === 0) {
    return `[genebaer] worker pool: ${String(threads)} thread(s) requested, but no queued evaluators are registered, so there is nothing for them to claim.`;
  }
  const contracts = capabilities.map((c) => `${c.evaluatorId}@${c.version}`).join(", ");
  if (!runtimeAvailable) {
    return (
      `[genebaer] worker pool: ${String(threads)} thread(s) serving ${contracts}, but ` +
      `@huggingface/transformers is NOT installed, so model-backed jobs will fail. ` +
      `Install it in packages/server, or leave GENEBAER_WORKER_THREADS unset and use a browser worker.`
    );
  }
  return `[genebaer] worker pool: ${String(threads)} thread(s) serving ${contracts}.`;
}
