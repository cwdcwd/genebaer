import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { z } from "zod";
import type {
  CreateRunResponse,
  OperatorMeta,
  RunDetail,
  RunSummary,
  WsClientMessage,
  WsServerMessage,
} from "@genebaer/shared-types";
import type { OperatorRegistry } from "@genebaer/core";
import { RunManager, RunNotFoundError } from "./run-manager.js";
import { RunStore } from "./db/run-store.js";

const runConfigSchema = z.object({
  problem: z.object({ id: z.string(), params: z.record(z.unknown()).optional() }),
  encoding: z.object({ id: z.string(), params: z.record(z.unknown()).optional() }),
  selection: z.object({ id: z.string(), params: z.record(z.unknown()).optional() }),
  crossover: z.object({ id: z.string(), params: z.record(z.unknown()).optional() }),
  mutation: z.object({ id: z.string(), params: z.record(z.unknown()).optional() }),
  mutationRate: z.number().min(0).max(1),
  populationSize: z.number().int().min(2),
  elitism: z.number().int().min(0),
  termination: z.array(
    z.object({ id: z.string(), params: z.record(z.unknown()).optional() }),
  ),
  // Optional: absent means the in-process "local" evaluator. Required would
  // reject every config persisted or saved as a preset before evaluators
  // existed.
  evaluator: z
    .object({ id: z.string(), params: z.record(z.unknown()).optional() })
    .optional(),
  seed: z.number().int(),
});

const createRunSchema = z.object({ config: runConfigSchema });
const controlSchema = z.object({
  action: z.enum(["pause", "resume", "step", "stop"]),
});

export interface ServerOptions {
  dbPath?: string;
  registry?: OperatorRegistry;
  logger?: boolean;
}

export interface GenebaerServer {
  app: FastifyInstance;
  runManager: RunManager;
  store: RunStore;
  listen: FastifyInstance["listen"];
  close: FastifyInstance["close"];
}

/** Create the genebaer server. `listen`/`close` are delegated to the inner Fastify instance. */
export function createServer(opts: ServerOptions = {}): GenebaerServer {
  const store = new RunStore(opts.dbPath ?? "./data/genebaer.db");
  const runManager = new RunManager(store, opts.registry);

  const app = Fastify({ logger: opts.logger ?? false });

  app.register(cors, { origin: true });
  app.register(websocket, { options: { maxPayload: 1 << 20 } });

  // ---------- REST ----------

  app.get("/api/operators", async (): Promise<OperatorMeta[]> => {
    return runManager.operatorRegistry.listMetadata();
  });

  app.get("/api/problems", async (): Promise<OperatorMeta[]> => {
    return runManager.operatorRegistry.listMetadata("problem");
  });

  app.post("/api/runs", async (req, reply): Promise<CreateRunResponse> => {
    const parsed = createRunSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() }) as never;
    }
    try {
      const cfg = parsed.data.config;
      const runId = runManager.createRun(cfg as Parameters<RunManager["createRun"]>[0]);
      runManager.startRun(runId);
      return { runId };
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message }) as never;
    }
  });

  app.get("/api/runs", async (): Promise<RunSummary[]> => {
    return store.listRuns();
  });

  app.get("/api/runs/:id", async (req, reply): Promise<RunDetail> => {
    const { id } = req.params as { id: string };
    const detail = store.getRun(id);
    if (!detail) return reply.code(404).send({ error: "Not found" }) as never;
    // Overlay live status if the engine is in-memory.
    const liveStatus = runManager.status(id);
    if (liveStatus) detail.status = liveStatus;
    return detail;
  });

  app.post("/api/runs/:id/control", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = controlSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      runManager.control(id, parsed.data.action);
      return { ok: true, status: runManager.status(id) };
    } catch (err) {
      if (err instanceof RunNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.get("/api/runs/:id/visual", async (req, reply) => {
    const { id } = req.params as { id: string };
    const frame = runManager.visualFrame(id);
    if (!frame) return reply.code(404).send({ error: "No visual frame" });
    return frame;
  });

  app.delete("/api/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!runManager.deleteRun(id)) {
      return reply.code(404).send({ error: "Not found" });
    }
    return { ok: true };
  });

  // ---------- WebSocket ----------

  app.register(async function wsRoutes(fastify) {
    fastify.get("/ws", { websocket: true }, (socket: WebSocket) => {
      // Keyed by runId: unsubscribing from one run must leave this socket's
      // other subscriptions alone, so a client can watch several runs at once.
      const unsubs = new Map<string, () => void>();

      socket.on("message", (raw: Buffer) => {
        let msg: WsClientMessage;
        try {
          msg = JSON.parse(raw.toString()) as WsClientMessage;
        } catch {
          return;
        }
        if (msg.type === "subscribe") {
          // Re-subscribing to a run replaces its handler rather than stacking a
          // second one, which would deliver every message for it twice.
          unsubs.get(msg.runId)?.();
          const send = (m: WsServerMessage): void => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
          };
          unsubs.set(msg.runId, runManager.subscribe(msg.runId, send));
        } else if (msg.type === "unsubscribe") {
          unsubs.get(msg.runId)?.();
          unsubs.delete(msg.runId);
        }
      });

      socket.on("close", () => {
        for (const unsub of unsubs.values()) unsub();
        unsubs.clear();
      });
    });
  });

  app.addHook("onClose", async () => {
    // Order matters: halt the engines before closing the database they write to.
    runManager.shutdown();
    store.close();
  });

  return {
    app,
    runManager,
    store,
    listen: app.listen.bind(app),
    close: app.close.bind(app),
  };
}
