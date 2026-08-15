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
import { JobQueue } from "./eval/job-queue.js";
import { setActiveQueue } from "./eval/queued-evaluator.js";
import { WorkerRegistry } from "./eval/worker-registry.js";
import { registerWorkerRoutes } from "./eval/worker-routes.js";
import { WorkerConnection, parseWorkerMessage } from "./eval/worker-socket.js";
import { SqliteScoreCache, setActiveScoreCache } from "./eval/score-cache.js";
import { CaptionQueue } from "./eval/caption-queue.js";
import { ImagePrompt, encodePng } from "@genebaer/vision";
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
  /** How long a worker claim is valid before re-dispatch. */
  leaseMs?: number;
  /** How often to sweep leases and re-check worker capacity. */
  superviseMs?: number;
  /** How long a worker may go unheard-from before it is reaped. */
  maxWorkerSilenceMs?: number;
  registry?: OperatorRegistry;
  logger?: boolean;
}

export interface GenebaerServer {
  app: FastifyInstance;
  runManager: RunManager;
  store: RunStore;
  jobQueue: JobQueue;
  workerRegistry: WorkerRegistry;
  scoreCache: SqliteScoreCache;
  captionQueue: CaptionQueue;
  listen: FastifyInstance["listen"];
  close: FastifyInstance["close"];
}

/** Create the genebaer server. `listen`/`close` are delegated to the inner Fastify instance. */
export function createServer(opts: ServerOptions = {}): GenebaerServer {
  const store = new RunStore(opts.dbPath ?? "./data/genebaer.db");
  const runManager = new RunManager(store, opts.registry);
  // Queued evaluators resolve their queue from module scope, because the
  // registry constructs operators with params only and cannot inject services.
  const jobQueue = new JobQueue();
  const workerRegistry = new WorkerRegistry();
  // Shares the store connection: RunStore opens SQLite with
  // locking_mode = EXCLUSIVE, so a second connection would fight it.
  const scoreCache = new SqliteScoreCache(store.database);
  const captionQueue = new CaptionQueue();
  const detachCaptions = runManager.attachCaptionQueue(captionQueue);
  setActiveQueue(jobQueue);
  setActiveScoreCache(scoreCache);

  const app = Fastify({ logger: opts.logger ?? false });

  app.register(cors, { origin: true });
  // 8 MB, raised deliberately from 1 MB.
  //
  // A browser worker leasing a population of 40 at 64x64 RGB carries 40 x
  // 12,288 bytes of pixels. That is ~491 KB raw, but JSON encodes each byte as
  // decimal text ("200,"), which measures at ~1.97 MB - nearly double the old
  // limit. The raw-bytes estimate was the trap; the test in
  // worker-socket.test.ts asserts the real encoded size against this ceiling.
  //
  // 8 MB leaves headroom for a larger batch or resolution without silently
  // dropping frames, which is how this would fail: the socket closes and the
  // generation stalls with no obvious cause.
  app.register(websocket, { options: { maxPayload: 8 << 20 } });

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

  /**
   * Export the best genome of a run as a PNG.
   *
   * The one place a real PNG belongs: everywhere else in the pipeline ships raw
   * pixels, because encoding inside the evaluation loop would be overhead paid
   * on every genome of every generation.
   */
  app.get("/api/runs/:id/image.png", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = store.getRun(id);
    if (!detail) return reply.code(404).send({ error: "Not found" });

    if (detail.config.problem.id !== ImagePrompt.operatorId) {
      return reply
        .code(409)
        .send({ error: `Run ${id} is not an image run; nothing to export.` });
    }
    const latest = detail.stats.at(-1);
    if (!latest) {
      // Asking for a picture of a run that has not produced one yet is a
      // reasonable mistake; an empty or corrupt file would be worse.
      return reply
        .code(409)
        .send({ error: `Run ${id} has no completed generation to export yet.` });
    }

    try {
      const problem = new ImagePrompt(detail.config.problem.params ?? {});
      const genome = latest.bestGenome as number[];
      const png = encodePng({
        width: problem.shape.width,
        height: problem.shape.height,
        rgb: problem.render(genome),
      });
      return reply
        .header("content-type", "image/png")
        .header(
          "content-disposition",
          `attachment; filename="genebaer-${id}-gen${String(latest.generation)}.png"`,
        )
        .send(png);
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message });
    }
  });

  app.delete("/api/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!runManager.deleteRun(id)) {
      return reply.code(404).send({ error: "Not found" });
    }
    return { ok: true };
  });

  // A run whose contract nobody serves must not sit "running" forever, so the
  // supervisor runs on a timer rather than only on worker events.
  const supervisor = setInterval(() => {
    jobQueue.expireLeases();
    for (const dead of workerRegistry.reapStale(opts.maxWorkerSilenceMs ?? 60_000)) {
      jobQueue.releaseWorker(dead);
    }
    runManager.superviseWorkerCapacity(workerRegistry);
  }, opts.superviseMs ?? 250);
  // Never hold the process open just for supervision.
  supervisor.unref();

  registerWorkerRoutes(app, {
    queue: jobQueue,
    registry: workerRegistry,
    cache: scoreCache,
    captions: captionQueue,
    ...(opts.leaseMs === undefined ? {} : { leaseMs: opts.leaseMs }),
  });

  // Registering a worker may unblock a paused run, so react immediately
  // rather than waiting up to a full supervision tick.
  app.addHook("onResponse", async (req) => {
    if (req.url === "/api/workers/register") {
      runManager.superviseWorkerCapacity(workerRegistry);
    }
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

  // Workers over WebSocket: same protocol as the HTTP transport, different
  // bytes. A browser tab is an adapter here, not an architecture.
  app.register(async function workerWs(fastify) {
    fastify.get("/ws/worker", { websocket: true }, (socket: WebSocket) => {
      const connection = new WorkerConnection(
        (msg) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
        },
        {
          queue: jobQueue,
          registry: workerRegistry,
          leaseMs: opts.leaseMs ?? 30_000,
          kind: "browser",
        },
      );

      socket.on("message", (raw: Buffer) => {
        const msg = parseWorkerMessage(raw.toString());
        if (msg) connection.handle(msg);
      });

      socket.on("close", () => {
        // Closing a tab returns its jobs immediately rather than waiting out
        // the lease.
        connection.close();
        runManager.superviseWorkerCapacity(workerRegistry);
      });
    });
  });

  app.addHook("onClose", async () => {
    // Order matters: halt the engines before closing the database they write to.
    clearInterval(supervisor);
    detachCaptions();
    captionQueue.clear();
    runManager.shutdown();
    jobQueue.cancelAll("Server is shutting down");
    setActiveQueue(null);
    setActiveScoreCache(null);
    store.close();
  });

  return {
    app,
    runManager,
    store,
    jobQueue,
    workerRegistry,
    scoreCache,
    captionQueue,
    listen: app.listen.bind(app),
    close: app.close.bind(app),
  };
}
