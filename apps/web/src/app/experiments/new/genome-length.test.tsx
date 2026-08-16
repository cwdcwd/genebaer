import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperatorMeta, RunConfig } from "@genebaer/shared-types";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const listOperators = vi.fn<() => Promise<OperatorMeta[]>>();
const createRun = vi.fn<(c: RunConfig) => Promise<{ runId: string }>>();
const genomeLength =
  vi.fn<(id: string, p: Record<string, unknown>) => Promise<{ genomeLength: number | null }>>();
vi.mock("@/lib/api", () => ({
  api: {
    listOperators: () => listOperators(),
    createRun: (c: RunConfig) => createRun(c),
    genomeLength: (id: string, p: Record<string, unknown>) => genomeLength(id, p),
  },
}));

import NewExperimentPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

function meta(over: Partial<OperatorMeta> & Pick<OperatorMeta, "id" | "kind">): OperatorMeta {
  return {
    displayName: over.id,
    description: `${over.id} description`,
    paramsSchema: {},
    ...over,
  };
}

function operators(): OperatorMeta[] {
  return [
    meta({ id: "weasel", kind: "problem", compatibleEncodings: ["string"] }),
    meta({ id: "one-max", kind: "problem", compatibleEncodings: ["binary"] }),
    meta({
      id: "string",
      kind: "encoding",
      sizeParam: "length",
      paramsSchema: { length: { type: "integer", default: 32, title: "String length" } },
    }),
    meta({
      id: "binary",
      kind: "encoding",
      sizeParam: "length",
      paramsSchema: { length: { type: "integer", default: 64, title: "Genome length (bits)" } },
    }),
    meta({ id: "tournament", kind: "selection" }),
    meta({ id: "uniform", kind: "crossover" }),
    meta({ id: "char", kind: "mutation", compatibleEncodings: ["string"] }),
    meta({ id: "bit-flip", kind: "mutation", compatibleEncodings: ["binary"] }),
    meta({
      id: "max-generations",
      kind: "termination",
      paramsSchema: { maxGenerations: { type: "integer", default: 50, title: "Max generations" } },
    }),
    meta({ id: "local", kind: "evaluator" }),
  ];
}

async function renderForm(length: number | null = 28) {
  listOperators.mockResolvedValue(operators());
  createRun.mockResolvedValue({ runId: "r1" });
  genomeLength.mockResolvedValue({ genomeLength: length });
  render(<NewExperimentPage />);
  await screen.findByText(/Encoding/);
}

async function submittedConfig(): Promise<RunConfig | undefined> {
  await userEvent.setup().click(screen.getByRole("button", { name: /start run/i }));
  await waitFor(() => expect(createRun).toHaveBeenCalled());
  return createRun.mock.calls[0]?.[0];
}

describe("sizing the encoding to the problem", () => {
  it("sends the length the problem requires, not the schema default", async () => {
    // genebaer-7tu: the form filtered encodings by compatibility but never
    // sized them, so the user had to compute the number by hand or the run
    // failed. The schema default here is 32; the problem needs 28.
    await renderForm(28);
    await waitFor(() => expect(genomeLength).toHaveBeenCalled());
    const config = await submittedConfig();
    expect(config?.encoding.params?.["length"]).toBe(28);
  });

  it("says so, rather than silently overwriting the field", async () => {
    await renderForm(28);
    expect(await screen.findByText(/fixes/)).toBeDefined();
    expect(screen.getByText("28")).toBeDefined();
  });

  it("re-asks when the problem's params change", async () => {
    await renderForm(28);
    await waitFor(() => expect(genomeLength).toHaveBeenCalled());
    const before = genomeLength.mock.calls.length;

    genomeLength.mockResolvedValue({ genomeLength: 40 });
    const user = userEvent.setup();
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const problemSelect = selects.find((s) =>
      [...s.options].some((o) => o.value === "one-max"),
    )!;
    await user.selectOptions(problemSelect, "one-max");

    await waitFor(() => expect(genomeLength.mock.calls.length).toBeGreaterThan(before));
    const config = await submittedConfig();
    expect(config?.encoding.params?.["length"]).toBe(40);
  });

  it("leaves the size alone when any length works", async () => {
    // OneMax scores whatever the encoding produces; overwriting a size the user
    // chose on purpose would be worse than doing nothing.
    await renderForm(null);
    await waitFor(() => expect(genomeLength).toHaveBeenCalled());
    const config = await submittedConfig();
    expect(config?.encoding.params?.["length"]).toBe(32);
    expect(screen.queryByText(/fixes/)).toBeNull();
  });

  it("does not size an encoding that declares no size param", async () => {
    const ops = operators().map((o) =>
      o.kind === "encoding" ? { ...o, sizeParam: undefined } : o,
    );
    listOperators.mockResolvedValue(ops as OperatorMeta[]);
    createRun.mockResolvedValue({ runId: "r1" });
    genomeLength.mockResolvedValue({ genomeLength: 28 });
    render(<NewExperimentPage />);
    await screen.findByText(/Encoding/);
    await waitFor(() => expect(genomeLength).toHaveBeenCalled());
    const config = await submittedConfig();
    expect(config?.encoding.params?.["length"]).toBe(32);
  });
});
