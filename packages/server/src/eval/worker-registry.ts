import { randomUUID } from "node:crypto";
import type { WorkerCapability } from "@genebaer/shared-types";

export interface RegisteredWorker {
  readonly workerId: string;
  readonly capabilities: readonly WorkerCapability[];
  /** Last time this worker was heard from. Liveness, not lease expiry. */
  lastSeen: number;
  /** Free-form label for observability, e.g. "worker-thread" or "browser". */
  readonly kind: string;
}

/** `evaluatorId@version` — the exact string a job must match to be offered. */
export function capabilityKey(evaluatorId: string, version: string): string {
  return `${evaluatorId}@${version}`;
}

/**
 * Who is connected and what each of them can score.
 *
 * This is the piece that makes a RunConfig portable. A config names a scoring
 * *contract* — "clip-similarity@1" — and the registry decides which connected
 * workers satisfy it. Nothing in a run ever names a machine, which is why a
 * worker thread and a browser tab are interchangeable rather than being two
 * different architectures.
 *
 * Version is part of the match, not decoration: two model versions produce
 * scores that are not comparable, and serving one run from both would distort
 * its fitness landscape mid-flight with no error anywhere.
 */
export class WorkerRegistry {
  private readonly workers = new Map<string, RegisteredWorker>();

  register(
    capabilities: readonly WorkerCapability[],
    kind = "unknown",
    now: number = Date.now(),
  ): RegisteredWorker {
    const worker: RegisteredWorker = {
      workerId: randomUUID(),
      capabilities: [...capabilities],
      lastSeen: now,
      kind,
    };
    this.workers.set(worker.workerId, worker);
    return worker;
  }

  deregister(workerId: string): boolean {
    return this.workers.delete(workerId);
  }

  get(workerId: string): RegisteredWorker | undefined {
    return this.workers.get(workerId);
  }

  /** Mark a worker alive. Returns false if it is not registered. */
  touch(workerId: string, now: number = Date.now()): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    worker.lastSeen = now;
    return true;
  }

  /** Capability strings a worker advertised, for matching against jobs. */
  capabilityKeys(workerId: string): string[] {
    const worker = this.workers.get(workerId);
    if (!worker) return [];
    return worker.capabilities.map((c) => capabilityKey(c.evaluatorId, c.version));
  }

  /** Every capability any connected worker can currently serve. */
  servedCapabilities(): Set<string> {
    const served = new Set<string>();
    for (const worker of this.workers.values()) {
      for (const c of worker.capabilities) {
        served.add(capabilityKey(c.evaluatorId, c.version));
      }
    }
    return served;
  }

  /**
   * Is anyone able to score this contract right now?
   *
   * A run whose evaluator nobody advertises would otherwise queue silently
   * forever, looking like it is running while making no progress.
   */
  canServe(evaluatorId: string, version: string): boolean {
    return this.servedCapabilities().has(capabilityKey(evaluatorId, version));
  }

  /** Drop workers that have not been heard from, returning their ids. */
  reapStale(maxSilenceMs: number, now: number = Date.now()): string[] {
    const dead: string[] = [];
    for (const [id, worker] of this.workers) {
      if (now - worker.lastSeen > maxSilenceMs) dead.push(id);
    }
    for (const id of dead) this.workers.delete(id);
    return dead;
  }

  list(): RegisteredWorker[] {
    return [...this.workers.values()];
  }

  get size(): number {
    return this.workers.size;
  }
}
