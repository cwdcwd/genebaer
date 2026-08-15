import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EvalJobPayload } from "@genebaer/shared-types";
import type { JobQueue } from "./job-queue.js";
import type { WorkerRegistry } from "./worker-registry.js";

const capabilitySchema = z.object({
  evaluatorId: z.string().min(1),
  version: z.string().min(1),
});

const registerSchema = z.object({
  capabilities: z.array(capabilitySchema).min(1),
  kind: z.string().optional(),
});

const claimSchema = z.object({
  workerId: z.string().min(1),
  max: z.number().int().min(1).max(1024),
});

const scoreSchema = z.object({
  workerId: z.string().min(1),
  leaseId: z.string().min(1),
  evaluationId: z.string().min(1),
  index: z.number().int().min(0),
  score: z.number(),
});

const heartbeatSchema = z.object({
  workerId: z.string().min(1),
  leaseId: z.string().min(1),
});

const failSchema = z.object({
  workerId: z.string().min(1),
  evaluationId: z.string().min(1),
  reason: z.string().min(1),
});

export interface WorkerRoutesOptions {
  queue: JobQueue;
  registry: WorkerRegistry;
  /** How long a claim is valid before its jobs are re-dispatched. */
  leaseMs?: number;
  /** How long a worker may go unheard-from before it is reaped. */
  maxSilenceMs?: number;
}

/**
 * HTTP transport for workers.
 *
 * Deliberately transport-agnostic in shape: a worker thread, a remote box, and
 * (over WS) a browser tab all speak the same claim/lease/score/heartbeat
 * vocabulary. Nothing here knows what kind of worker it is talking to.
 */
export function registerWorkerRoutes(
  app: FastifyInstance,
  opts: WorkerRoutesOptions,
): void {
  const { queue, registry } = opts;
  const leaseMs = opts.leaseMs ?? 30_000;
  const maxSilenceMs = opts.maxSilenceMs ?? 60_000;

  /** Any worker call is also proof of life, and a chance to sweep. */
  const sweep = (): void => {
    queue.expireLeases();
    for (const dead of registry.reapStale(maxSilenceMs)) {
      queue.releaseWorker(dead);
    }
  };

  app.post("/api/workers/register", async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    sweep();
    const worker = registry.register(
      parsed.data.capabilities,
      parsed.data.kind ?? "unknown",
    );
    return { workerId: worker.workerId, leaseMs };
  });

  app.post("/api/workers/deregister", async (req, reply) => {
    const parsed = z.object({ workerId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    // Release before deregistering, so the jobs go back rather than stranding.
    queue.releaseWorker(parsed.data.workerId);
    return { ok: registry.deregister(parsed.data.workerId) };
  });

  app.post("/api/workers/claim", async (req, reply) => {
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    sweep();
    const { workerId, max } = parsed.data;
    if (!registry.touch(workerId)) {
      // Unknown worker: it was reaped, or never registered. Tell it to
      // re-register rather than silently handing it nothing forever.
      return reply.code(404).send({ error: "Unknown worker; re-register" });
    }
    const lease = queue.claimWithLease(
      workerId,
      registry.capabilityKeys(workerId),
      max,
      leaseMs,
    );
    if (!lease) return { idle: true as const };
    const jobs: EvalJobPayload[] = lease.jobs.map((j) => ({
      evaluationId: j.evaluationId,
      index: j.index,
      genome: j.genome,
      evaluatorId: j.evaluatorId,
      params: j.params,
    }));
    return { leaseId: lease.leaseId, expiresAt: lease.expiresAt, jobs };
  });

  app.post("/api/workers/score", async (req, reply) => {
    const parsed = scoreSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { workerId, evaluationId, index, score } = parsed.data;
    registry.touch(workerId);
    // Deliberately NOT gated on the lease still being valid: if the job is
    // still unscored, a late answer is perfectly good work and discarding it
    // wastes an inference. The queue refuses to overwrite an existing score.
    const applied = queue.submitScore(evaluationId, index, score);
    return { applied };
  });

  app.post("/api/workers/heartbeat", async (req, reply) => {
    const parsed = heartbeatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    registry.touch(parsed.data.workerId);
    const extended = queue.heartbeat(parsed.data.leaseId, leaseMs);
    // false means the lease is gone and the jobs were re-dispatched, so the
    // worker should stop and claim afresh instead of grinding on dead work.
    return { extended };
  });

  app.post("/api/workers/fail", async (req, reply) => {
    const parsed = failSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    registry.touch(parsed.data.workerId);
    queue.failEvaluation(
      parsed.data.evaluationId,
      new Error(`Worker reported failure: ${parsed.data.reason}`),
    );
    return { ok: true };
  });

  app.get("/api/workers", async () => {
    sweep();
    return {
      workers: registry.list().map((w) => ({
        workerId: w.workerId,
        kind: w.kind,
        capabilities: w.capabilities,
        lastSeen: w.lastSeen,
      })),
      queue: queue.stats(),
    };
  });
}
