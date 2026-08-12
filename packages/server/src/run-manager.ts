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
  private readonly FLUSH_EVERY = 10;

  constructor(store: RunStore, registry?: OperatorRegistry) {
    this.store = store;
    this.registry = registry ?? createDefaultRegistry();
  }

  get operatorRegistry(): OperatorRegistry {
    return this.registry;
  }

  // ---------- run lifecycle ----------

  createRun(config: RunConfig): string {
    const id = randomUUID();
    const engine = new GeneticAlgorithmEngine(config, this.registry);
    this.engines.set(id, engine);
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
        engine.step();
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
    this.engines.delete(id);
    return this.store.deleteRun(id);
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
    engine.on("generation", (stats) => {
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
    });

    engine.on("best", (generation, genome, fitness) => {
      this.broadcast(id, { type: "best", runId: id, generation, genome, fitness });
    });

    engine.on("status", (status) => {
      this.store.setStatus(id, status);
      this.broadcast(id, { type: "status", runId: id, status });
    });

    engine.on("finished", (reason, finalBest, generations) => {
      // Flush any buffered stats
      const buf = this.pendingStats.get(id);
      if (buf && buf.length > 0) {
        this.store.writeGenerations(id, buf);
        this.pendingStats.delete(id);
      }
      this.store.markFinished(id, finalBest);
      this.broadcast(id, {
        type: "finished",
        runId: id,
        reason,
        finalBestFitness: finalBest,
        generations,
      });
    });

    engine.on("error", (err) => {
      this.store.setStatus(id, "error");
      this.broadcast(id, { type: "status", runId: id, status: "error" });
      console.error(`[run ${id}] engine error:`, err);
    });
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
