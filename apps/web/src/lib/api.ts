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
  deleteRun: (id: string) =>
    request<{ ok: true }>(`/api/runs/${id}`, { method: "DELETE" }),
};
