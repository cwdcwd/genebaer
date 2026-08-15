import { randomUUID } from "node:crypto";

export interface CaptionRequest {
  readonly requestId: string;
  readonly runId: string;
  readonly generation: number;
  /** Rendered image payload — workers never see bit packing. */
  readonly payload: unknown;
  readonly requestedAt: number;
}

export interface CaptionResult {
  runId: string;
  generation: number;
  caption: string;
}

/**
 * Pending caption requests, separate from the fitness queue on purpose.
 *
 * A caption is TEXT, not a score, and it is emphatically not fitness. Keeping
 * it off the JobQueue makes that structural rather than a convention someone
 * could drift away from: nothing here can ever feed a number into selection.
 *
 * It is also deliberately best-effort. A caption is a human-readable progress
 * check — "is this run going anywhere?" — so a caption that never arrives must
 * cost the run nothing. Requests expire and are dropped rather than held.
 */
export class CaptionQueue {
  private readonly pending = new Map<string, CaptionRequest>();
  private readonly listeners = new Set<(result: CaptionResult) => void>();
  private completed = 0;
  private droppedCount = 0;

  request(runId: string, generation: number, payload: unknown): CaptionRequest {
    const req: CaptionRequest = {
      requestId: randomUUID(),
      runId,
      generation,
      payload,
      requestedAt: Date.now(),
    };
    this.pending.set(req.requestId, req);
    return req;
  }

  /** Take up to `max` requests for a worker to caption. */
  claim(max: number): CaptionRequest[] {
    const taken: CaptionRequest[] = [];
    for (const req of this.pending.values()) {
      if (taken.length >= max) break;
      taken.push(req);
    }
    // Removed on claim rather than leased: a lost caption is not worth
    // re-dispatch machinery, because nothing waits on it.
    for (const req of taken) this.pending.delete(req.requestId);
    return taken;
  }

  /** Record a caption and notify listeners. Unknown ids are ignored. */
  complete(requestId: string, runId: string, generation: number, caption: string): boolean {
    if (typeof caption !== "string" || caption.length === 0) return false;
    this.completed += 1;
    const result: CaptionResult = { runId, generation, caption };
    for (const listener of this.listeners) listener(result);
    void requestId;
    return true;
  }

  /** Drop requests older than `maxAgeMs`; nothing depends on them arriving. */
  expire(maxAgeMs: number, now: number = Date.now()): number {
    let dropped = 0;
    for (const [id, req] of [...this.pending]) {
      if (now - req.requestedAt > maxAgeMs) {
        this.pending.delete(id);
        dropped += 1;
      }
    }
    this.droppedCount += dropped;
    return dropped;
  }

  onResult(listener: (result: CaptionResult) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stats(): { pending: number; completed: number; dropped: number } {
    return {
      pending: this.pending.size,
      completed: this.completed,
      dropped: this.droppedCount,
    };
  }

  clear(): void {
    this.pending.clear();
    this.listeners.clear();
  }
}
