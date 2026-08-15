/**
 * Thread-side scorers, keyed by evaluator contract id.
 *
 * Plain ESM JavaScript on purpose. A worker_thread needs a real file it can
 * load at runtime, and a .ts file would only exist after a build — which would
 * make the pool work in production and silently not in dev or tests. Keeping
 * this JS means one code path everywhere.
 *
 * A scorer receives one genome plus the evaluator params and returns a finite
 * number. It must be pure and self-contained: it runs in a worker thread with
 * no access to the server's registry, database, or run state.
 */

/** @type {Map<string, (genome: unknown, params: Record<string, unknown>) => number>} */
const scorers = new Map();

/**
 * Sum of a numeric genome. Real, trivially verifiable, and useful on its own
 * for exercising the pool without loading a model.
 */
scorers.set("thread-sum", (genome) => {
  if (!Array.isArray(genome)) {
    throw new TypeError("thread-sum: expected an array genome");
  }
  let total = 0;
  for (const v of genome) total += Number(v);
  return total;
});

/**
 * Deliberately CPU-heavy, to demonstrate that scoring does not block the
 * engine's setImmediate loop. `iterations` comes from the evaluator params.
 */
scorers.set("thread-busy", (genome, params) => {
  const iterations = Number(params?.iterations ?? 1e6);
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc += Math.sqrt(i % 97);
  const base = Array.isArray(genome) ? genome.length : 0;
  // Fold acc in so the loop cannot be optimised away, without changing the
  // score's meaning.
  return base + (acc === Infinity ? 1 : 0);
});

/** Always throws, so the failure path can be exercised end to end. */
scorers.set("thread-explode", () => {
  throw new Error("scorer exploded on purpose");
});

export function getScorer(evaluatorId) {
  return scorers.get(evaluatorId);
}

export function scorerIds() {
  return [...scorers.keys()];
}
