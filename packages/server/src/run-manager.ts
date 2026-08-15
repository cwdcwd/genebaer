import { randomUUID } from "node:crypto";
import type {
  GenerationStats,
  RunConfig,
  RunStatus,
  WsServerMessage,
} from "@genebaer/shared-types";
import {
  createDefaultRegistry,
  GeneticAlgorithmEngine,
  type OperatorRegistry,
} from "@genebaer/core";
import type { RunStore } from "./db/run-store.js";
import { QueuedEvaluator } from "./eval/queued-evaluator.js";
import type { WorkerRegistry } from "./eval/worker-registry.js";

/**
 * Owns all live runs. Each run gets a GeneticAlgorithmEngine wired to:
 *   (a) broadcast WS events to subscribed clients
 *   (b) persist generation stats + lifecycle to SQLite
 *
 * Runs execute in-process; the engine yields to the event loop each
 * generation via setImmediate, so the server stays responsive.
 */
export class RunManager {
  private readonly engines = new Map<string, GeneticAlgorithmEngine<unknown>>();
  private readonly registry: OperatorRegistry;
  private readonly store: RunStore;

  /** Subscribers per runId. */
  private readonly subscribers = new Map<string, Set<(msg: WsServerMessage) => void>>();

  /** Buffer of stats not yet flushed (per runId). */
  private readonly pendingStats = new Map<string, GenerationStats[]>();
  /** Contract each run needs a worker for, when it uses a queued evaluator. */
  private readonly requirements = new Map<string, { contract: string; version: string }>();
  /** Runs this manager paused purely for lack of a capable worker. */
  private readonly pausedForWorker = new Set<string>();
  /** Event unsubscribers per run, so a discarded engine stops touching state. */
  private readonly enginePorts = new Map<string, (() => void)[]>();
  private readonly FLUSH_EVERY = 10;

  constructor(store: RunStore, registry?: OperatorRegistry) {
    this.store = store;
    this.registry = registry ?? createDefaultRegistry();

    // Engines exist only in memory, so on a fresh process nothing can still be
    // running. Any row left non-terminal belongs to a process that died; close
    // those out now, before the API can serve them as live.
    const interrupted = this.store.reconcileInterruptedRuns(
      "Interrupted — the server restarted while this run was in progress",
    );
    if (interrupted.length > 0) {
      console.warn(
        `[genebaer] reconciled ${interrupted.length} run(s) interrupted by a restart`,
      );
    }
  }

  get operatorRegistry(): OperatorRegistry {
    return this.registry;
  }

  // ---------- run lifecycle ----------

  createRun(config: RunConfig): string {
    const id = randomUUID();
    const engine = new GeneticAlgorithmEngine(config, this.registry);
    this.engines.set(id, engine);
    this.recordRequirement(id, config);
    this.store.createRun(id, config);
    this.wireEngine(id, engine);
    return id;
  }

  startRun(id: string): void {
    this.require(id).start();
  }

  control(id: string, action: "pause" | "resume" | "step" | "stop"): void {
    const engine = this.require(id);
    switch (action) {
      case "pause":
        engine.pause();
        break;
      case "resume":
        engine.resume();
        break;
      case "step":
        // Fire and forget: step() is async now because evaluation may leave
        // the process, but the control endpoint answers immediately with the
        // status. A failed step reports itself through the engine's 'error'
        // event, which is already wired to the store and to WS subscribers.
        void engine.step();
        break;
      case "stop":
        engine.stop();
        break;
    }
  }

  status(id: string): RunStatus | null {
    return this.engines.get(id)?.status ?? null;
  }

  visualFrame(id: string): { problemId: string; data: unknown } | null {
    return this.engines.get(id)?.visualFrame() ?? null;
  }

  deleteRun(id: string): boolean {
    const engine = this.engines.get(id);
    if (engine && engine.status === "running") engine.stop();
    for (const off of this.enginePorts.get(id) ?? []) off();
    this.enginePorts.delete(id);
    this.engines.delete(id);
    this.requirements.delete(id);
    this.pausedForWorker.delete(id);
    return this.store.deleteRun(id);
  }

  /**
   * Pause runs nothing can currently score, and resume them when it can.
   *
   * This is the operational failure mode of distributed evaluation. If no
   * connected worker advertises a run's contract, its jobs queue forever while
   * the run reports "running" — exactly the dishonesty genebaer-5ft removed
   * elsewhere in this system. A paused run with a reason is the truth.
   *
   * Idempotent, and safe to call on a timer.
   */
  superviseWorkerCapacity(registry: WorkerRegistry): void {
    for (const [id, need] of this.requirements) {
      const engine = this.engines.get(id);
      if (!engine) continue;
      const servable = registry.canServe(need.contract, need.version);

      if (!servable && engine.status === "running") {
        engine.pause();
        const reason =
          `Paused: no connected worker can serve '${need.contract}@${need.version}'. ` +
          `The run resumes automatically when one registers.`;
        this.pausedForWorker.add(id);
        this.store.setStatus(id, "paused", reason);
        this.broadcast(id, { type: "status", runId: id, status: "paused" });
        continue;
      }

      // Only resume runs THIS supervisor paused. A run a human paused must
      // stay paused, however much worker capacity turns up.
      if (servable && this.pausedForWorker.has(id) && engine.status === "paused") {
        this.pausedForWorker.delete(id);
        this.store.setStatus(id, "running", null);
        engine.resume();
      }
    }
  }

