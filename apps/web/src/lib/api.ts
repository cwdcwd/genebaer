import type {
  CreateRunResponse,
  OperatorMeta,
  RunConfig,
  RunControlAction,
  RunDetail,
  RunStatus,
  RunSummary,
} from "@genebaer/shared-types";
import { API_URL } from "./config";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body || res.statusText);
  }
  return (await res.json()) as T;
}

export const api = {
  listOperators: () => request<OperatorMeta[]>("/api/operators"),
  listProblems: () => request<OperatorMeta[]>("/api/problems"),
  createRun: (config: RunConfig) =>
    request<CreateRunResponse>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ config }),
    }),
  listRuns: () => request<RunSummary[]>("/api/runs"),
  getRun: (id: string) => request<RunDetail>(`/api/runs/${id}`),
  controlRun: (id: string, action: RunControlAction) =>
    request<{ ok: true; status: RunStatus }>(`/api/runs/${id}/control`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
  getVisual: (id: string) =>
    request<{ problemId: string; data: unknown }>(`/api/runs/${id}/visual`),
  /** Diagnostics for a run that is not advancing. */
  evalStats: () => request<EvalStats>("/api/eval/stats"),
  /** Direct link, not a fetch: the browser downloads it. */
  imageUrl: (id: string) => `${API_URL}/api/runs/${id}/image.png`,
  deleteRun: (id: string) =>
    request<{ ok: true }>(`/api/runs/${id}`, { method: "DELETE" }),
};

/** Shape of GET /api/eval/stats. */
export interface EvalStats {
  queue: {
    pending: number;
    openEvaluations: number;
    activeLeases: number;
    expiredLeases: number;
  };
  cache: { hits: number; misses: number; dedupedInBatch: number } | null;
  workers: {
    workerId: string;
    kind: string;
    capabilities: { evaluatorId: string; version: string }[];
    lastSeen: number;
  }[];
  blockers: {
    evaluationId: string;
    contract: string;
    remaining: number;
    unclaimed: number;
    queueWaitMs: number;
    scoringMs: number;
    heldBy: string[];
    /** False means nothing connected can score this — the usual cause of a stall. */
    servable: boolean;
  }[];
}
