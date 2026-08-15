/**
 * Worker thread entry point.
 *
 * Receives a batch of jobs, scores each with the scorer registered for its
 * contract, and posts results back. It knows nothing about leases, the queue,
 * or runs — the pool on the main thread owns all of that. A thread's only job
 * is turning genomes into numbers.
 *
 * Errors are reported per job rather than crashing the thread, so one bad
 * genome does not take down a worker that is happily scoring everything else.
 */
import { parentPort } from "node:worker_threads";
import { getScorer } from "./scorers.mjs";

if (!parentPort) {
  throw new Error("score-thread must be run as a worker_thread");
}

parentPort.on("message", (message) => {
  const { batchId, jobs } = message;
  const results = jobs.map((job) => {
    try {
      const scorer = getScorer(job.evaluatorId);
      if (!scorer) {
        return {
          index: job.index,
          error: `No scorer registered for contract '${job.evaluatorId}'`,
        };
      }
      const score = scorer(job.genome, job.params ?? {});
      if (!Number.isFinite(score)) {
        return {
          index: job.index,
          error: `Scorer '${job.evaluatorId}' returned a non-finite score`,
        };
      }
      return { index: job.index, score };
    } catch (err) {
      return { index: job.index, error: err instanceof Error ? err.message : String(err) };
    }
  });
  parentPort.postMessage({ batchId, results });
});
