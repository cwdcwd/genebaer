import { Suspense } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunDetail } from "@genebaer/shared-types";
import type { RunStream } from "@/lib/use-run-stream";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const getRun = vi.fn<() => Promise<RunDetail>>();
const getVisual = vi.fn(() => Promise.reject(new Error("no visual")));
/**
 * The whole page tree, not just the page.
 *
 * WorkerPanel calls listOperators, EvalDiagnostics polls evalStats, and the
 * header builds a PNG link with imageUrl. A missing method throws inside a
 * child's effect and unmounts the tree, so the page renders nothing and every
 * assertion fails for a reason unrelated to what is being tested. Mocking the
 * whole surface is cheaper than rediscovering that one method at a time.
 */
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {
    status = 500;
  },
  api: {
    getRun: () => getRun(),
    getVisual: () => getVisual(),
    controlRun: vi.fn(),
    listOperators: () => Promise.resolve([]),
    listProblems: () => Promise.resolve([]),
    genomeLength: () => Promise.resolve({ genomeLength: null }),
    createRun: vi.fn(),
    listRuns: () => Promise.resolve([]),
    deleteRun: vi.fn(),
    evalStats: () =>
      Promise.resolve({
        queue: { pending: 0, inflight: 0, done: 0 },
        cache: { size: 0, hits: 0, misses: 0 },
        workers: [],
        blockers: [],
      }),
    imageUrl: (id: string) => `/api/runs/${id}/image.png`,
  },
}));

const stream = vi.fn<() => RunStream>();
vi.mock("@/lib/use-run-stream", () => ({
  useRunStream: () => stream(),
}));

import RunDetailPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function emptyStream(over: Partial<RunStream> = {}): RunStream {
  return {
    stats: [],
    status: null,
    lastBest: null,
    finished: null,
    connected: false,
    annotations: [],
    failure: null,
    ...over,
  };
}

function detail(over: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "r1",
    status: "error",
    createdAt: 1000,
    finishedAt: 5000,
    finalBestFitness: null,
    currentGeneration: 0,
    stats: [],
    config: {
      problem: { id: "image-prompt", params: {} },
      encoding: { id: "numeric", params: {} },
      selection: { id: "tournament" },
      crossover: { id: "uniform" },
      mutation: { id: "gaussian" },
      mutationRate: 0.05,
      populationSize: 8,
      elitism: 1,
      termination: [{ id: "max-generations", params: { maxGenerations: 3 } }],
      seed: 1,
    },
    ...over,
  };
}

/**
 * The page reads promise-shaped `params` via React's `use()`, which suspends.
 *
 * Two things are load-bearing: a Suspense boundary, or the tree renders
 * nothing at all; and awaiting that promise inside `act`, or the resolution
 * lands outside React's work loop and the committed DOM is still the fallback
 * when assertions run.
 */
async function renderPage() {
  const params = Promise.resolve({ id: "r1" });
  await act(async () => {
    render(
      <Suspense fallback={<div>loading route</div>}>
        <RunDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
  // Let the page's own data effects settle before anything is asserted.
  await act(async () => {
    await Promise.resolve();
  });
}

const REASON =
  "'image-prompt' cannot be scored in-process: fitness is a model's judgement " +
  "of the rendered image against the prompt. Configure a model-backed evaluator " +
  "(for example 'clip-similarity') on the run.";

describe("a failed run explains itself", () => {
  it("shows the reason streamed live", async () => {
    // genebaer-29p, as reported: the UI said a run errored and nothing about
    // why. The message existed only in the server's stdout.
    getRun.mockResolvedValue(detail());
    stream.mockReturnValue(emptyStream({ status: "error", failure: REASON }));
    await renderPage();

    const banner = (await screen.findByText(/This run failed/)).parentElement!;
    // Scoped to the banner: 'clip-similarity' also appears elsewhere on the
    // page, and an unscoped matcher would pass without the reason rendering.
    expect(within(banner).getByText(REASON)).toBeDefined();
    // The advice is the useful half; it must reach the reader intact.
    expect(within(banner).getByText(/clip-similarity/)).toBeDefined();
  });

  it("falls back to the persisted reason, so a reload still explains it", async () => {
    // The error frame only reaches clients already subscribed. Opening the run
    // afterwards is the common case and must not lose the explanation.
    getRun.mockResolvedValue(detail({ stopReason: REASON }));
    stream.mockReturnValue(emptyStream({ status: "error", failure: null }));
    await renderPage();

    expect(await screen.findByText(/cannot be scored in-process/)).toBeDefined();
  });

  it("says where to look when no reason was recorded at all", async () => {
    // Runs that errored before this existed have no stopReason. Rendering an
    // empty red box would be the original bug with extra styling.
    getRun.mockResolvedValue(detail());
    stream.mockReturnValue(emptyStream({ status: "error", failure: null }));
    await renderPage();

    expect(await screen.findByText(/No reason was recorded/)).toBeDefined();
    expect(screen.getByText(/server log/)).toBeDefined();
  });

  it("prefers the live reason over a stale persisted one", async () => {
    getRun.mockResolvedValue(detail({ stopReason: "an older reason" }));
    stream.mockReturnValue(emptyStream({ status: "error", failure: "the live reason" }));
    await renderPage();

    expect(await screen.findByText("the live reason")).toBeDefined();
    expect(screen.queryByText("an older reason")).toBeNull();
  });
});

describe("a healthy run stays quiet", () => {
  it("shows no failure banner while running", async () => {
    getRun.mockResolvedValue(detail({ status: "running", finishedAt: null }));
    stream.mockReturnValue(emptyStream({ status: "running" }));
    await renderPage();

    await screen.findByText(/Control/);
    expect(screen.queryByText(/This run failed/)).toBeNull();
  });

  it("shows no failure banner for a run that finished normally", async () => {
    // A stopReason is set for ordinary completion too ("reached generation
    // 50"), so keying the banner off its presence would flag every finished run.
    getRun.mockResolvedValue(
      detail({ status: "finished", stopReason: "reached max generations" }),
    );
    stream.mockReturnValue(emptyStream({ status: "finished" }));
    await renderPage();

    await screen.findByText(/Control/);
    expect(screen.queryByText(/This run failed/)).toBeNull();
  });
});
