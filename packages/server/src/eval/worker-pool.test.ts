import { afterEach, describe, expect, it } from "vitest";
import { JobQueue } from "./job-queue.js";
import { WorkerRegistry } from "./worker-registry.js";
import { WorkerPool } from "./worker-pool.js";

const P: Record<string, unknown> = {};
let pool: WorkerPool | null = null;

afterEach(async () => {
  if (pool) {
    await pool.stop();
    pool = null;
  }
});

function makePool(queue: JobQueue, registry: WorkerRegistry, threads = 2): WorkerPool {
  pool = new WorkerPool({
    queue,
    registry,
    capabilities: [
      { evaluatorId: "thread-sum", version: "1" },
      { evaluatorId: "thread-busy", version: "1" },
      { evaluatorId: "thread-explode", version: "1" },
    ],
    threads,
    batchSize: 4,
    pollMs: 5,
  });
  return pool;
}

describe("WorkerPool", () => {
  it("registers itself like any other worker, with no special casing", () => {
    const queue = new JobQueue();
    const registry = new WorkerRegistry();
    makePool(queue, registry).start();

    expect(registry.size).toBe(1);
    const [worker] = registry.list();
    expect(worker!.kind).toBe("worker-thread");
    expect(registry.canServe("thread-sum", "1")).toBe(true);
  });

  it("claims, scores on a thread, and submits back through the queue", async () => {
    const queue = new JobQueue();
    const registry = new WorkerRegistry();
    makePool(queue, registry).start();

    const scores = await queue.submit("thread-sum", "1", P, [
      [1, 2, 3],
      [10, 20],
      [],
    ]);
    expect(scores).toEqual([6, 30, 0]);
  });

  it("handles a batch larger than the thread count", async () => {
    const queue = new JobQueue();
    const registry = new WorkerRegistry();
    makePool(queue, registry, 2).start();

    const genomes = Array.from({ length: 20 }, (_, i) => [i]);
    const scores = await queue.submit("thread-sum", "1", P, genomes);
    expect(scores).toEqual(genomes.map((g) => g[0]));
  });

  it("keeps the main thread responsive while scoring is CPU-bound", async () => {
    // The reason threads exist: the engine drives its loop on setImmediate, and
    // CPU-bound scoring on the main thread would starve it.
    const queue = new JobQueue();
    const registry = new WorkerRegistry();
    makePool(queue, registry, 2).start();

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 5);

    const heavy = Array.from({ length: 8 }, () => [1, 2, 3]);
    await queue.submit("thread-busy", "1", { iterations: 3e6 }, heavy);
    clearInterval(ticker);

    // If scoring ran inline, the event loop would have been blocked and the
    // timer starved.
    expect(ticks).toBeGreaterThan(0);
  });

  it("fails the evaluation when a scorer throws, rather than hanging", async () => {
    const queue = new JobQueue();
    const registry = new WorkerRegistry();
    makePool(queue, registry).start();

    await expect(queue.submit("thread-explode", "1", P, [[1]])).rejects.toThrow(
      /exploded on purpose/,
    );
  });

  it("fails the evaluation for a contract no scorer implements", async () => {
    const queue = new JobQueue();
    const registry = new WorkerRegistry();
    // Advertise a capability the thread-side scorer table does not implement.
    pool = new WorkerPool({
      queue,
      registry,
      capabilities: [{ evaluatorId: "not-implemented", version: "1" }],
      threads: 1,
      pollMs: 5,
    });
    pool.start();

    await expect(queue.submit("not-implemented", "1", P, [[1]])).rejects.toThrow(
      /No scorer registered/,
    );
  });

  it("returns its jobs to the queue when stopped mid-flight", async () => {
    const queue = new JobQueue();
    const registry = new WorkerRegistry();
    const p = makePool(queue, registry, 1);
    p.start();
    const workerId = p.id;
    expect(workerId).toBeTruthy();

    // Long-running work, then stop the pool before it can finish.
    const pending = queue.submit("thread-busy", "1", { iterations: 5e7 }, [
      [1],
      [2],
      [3],
      [4],
    ]);
    pending.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    await p.stop();
    pool = null;

    // Deregistered, and its jobs are claimable by someone else.
    expect(registry.size).toBe(0);
    expect(queue.stats().activeLeases).toBe(0);
  });

  it("is a no-op to stop a pool that never started", async () => {
    const queue = new JobQueue();
    const registry = new WorkerRegistry();
    const p = makePool(queue, registry);
    await expect(p.stop()).resolves.toBeUndefined();
    pool = null;
  });
});
