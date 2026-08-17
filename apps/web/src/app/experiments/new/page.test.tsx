import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperatorMeta, RunConfig } from "@genebaer/shared-types";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const listOperators = vi.fn<() => Promise<OperatorMeta[]>>();
const createRun = vi.fn<(c: RunConfig) => Promise<{ runId: string }>>();
// The form asks the server how many genes the problem needs (genebaer-7tu).
// These tests are about the evaluator section, so it answers "any length".
const genomeLength = vi.fn(() => Promise.resolve({ genomeLength: null }));
vi.mock("@/lib/api", () => ({
  api: {
    listOperators: () => listOperators(),
    createRun: (c: RunConfig) => createRun(c),
    genomeLength: () => genomeLength(),
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

/** A registry with two evaluators, one of which takes params. */
function operators(): OperatorMeta[] {
  return [
    meta({ id: "one-max", kind: "problem", compatibleEncodings: ["binary"] }),
    meta({
      id: "image-prompt",
      kind: "problem",
      compatibleEncodings: ["binary"],
      scorableInProcess: false,
    }),
    meta({
      id: "binary",
      kind: "encoding",
      paramsSchema: { length: { type: "integer", default: 32, title: "Length" } },
    }),
    meta({ id: "tournament", kind: "selection" }),
    meta({ id: "uniform", kind: "crossover" }),
    meta({ id: "bit-flip", kind: "mutation" }),
    meta({
      id: "max-generations",
      kind: "termination",
      paramsSchema: {
        maxGenerations: { type: "integer", default: 50, title: "Max generations" },
      },
    }),
    meta({ id: "local", kind: "evaluator", displayName: "In-process", scoresInProcess: true }),
    meta({
      id: "clip-similarity",
      kind: "evaluator",
      displayName: "CLIP similarity",
      paramsSchema: {
        augmentations: {
          type: "integer",
          default: 1,
          minimum: 1,
          title: "Augmented views",
        },
      },
    }),
  ];
}

async function renderForm(ops: OperatorMeta[] = operators()) {
  listOperators.mockResolvedValue(ops);
  createRun.mockResolvedValue({ runId: "r1" });
  render(<NewExperimentPage />);
  await screen.findByText(/Evaluator/);
}

/** The evaluator dropdown, addressed the way a person would find it. */
function evaluatorSelect(): HTMLSelectElement {
  const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
  const found = selects.find((s) =>
    [...s.options].some((o) => o.value === "clip-similarity"),
  );
  if (!found) throw new Error("no evaluator select rendered");
  return found;
}

describe("the evaluator section", () => {
  it("exists at all, which it did not before", async () => {
    // genebaer-kns: the form built every other operator kind from registry
    // metadata and silently skipped the evaluator, so a run created in the
    // browser always took the default with default params.
    await renderForm();
    expect(screen.getByText(/Evaluator \(where fitness is computed\)/)).toBeDefined();
  });

  it("lists every registered evaluator", async () => {
    await renderForm();
    const values = [...evaluatorSelect().options].map((o) => o.value);
    expect(values).toContain("local");
    expect(values).toContain("clip-similarity");
  });

  it("defaults to the same evaluator the engine would have picked", async () => {
    // Surfacing the choice must not change what an otherwise-identical run does.
    await renderForm();
    expect(evaluatorSelect().value).toBe("local");
  });

  it("says nothing is available rather than rendering an empty control", async () => {
    const withoutEvaluators = operators().filter((o) => o.kind !== "evaluator");
    listOperators.mockResolvedValue(withoutEvaluators);
    createRun.mockResolvedValue({ runId: "r1" });
    render(<NewExperimentPage />);
    expect(await screen.findByText(/No evaluators registered/)).toBeDefined();
  });
});

describe("what reaches the server", () => {
  it("sends the chosen evaluator in the run config", async () => {
    await renderForm();
    const user = userEvent.setup();
    await user.selectOptions(evaluatorSelect(), "clip-similarity");
    await user.click(screen.getByRole("button", { name: /start run/i }));

    await waitFor(() => expect(createRun).toHaveBeenCalled());
    const config = createRun.mock.calls[0]?.[0];
    expect(config?.evaluator?.id).toBe("clip-similarity");
  });

  it("renders the chosen evaluator's params and sends them", async () => {
    // The concrete gap this bead closes: 'augmentations' is the whole
    // adversarial-robustness defence and was unreachable from the browser.
    await renderForm();
    const user = userEvent.setup();
    await user.selectOptions(evaluatorSelect(), "clip-similarity");

    const augmentations = await screen.findByLabelText(/Augmented views/i);
    await user.clear(augmentations);
    await user.type(augmentations, "8");
    await user.click(screen.getByRole("button", { name: /start run/i }));

    await waitFor(() => expect(createRun).toHaveBeenCalled());
    const config = createRun.mock.calls[0]?.[0];
    expect(config?.evaluator?.params?.["augmentations"]).toBe(8);
  });

  it("resets params when the evaluator changes, so stale ones are not sent", async () => {
    // Carrying 'augmentations' over to an evaluator that has no such param
    // would send a config the server would reject or silently ignore.
    //
    // The value must actually be EDITED before switching away. Switching
    // straight after selecting leaves the params at their (empty) defaults, so
    // a carry-over bug would look identical to correct behaviour — which is
    // exactly what an earlier version of this test failed to catch.
    await renderForm();
    const user = userEvent.setup();
    await user.selectOptions(evaluatorSelect(), "clip-similarity");
    const augmentations = await screen.findByLabelText(/Augmented views/i);
    await user.clear(augmentations);
    await user.type(augmentations, "8");

    await user.selectOptions(evaluatorSelect(), "local");
    await user.click(screen.getByRole("button", { name: /start run/i }));

    await waitFor(() => expect(createRun).toHaveBeenCalled());
    const config = createRun.mock.calls[0]?.[0];
    expect(config?.evaluator?.id).toBe("local");
    expect(config?.evaluator?.params).toEqual({});
  });
});

describe("not offering a run that cannot possibly work", () => {
  /** The problem dropdown, found the way a person would. */
  function problemSelect(): HTMLSelectElement {
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const found = selects.find((s) =>
      [...s.options].some((o) => o.value === "image-prompt"),
    );
    if (!found) throw new Error("no problem select rendered");
    return found;
  }

  it("moves off the in-process evaluator when the problem cannot use it", async () => {
    // genebaer-gdv, as reported: picking the image problem left 'local'
    // selected, and the run died on generation 0.
    await renderForm();
    const user = userEvent.setup();
    await user.selectOptions(problemSelect(), "image-prompt");

    await waitFor(() => expect(evaluatorSelect().value).not.toBe("local"));
    expect(evaluatorSelect().value).toBe("clip-similarity");
  });

  it("sends a runnable config without the user touching the evaluator", async () => {
    await renderForm();
    const user = userEvent.setup();
    await user.selectOptions(problemSelect(), "image-prompt");
    await waitFor(() => expect(evaluatorSelect().value).toBe("clip-similarity"));
    await user.click(screen.getByRole("button", { name: /start run/i }));

    await waitFor(() => expect(createRun).toHaveBeenCalled());
    expect(createRun.mock.calls[0]?.[0]?.evaluator?.id).toBe("clip-similarity");
  });

  it("disables the impossible option rather than hiding it", async () => {
    // A vanishing option reads as a bug in the form; a disabled one with a
    // reason reads as information.
    await renderForm();
    const user = userEvent.setup();
    await user.selectOptions(problemSelect(), "image-prompt");

    await waitFor(() => {
      const local = [...evaluatorSelect().options].find((o) => o.value === "local");
      expect(local?.disabled).toBe(true);
      expect(local?.text).toMatch(/cannot score this problem/);
    });
  });

  it("keeps the in-process evaluator selectable for ordinary problems", async () => {
    await renderForm();
    expect(evaluatorSelect().value).toBe("local");
    const local = [...evaluatorSelect().options].find((o) => o.value === "local");
    expect(local?.disabled).toBe(false);
  });
});
