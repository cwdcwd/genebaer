"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EvalJobPayload } from "@genebaer/shared-types";
import { WS_URL } from "@/lib/config";
import {
  WorkerClient,
  parseServerMessage,
  type WorkerClientView,
} from "@/lib/worker-client";
import { createClipScorer } from "@/lib/clip-browser";

/** Worker socket lives beside the run socket: /ws -> /ws/worker. */
const WORKER_WS_URL = WS_URL + "/worker";

const IDLE_POLL_MS = 1000;

/**
 * Turn this tab into an evaluation worker.
 *
 * The capability that motivated the whole externalized-evaluation epic: a
 * browser contributing inference to a run. By this point it is a transport
 * adapter — the same register/claim/score/heartbeat protocol a worker thread
 * speaks, over a socket instead of in-process.
 *
 * Explicitly opt-in. Silently conscripting someone's GPU because they opened a
 * page would be rude, and worse, invisible.
 */
export function WorkerPanel() {
  const [view, setView] = useState<WorkerClientView>({
    state: "idle",
    workerId: null,
    completed: 0,
    abandoned: 0,
    error: null,
  });
  const [enabled, setEnabled] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const clientRef = useRef<WorkerClient | null>(null);

  /**
   * Score one job with real in-browser CLIP.
   *
   * Created once per enable so the model loads once and the prompt embedding
   * cache survives across batches. There is deliberately no fallback score: a
   * made-up number would look like the system working while steering the run
   * at nothing.
   */
  const scorerRef = useRef(createClipScorer());
  const score = useCallback(
    (job: EvalJobPayload): Promise<number> => scorerRef.current(job),
    [],
  );

  useEffect(() => {
    if (!enabled) return;

    const socket = new WebSocket(WORKER_WS_URL);
    socketRef.current = socket;
    const client = new WorkerClient({
      capabilities: [{ evaluatorId: "clip-similarity", version: "clip-vit-base-patch32.1" }],
      batchSize: 4,
      score,
      send: (msg) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
      },
      onChange: setView,
    });
    clientRef.current = client;

    socket.onopen = () => client.start();
    socket.onmessage = (event) => {
      const msg = parseServerMessage(String(event.data));
      if (msg) client.handle(msg);
    };
    socket.onerror = () => client.fail("Worker socket error");
    socket.onclose = () => client.stop();

    // Re-claim while idle. The server answers "idle" rather than holding the
    // request open, so polling is the contract, not a workaround.
    const poll = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) client.claim();
    }, IDLE_POLL_MS);

    return () => {
      clearInterval(poll);
      client.stop();
      // Closing returns any held jobs to the queue immediately rather than
      // making the run wait out a lease.
      socket.close();
      socketRef.current = null;
      clientRef.current = null;
    };
  }, [enabled, score]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm text-foreground">Use this tab as a worker</div>
          <div className="text-[11px] text-muted">
            Contributes this browser to any run needing CLIP scoring.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEnabled((v) => !v)}
          className={
            enabled
              ? "rounded-md border border-danger/50 px-3 py-1 text-xs text-danger"
              : "rounded-md border border-accent/50 px-3 py-1 text-xs text-accent"
          }
        >
          {enabled ? "Stop" : "Start"}
        </button>
      </div>

      {enabled && (
        <dl className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <dt className="text-[10px] uppercase tracking-widest text-muted">state</dt>
            <dd className="mono text-foreground">{view.state}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-widest text-muted">scored</dt>
            <dd className="mono text-foreground">{view.completed}</dd>
          </div>
          <div>
            <dt
              className="text-[10px] uppercase tracking-widest text-muted"
              title="Jobs dropped because the lease was re-dispatched mid-flight"
            >
              abandoned
            </dt>
            <dd className="mono text-foreground">{view.abandoned}</dd>
          </div>
        </dl>
      )}

      {view.error && (
        <p className="mono rounded border border-danger/40 bg-danger/10 p-2 text-[11px] text-danger">
          {view.error}
        </p>
      )}
    </div>
  );
}
