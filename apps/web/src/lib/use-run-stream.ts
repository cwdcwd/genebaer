"use client";

import { useEffect, useRef, useState } from "react";
import type {
  GenerationStats,
  RunStatus,
  WsClientMessage,
  WsServerMessage,
} from "@genebaer/shared-types";
import { WS_URL } from "./config";

export interface StreamBest {
  generation: number;
  genome: unknown;
  fitness: number;
}

export interface StreamFinished {
  reason: string;
  finalBestFitness: number;
  generations: number;
}

export interface RunStream {
  stats: GenerationStats[];
  status: RunStatus | null;
  lastBest: StreamBest | null;
  finished: StreamFinished | null;
  connected: boolean;
}

const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Subscribe to the live event stream for one run. Opens a single WebSocket,
 * appends generation events as they arrive, and reconnects with exponential
 * backoff (up to {@link MAX_RECONNECT_ATTEMPTS} attempts).
 */
export function useRunStream(runId: string | null): RunStream {
  const [stats, setStats] = useState<GenerationStats[]>([]);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [lastBest, setLastBest] = useState<StreamBest | null>(null);
  const [finished, setFinished] = useState<StreamFinished | null>(null);
  const [connected, setConnected] = useState(false);

  // Keep finished in a ref so reconnect logic can see it without re-running effects.
  const finishedRef = useRef<StreamFinished | null>(null);
  finishedRef.current = finished;

  useEffect(() => {
    if (!runId) return;

    let ws: WebSocket | null = null;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        attempts = 0;
        setConnected(true);
        const msg: WsClientMessage = { type: "subscribe", runId };
        ws?.send(JSON.stringify(msg));
      };

      ws.onmessage = (event) => {
        let msg: WsServerMessage;
        try {
          msg = JSON.parse(String(event.data)) as WsServerMessage;
        } catch {
          return;
        }
        if (msg.runId !== runId) return;
        switch (msg.type) {
          case "generation":
            setStats((prev) => {
              // Guard against duplicate generations after a reconnect.
              const last = prev[prev.length - 1];
              if (last && msg.stats.generation <= last.generation) return prev;
              return [...prev, msg.stats];
            });
            break;
          case "best":
            setLastBest({
              generation: msg.generation,
              genome: msg.genome,
              fitness: msg.fitness,
            });
            break;
          case "status":
            setStatus(msg.status);
            break;
          case "finished":
            setFinished({
              reason: msg.reason,
              finalBestFitness: msg.finalBestFitness,
              generations: msg.generations,
            });
            setStatus("finished");
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (disposed) return;
        // Keep reconnecting only while the run is still live.
        if (finishedRef.current) return;
        if (attempts >= MAX_RECONNECT_ATTEMPTS) return;
        attempts += 1;
        const delay = Math.min(1000 * 2 ** (attempts - 1), 10_000);
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState === WebSocket.OPEN) {
        const msg: WsClientMessage = { type: "unsubscribe", runId };
        ws.send(JSON.stringify(msg));
      }
      ws?.close();
    };
  }, [runId]);

  return { stats, status, lastBest, finished, connected };
}