  /** Whether a run is currently paused solely for lack of a capable worker. */
  isPausedForWorker(runId: string): boolean {
    return this.pausedForWorker.has(runId);
  }

  /**
   * Halt every live engine and flush buffered stats. Call before closing the
   * store: engines tick on setImmediate and will happily keep writing to a
   * closed database otherwise, throwing from a timer with no request to
   * attribute it to.
   *
   * Engines are paused rather than stopped on purpose. Pausing halts the loop
   * without emitting 'finished', so the rows stay non-terminal and the next
   * process reconciles them as interrupted — which is what they are. Stopping
   * them here would persist "stopped by user", which nobody did.
   */
  shutdown(): void {
    for (const engine of this.engines.values()) {
      if (engine.status === "running") engine.pause();
    }
    for (const [id, buf] of this.pendingStats) {
      if (buf.length > 0) this.store.writeGenerations(id, buf);
    }
    this.pendingStats.clear();

    // Detach every engine listener before dropping the engines. An in-flight
    // evaluation rejected during shutdown settles on a LATER microtask, by
    // which point the store is closed — a still-wired engine would then try to
    // persist its error into a closed database.
    for (const offs of this.enginePorts.values()) {
      for (const off of offs) off();
    }
    this.enginePorts.clear();
    this.engines.clear();
  }

  // ---------- subscriptions ----------

  subscribe(runId: string, cb: (msg: WsServerMessage) => void): () => void {
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.subscribers.delete(runId);
    };
  }

  private broadcast(runId: string, msg: WsServerMessage): void {
    const set = this.subscribers.get(runId);
    if (!set) return;
    for (const cb of set) cb(msg);
  }

  // ---------- engine wiring ----------

  private wireEngine(id: string, engine: GeneticAlgorithmEngine<unknown>): void {
    const offs: (() => void)[] = [];
    this.enginePorts.set(id, offs);
    offs.push(engine.on("generation", (stats) => {
      this.store.updateGeneration(id, stats.generation);
      const buf = this.pendingStats.get(id) ?? [];
      buf.push(stats);
      if (buf.length >= this.FLUSH_EVERY) {
        this.store.writeGenerations(id, buf);
        buf.length = 0;
      } else {
        this.pendingStats.set(id, buf);
      }
      this.broadcast(id, { type: "generation", runId: id, stats });
    }));

    offs.push(engine.on("best", (generation, genome, fitness) => {
      this.broadcast(id, { type: "best", runId: id, generation, genome, fitness });
    }));

    offs.push(engine.on("status", (status) => {
      this.store.setStatus(id, status);
      this.broadcast(id, { type: "status", runId: id, status });
    }));

    offs.push(engine.on("finished", (reason, finalBest, generations) => {
      // Flush any buffered stats
      const buf = this.pendingStats.get(id);
      if (buf && buf.length > 0) {
        this.store.writeGenerations(id, buf);
        this.pendingStats.delete(id);
      }
      // The engine emits 'finished' for a user-initiated stop too, having
      // already set its own status to 'stopped'. Persisting 'finished'
      // unconditionally made a stopped run read as completed as soon as the
      // engine was gone and the live-status overlay stopped covering for it.
      const terminal = engine.status === "stopped" ? "stopped" : "finished";
      this.store.markTerminal(id, terminal, finalBest, reason);
      this.broadcast(id, {
        type: "finished",
        runId: id,
        reason,
        finalBestFitness: finalBest,
        generations,
      });
    }));

    offs.push(engine.on("error", (err) => {
      this.store.setStatus(id, "error");
      this.broadcast(id, { type: "status", runId: id, status: "error" });
      console.error(`[run ${id}] engine error:`, err);
    }));
  }

  /**
   * Note which contract this run will need workers for.
   *
   * Only queued evaluators need anyone: a local evaluator scores in-process,
   * so a run using one is never waiting on a worker and must never be paused
   * for the lack of one.
   */
  private recordRequirement(id: string, config: RunConfig): void {
    const ref = config.evaluator;
    if (!ref) return;
    const instance = this.registry.create("evaluator", ref.id, ref.params);
    if (instance instanceof QueuedEvaluator) {
      this.requirements.set(id, {
        contract: instance.contract,
        version: instance.version,
      });
    }
  }

  private require(id: string): GeneticAlgorithmEngine<unknown> {
    const engine = this.engines.get(id);
    if (!engine) throw new RunNotFoundError(id);
    return engine;
  }
}

export class RunNotFoundError extends Error {
  constructor(id: string) {
    super(`Run '${id}' not found`);
    this.name = "RunNotFoundError";
  }
}
