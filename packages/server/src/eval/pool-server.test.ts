import type { RunConfig, CreateRunResponse, RunDetail } from "@genebaer/shared-types";
import { FitnessProblem } from "@genebaer/core";
import { afterEach, describe, expect, it } from "vitest";
import { createServerRegistry } from "../registry.js";
import { QueuedEvaluator } from "./queued-evaluator.js";
import { setActiveQueue } from "./queued-evaluator.js";
import { createServer, type GenebaerServer } from "../server.js";

let app: GenebaerServer | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  setActiveQueue(null);
});

/** A problem that cannot be scored in-process, like the image one. */
class NeedsWorker extends FitnessProblem<number[]> {
  static override readonly operatorId = "needs-worker";
  static override readonly displayName = "Needs a worker";
  static override readonly description = "Test problem.";
  static override readonly paramsSchema = {};
  static override readonly compatibleEncodings = ["binary"] as const;
  static override readonly scorableInProcess = false;
  override evaluate(): number {
    throw new Error("scored by a worker");
  }
}

/**
 * Dispatches to the `thread-sum` scorer, which is real arithmetic running in a
 * real worker thread — no model, no network. That keeps this an honest test of
 * the POOL rather than of transformers.js.
 */
class ThreadSum extends QueuedEvaluator {
  static override readonly operatorId = "thread-sum";
  static override readonly version = "1";
  static override readonly displayName = "Thread sum";
  static override readonly description = "Sums the genome in a worker thread.";
  static override readonly paramsSchema = {};
}

function config(): RunConfig {
  return {
    problem: { id: "needs-worker" },
    encoding: { id: "binary", params: { length: 12 } },
    selection: { id: "tournament" },
    crossover: { id: "one-point" },
    mutation: { id: "bit-flip" },
    mutationRate: 0.05,
    populationSize: 6,
    elitism: 1,
    termination: [{ id: "max-generations", params: { maxGenerations: 2 } }],
    seed: 4,
    evaluator: { id: "thread-sum" },
  };
}

async function boot(workerThreads: number): Promise<string> {
  const registry = createServerRegistry()
    .register("problem", NeedsWorker)
    .register("evaluator", ThreadSum);
  app = createServer({ dbPath: ":memory:", logger: false, registry, workerThreads });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

async function runToCompletion(baseUrl: string, ms: number): Promise<RunDetail> {
  const { runId } = (await (
    await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: config() }),
    })
  ).json()) as CreateRunResponse;

  const deadline = Date.now() + ms;
  let detail = {} as RunDetail;
  while (Date.now() < deadline) {
    detail = (await (await fetch(`${baseUrl}/api/runs/${runId}`)).json()) as RunDetail;
    if (detail.status === "finished" || detail.status === "error") break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return detail;
}

describe("in-process workers", () => {
  it("score a run with no browser involved", async () => {
    // genebaer-7hs: WorkerPool was real, tested code that nothing ever
    // constructed, so a browser tab was the only worker a server could have.
    const baseUrl = await boot(2);
    const detail = await runToCompletion(baseUrl, 15_000);

    expect(detail.status).toBe("finished");
    expect(detail.finalBestFitness).toBeGreaterThan(0);
  }, 20_000);

  it("leave the run unscored when the pool is off, rather than failing it", async () => {
    // The default must not change: with no workers the jobs simply wait, which
    // is what lets a browser tab join a run already in progress.
    const baseUrl = await boot(0);
    const detail = await runToCompletion(baseUrl, 1_500);

    expect(detail.status).not.toBe("finished");
    expect(detail.status).not.toBe("error");
  }, 10_000);
});
