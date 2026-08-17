import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorMeta } from "@genebaer/shared-types";

const listOperators = vi.fn<() => Promise<OperatorMeta[]>>();
vi.mock("@/lib/api", () => ({
  api: { listOperators: () => listOperators() },
}));

// The scorer loads a model from a CDN; the panel only needs it to exist.
vi.mock("@/lib/clip-browser", async () => {
  const actual = await vi.importActual<typeof import("@/lib/clip-browser")>(
    "@/lib/clip-browser",
  );
  return { ...actual, createClipScorer: () => () => Promise.resolve(0.5) };
});

import { WorkerPanel } from "./worker-panel";

const evaluator: OperatorMeta = {
  id: "clip-similarity",
  kind: "evaluator",
  displayName: "CLIP similarity",
  description: "Scores an image against a prompt.",
  paramsSchema: {},
  version: "clip-vit-base-patch32.2",
};

/** Pretend this browser does or does not expose WebGPU. */
function setWebGPU(present: boolean): void {
  if (present) {
    Object.defineProperty(globalThis.navigator, "gpu", {
      value: {},
      configurable: true,
    });
  } else {
    Reflect.deleteProperty(globalThis.navigator as unknown as object, "gpu");
  }
}

beforeEach(() => {
  listOperators.mockResolvedValue([evaluator]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setWebGPU(false);
});

async function renderPanel() {
  await act(async () => {
    render(<WorkerPanel />);
    await Promise.resolve();
  });
}

describe("a browser without WebGPU", () => {
  it("offers to score anyway, rather than declaring itself unable", async () => {
    // genebaer-v5f, as reported: this showed "This browser has no WebGPU, so
    // it cannot score" and refused. WebGPU is faster, not required.
    setWebGPU(false);
    await renderPanel();

    expect(screen.queryByText(/cannot score/)).toBeNull();
    expect(screen.getByRole("button", { name: /start/i })).not.toHaveProperty(
      "disabled",
      true,
    );
  });

  it("says it will be slow, so a crawling run is explicable", async () => {
    // Said up front rather than discovered by watching a counter barely move.
    setWebGPU(false);
    await renderPanel();

    expect(screen.getByText(/wasm/)).toBeDefined();
    expect(screen.getByText(/much slower/)).toBeDefined();
  });

  it("never advises running a server-side worker, which does not exist", async () => {
    // The old message pointed at one. Nothing outside tests constructs the
    // worker pool, so that advice could not be followed.
    setWebGPU(false);
    await renderPanel();
    expect(screen.queryByText(/server-side worker/)).toBeNull();
  });
});

describe("a browser with WebGPU", () => {
  it("uses it and says so", async () => {
    setWebGPU(true);
    await renderPanel();

    expect(screen.getByText(/webgpu/)).toBeDefined();
    expect(screen.queryByText(/much slower/)).toBeNull();
  });
});

describe("what still blocks registration", () => {
  it("refuses when the server has no evaluator this tab can satisfy", async () => {
    // Unchanged by the WASM fallback: a missing capability is a real dead end,
    // and registering with a guess is the silent failure genebaer-vnb fixed.
    listOperators.mockResolvedValue([]);
    setWebGPU(true);
    await renderPanel();

    expect(screen.getByText(/no 'clip-similarity' evaluator registered/)).toBeDefined();
    expect(screen.getByRole("button", { name: /start/i })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
