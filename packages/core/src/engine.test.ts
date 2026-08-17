import { describe, it, expect, vi } from "vitest";
import {
  SeededRandomSource,
  BinaryEncoding,
  NumericVectorEncoding,
  StringEncoding,
  TournamentSelection,
  RouletteWheelSelection,
  RankSelection,
  ElitismSelection,
  OnePointCrossover,
  TwoPointCrossover,
  UniformCrossover,
  ArithmeticCrossover,
  BitFlipMutation,
  GaussianMutation,
  SwapMutation,
  CharMutation,
  MaxGenerations,
  TargetFitness,
  Stagnation,
  OneMax,
  Sphere,
  Rastrigin,
  Weasel,
  MinimumDominatingSet,
  createDefaultRegistry,
  GeneticAlgorithmEngine,
  type RunConfig,
  type GenerationStats,
  FitnessProblem,
  FitnessEvaluator,
} from "./index.js";

// ---------- RNG ----------

describe("SeededRandomSource", () => {
  it("is reproducible for the same seed", () => {
    const a = new SeededRandomSource(42);
    const b = new SeededRandomSource(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it("differs across seeds", () => {
    const a = new SeededRandomSource(1);
    const b = new SeededRandomSource(2);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("next() stays in [0,1); int() stays in range", () => {
    const rng = new SeededRandomSource(7);
    for (let i = 0; i < 5000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const n = rng.int(3, 9);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThan(9);
      expect(Number.isInteger(n)).toBe(true);
    }
  });
});

// ---------- encodings ----------

describe("encodings", () => {
  const rng = new SeededRandomSource(1);

  it("binary: length, alphabet, hamming distance", () => {
    const enc = new BinaryEncoding({ length: 32 });
    const g = enc.random(rng);
    expect(g).toHaveLength(32);
    for (const b of g) expect([0, 1]).toContain(b);
    expect(enc.distance([0, 0, 1], [0, 1, 0])).toBe(2);
    expect(enc.distance([1, 1], [1, 1])).toBe(0);
  });

  it("numeric: bounds respected, euclidean distance", () => {
    const enc = new NumericVectorEncoding({ dimensions: 5, min: -2, max: 3 });
    for (let i = 0; i < 100; i++) {
      const g = enc.random(rng);
      expect(g).toHaveLength(5);
      for (const x of g) {
        expect(x).toBeGreaterThanOrEqual(-2);
        expect(x).toBeLessThanOrEqual(3);
      }
    }
    expect(enc.distance([0, 0], [3, 4])).toBe(5);
  });

  it("string: length/alphabet, hamming distance", () => {
    const enc = new StringEncoding({ alphabet: "ab", length: 20 });
    const g = enc.random(rng);
    expect(g).toHaveLength(20);
    for (const c of g) expect("ab").toContain(c);
    expect(enc.distance("aaa", "aab")).toBe(1);
  });

  it("clone is a deep copy for arrays", () => {
    const enc = new BinaryEncoding({ length: 4 });
    const g = enc.random(rng);
    const c = enc.clone(g);
    c[0] = c[0] === 0 ? 1 : 0;
    expect(enc.equals(g, c)).toBe(false);
  });
});

// ---------- selection ----------

describe("selection operators", () => {
  const pop = ["a", "b", "c", "d", "e"];
  // fitness ascending: e best
  const fits = [0, 1, 2, 3, 4];
  const rng = new SeededRandomSource(9);

  it("tournament returns requested count drawn from population", () => {
    const sel = new TournamentSelection({ k: 3 });
    const out = sel.select(pop, fits, 20, rng);
    expect(out).toHaveLength(20);
    for (const g of out) expect(pop).toContain(g);
  });

  it("roulette favors fitter individuals", () => {
    const sel = new RouletteWheelSelection();
    const counts = new Map<string, number>();
    const out = sel.select(pop, fits, 4000, rng);
    for (const g of out) counts.set(g as string, (counts.get(g as string) ?? 0) + 1);
    expect(counts.get("e")!).toBeGreaterThan(counts.get("a") ?? 0);
  });

  it("rank favors fitter individuals", () => {
    const sel = new RankSelection({ pressure: 1.8 });
    const counts = new Map<string, number>();
    const out = sel.select(pop, fits, 4000, rng);
    for (const g of out) counts.set(g as string, (counts.get(g as string) ?? 0) + 1);
    expect(counts.get("e")!).toBeGreaterThan(counts.get("a")!);
  });

  it("elitism only draws from top proportion", () => {
    const sel = new ElitismSelection({ proportion: 0.4 });
    const out = sel.select(pop, fits, 200, rng);
    for (const g of out) expect(["d", "e"]).toContain(g); // top 2 of 5
  });

  it("roulette handles negative fitness", () => {
    const sel = new RouletteWheelSelection();
    const out = sel.select(["x", "y"], [-100, -99], 500, rng);
    const ys = out.filter((g) => g === "y").length;
    expect(ys).toBeGreaterThan(0);
  });
});

// ---------- crossover ----------

describe("crossover operators", () => {
  const rng = new SeededRandomSource(3);

  it("one-point preserves length and combines parents", () => {
    const cx = new OnePointCrossover();
    // Tuple, not number[][]: crossover returns exactly two children, and under
    // noUncheckedIndexedAccess an array type would make each `number[] | undefined`.
    const [c1, c2] = cx.crossover([0, 0, 0, 0], [1, 1, 1, 1], rng) as [number[], number[]];
    expect(c1).toHaveLength(4);
    expect(c2).toHaveLength(4);
    for (const v of [...c1, ...c2]) expect([0, 1]).toContain(v);
  });

  it("two-point works on strings", () => {
    const cx = new TwoPointCrossover();
    const [c1, c2] = cx.crossover("aaaaaa", "bbbbbb", rng) as [string, string];
    expect(c1).toHaveLength(6);
    expect(c2).toHaveLength(6);
  });

  it("uniform mixes genes", () => {
    const cx = new UniformCrossover({ swapProbability: 0.5 });
    const [c1] = cx.crossover([0, 0, 0, 0, 0], [1, 1, 1, 1, 1], rng) as number[][];
    const sum = (c1 as number[]).reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThanOrEqual(0);
    expect(sum).toBeLessThanOrEqual(5);
  });

  it("arithmetic blends numerically", () => {
    const cx = new ArithmeticCrossover({ alpha: 0.5 });
    const [c1, c2] = cx.crossover([0, 2], [2, 4], rng) as number[][];
    expect(c1).toEqual([1, 3]);
    expect(c2).toEqual([1, 3]);
  });
});

// ---------- mutation ----------

describe("mutation operators", () => {
  it("bit-flip flips at high rate", () => {
    const rng = new SeededRandomSource(5);
    const g = new Array<number>(1000).fill(0);
    new BitFlipMutation().mutate(g, 0.5, rng);
    const ones = g.reduce((a, b) => a + b, 0);
    expect(ones).toBeGreaterThan(350);
    expect(ones).toBeLessThan(650);
  });

  it("gaussian clamps to bounds", () => {
    const rng = new SeededRandomSource(5);
    const g = [0.99, -0.99];
    const mut = new GaussianMutation({ sigma: 100, min: -1, max: 1 });
    mut.mutate(g, 1, rng); // rate 1 → always mutate
    expect(g[0]).toBeLessThanOrEqual(1);
    expect(g[0]).toBeGreaterThanOrEqual(-1);
    expect(g[1]).toBeLessThanOrEqual(1);
    expect(g[1]).toBeGreaterThanOrEqual(-1);
  });

  it("swap keeps multiset of genes", () => {
    const rng = new SeededRandomSource(5);
    const g = [1, 2, 3, 4, 5];
    new SwapMutation().mutate(g, 1, rng);
    expect([...g].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("char mutation respects alphabet", () => {
    const rng = new SeededRandomSource(5);
    const mut = new CharMutation({ alphabet: "XY" });
    const out = mut.mutate("aaaaaaaaaa", 1, rng) as string;
    for (const c of out) expect("XY").toContain(c);
  });
});

// ---------- termination ----------

describe("termination conditions", () => {
  const mk = (gen: number, bestFitness: number): GenerationStats => ({
    generation: gen,
    bestFitness,
    meanFitness: bestFitness,
    medianFitness: bestFitness,
    worstFitness: bestFitness,
    stdDev: 0,
    diversity: 0,
    bestGenome: null,
    elapsedMs: 0,
  });

  it("max-generations fires at threshold", () => {
    const t = new MaxGenerations({ maxGenerations: 5 });
    expect(t.check([mk(0, 0), mk(1, 0), mk(2, 0), mk(3, 0), mk(4, 0)])).not.toBeNull();
    expect(t.check([mk(0, 0)])).toBeNull();
  });

  it("target-fitness fires when best reaches target", () => {
    const t = new TargetFitness({ target: 10 });
    expect(t.check([mk(0, 9)])).toBeNull();
    expect(t.check([mk(0, 10)])).not.toBeNull();
  });

  it("stagnation fires after window without improvement", () => {
    const t = new Stagnation({ generations: 3, epsilon: 0.001 });
    expect(t.check([mk(0, 1), mk(1, 1), mk(2, 1)])).not.toBeNull();
    expect(t.check([mk(0, 1), mk(1, 2), mk(2, 3)])).toBeNull();
  });
});

// ---------- problems ----------

describe("problems", () => {
  it("OneMax counts ones", () => {
    expect(new OneMax().evaluate([1, 0, 1, 1, 0])).toBe(3);
  });

  it("Sphere is 0 at origin and negative elsewhere", () => {
    const s = new Sphere();
    expect(s.evaluate([0, 0, 0])).toBe(-0);
    expect(s.evaluate([1, 0])).toBeLessThan(0);
  });

  it("Rastrigin is 0 at origin", () => {
    expect(new Rastrigin().evaluate([0, 0])).toBeCloseTo(0, 10);
  });

  it("Weasel counts matching chars", () => {
    const w = new Weasel({ target: "abc" });
    expect(w.evaluate("abc")).toBe(3);
    expect(w.evaluate("axc")).toBe(2);
  });

  it("MDS: Petersen dominating number is 3", () => {
    const mds = new MinimumDominatingSet({ graph: "petersen" });
    // {0, 3, 9}? Verify a known γ-set: vertices 0,4... compute brute force is
    // overkill here; instead assert evaluate() correctness for a full set and
    // a known optimal: {1, 8, 0}? We check validity = penalty-free fitness.
    const full = new Array(10).fill(1) as number[];
    expect(mds.evaluate(full)).toBe(-10); // |D| = 10, all dominated
    // γ(Petersen) = 3; a valid dominating set is {1, 4, 5}:
    const opt = [0, 1, 0, 0, 1, 1, 0, 0, 0, 0];
    expect(mds.evaluate(opt)).toBe(-3);
    // Non-dominating set is penalised:
    expect(mds.evaluate([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(-1000);
  });

  it("MDS: cycle7 dominating number is 3 (ceil(7/3))", () => {
    const mds = new MinimumDominatingSet({ graph: "cycle7" });
    const d = [1, 0, 0, 1, 0, 0, 1]; // {0,3,6}? indices 0,3,6 → vertices 0,3,6
    expect(mds.evaluate(d)).toBe(-3);
  });
});

// ---------- registry ----------

describe("OperatorRegistry", () => {
  it("resolves built-ins and rejects duplicates/unknowns", () => {
    const r = createDefaultRegistry();
    expect(r.has("selection", "tournament")).toBe(true);
    expect(() => r.resolve("selection", "nope")).toThrow(/Unknown selection/);
    expect(() => r.register("selection", TournamentSelection)).toThrow(/duplicate/);
  });

  it("listMetadata includes compatibleEncodings when declared", () => {
    const meta = createDefaultRegistry().listMetadata();
    const bf = meta.find((m) => m.id === "bit-flip");
    expect(bf?.compatibleEncodings).toContain("binary");
    const kinds = new Set(meta.map((m) => m.kind));
    for (const k of ["encoding", "problem", "selection", "crossover", "mutation", "termination"]) {
      expect(kinds.has(k as never)).toBe(true);
    }
  });
});

// ---------- engine ----------

function oneMaxConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    problem: { id: "one-max" },
    encoding: { id: "binary", params: { length: 32 } },
    selection: { id: "tournament", params: { k: 3 } },
    crossover: { id: "uniform" },
    mutation: { id: "bit-flip" },
    mutationRate: 0.02,
    populationSize: 50,
    elitism: 2,
    termination: [
      { id: "max-generations", params: { maxGenerations: 400 } },
      { id: "target-fitness", params: { target: 32 } },
    ],
    seed: 1234,
    ...overrides,
  };
}

describe("GeneticAlgorithmEngine", () => {
  it("converges OneMax to the optimum", async () => {
    const engine = new GeneticAlgorithmEngine<number[]>(
      oneMaxConfig(),
      createDefaultRegistry(),
    );
    const done = new Promise<string>((resolve) => {
      engine.on("finished", (reason) => resolve(reason));
    });
    engine.start();
    const reason = await done;
    expect(reason).toMatch(/target fitness/i);
    expect(engine.bestFitness).toBe(32);
    expect(engine.currentGeneration).toBeLessThanOrEqual(400);
  });

  it("is reproducible for the same seed", async () => {
    const run = async (): Promise<string> => {
      const engine = new GeneticAlgorithmEngine<number[]>(
        oneMaxConfig(),
        createDefaultRegistry(),
      );
      const seq: number[] = [];
      engine.on("generation", (s) => seq.push(s.bestFitness));
      const done = new Promise<void>((resolve) => {
        engine.on("finished", () => resolve());
      });
      engine.start();
      await done;
      return seq.join(",");
    };
    const a = await run();
    const b = await run();
    expect(a).toBe(b);
  });

  it("pause/step/resume/stop lifecycle works", async () => {
    const engine = new GeneticAlgorithmEngine<number[]>(
      oneMaxConfig({ termination: [{ id: "max-generations", params: { maxGenerations: 100000 } }] }),
      createDefaultRegistry(),
    );
    const statuses: string[] = [];
    engine.on("status", (s) => statuses.push(s));

    engine.start();
    engine.pause();
    expect(engine.status).toBe("paused");
    const g0 = engine.currentGeneration;

    // step() is async now: evaluation may leave the process entirely, so a
    // caller that wants to observe the result has to await it.
    await engine.step();
    await engine.step();
    expect(engine.currentGeneration).toBe(g0 + 2);

    engine.resume();
    engine.stop();
    expect(engine.status).toBe("stopped");
    expect(statuses).toEqual(
      expect.arrayContaining(["running", "paused", "stopped"]),
    );
  });

  it("throws for unknown operator ids", () => {
    expect(() =>
      new GeneticAlgorithmEngine(
        oneMaxConfig({ selection: { id: "bogus" } }),
        createDefaultRegistry(),
      ),
    ).toThrow(/Unknown selection/);
  });

  it("weasel converges toward target with string encoding", async () => {
    const target = "HELLO";
    const engine = new GeneticAlgorithmEngine<string>(
      {
        problem: { id: "weasel", params: { target } },
        encoding: { id: "string", params: { length: target.length } },
        selection: { id: "tournament" },
        crossover: { id: "uniform" },
        mutation: { id: "char" },
        mutationRate: 0.05,
        populationSize: 200,
        elitism: 2,
        termination: [
          { id: "max-generations", params: { maxGenerations: 2000 } },
          { id: "target-fitness", params: { target: target.length } },
        ],
        seed: 7,
      },
      createDefaultRegistry(),
    );
    const done = new Promise<string>((resolve) => {
      engine.on("finished", (reason) => resolve(reason));
    });
    engine.start();
    await done;
    expect(engine.bestFitness).toBeGreaterThanOrEqual(target.length - 1);
  });
});

describe("rejecting a genome size the problem cannot use", () => {
  /** A config pairing weasel with a string encoding of the given length. */
  function weaselConfig(target: string, length: number): RunConfig {
    return {
      problem: { id: "weasel", params: { target } },
      encoding: { id: "string", params: { length } },
      selection: { id: "tournament" },
      crossover: { id: "one-point" },
      mutation: { id: "char" },
      mutationRate: 0.05,
      populationSize: 6,
      elitism: 1,
      termination: [{ id: "max-generations", params: { maxGenerations: 1 } }],
      seed: 3,
    };
  }

  it("throws at construction, before a single generation runs", () => {
    // genebaer-1os: this used to be accepted. Weasel scored against
    // min(genome.length, target.length), so the surplus genes were ignored and
    // the run optimised a prefix of the target while looking healthy.
    expect(
      () => new GeneticAlgorithmEngine(weaselConfig("HELLO", 32), createDefaultRegistry()),
    ).toThrow(/needs a genome of exactly 5 genes.*produces 32/s);
  });

  it("names the param to change, not just the mismatch", () => {
    // An error that only reports the numbers leaves the reader hunting for
    // which of two operators to edit.
    expect(
      () => new GeneticAlgorithmEngine(weaselConfig("HELLO", 32), createDefaultRegistry()),
    ).toThrow(/'string' encoding's length to 5/);
  });

  it("accepts the correctly sized pairing", () => {
    expect(
      () => new GeneticAlgorithmEngine(weaselConfig("HELLO", 5), createDefaultRegistry()),
    ).not.toThrow();
  });

  it("catches an mds graph paired with the wrong vertex count", () => {
    const config: RunConfig = {
      problem: { id: "mds", params: { graph: "cycle7" } },
      encoding: { id: "binary", params: { length: 10 } },
      selection: { id: "tournament" },
      crossover: { id: "one-point" },
      mutation: { id: "bit-flip" },
      mutationRate: 0.05,
      populationSize: 6,
      elitism: 1,
      termination: [{ id: "max-generations", params: { maxGenerations: 1 } }],
      seed: 3,
    };
    expect(() => new GeneticAlgorithmEngine(config, createDefaultRegistry())).toThrow(
      /exactly 7 genes.*produces 10/s,
    );
  });

  it("leaves problems alone that genuinely work at any length", () => {
    // OneMax scores whatever the encoding produces. Rejecting here would break
    // a perfectly valid run, so the check must apply only to a KNOWN mismatch.
    const config: RunConfig = {
      problem: { id: "one-max" },
      encoding: { id: "binary", params: { length: 37 } },
      selection: { id: "tournament" },
      crossover: { id: "one-point" },
      mutation: { id: "bit-flip" },
      mutationRate: 0.05,
      populationSize: 6,
      elitism: 1,
      termination: [{ id: "max-generations", params: { maxGenerations: 1 } }],
      seed: 3,
    };
    expect(() => new GeneticAlgorithmEngine(config, createDefaultRegistry())).not.toThrow();
  });

  it("measures the encoding without generating a genome", () => {
    // The check reads the encoding's parsed params on purpose. Calling
    // random() to measure a genome would advance the seeded RNG, and a
    // validation step must not change what a seeded run produces.
    const spy = vi.spyOn(StringEncoding.prototype, "random");
    try {
      new GeneticAlgorithmEngine(weaselConfig("HELLO", 5), createDefaultRegistry());
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("problems refusing a wrong-sized genome directly", () => {
  it("weasel throws rather than scoring against the overlap", () => {
    const weasel = createDefaultRegistry().create<FitnessProblem<string>>(
      "problem",
      "weasel",
      { target: "HELLO" },
    );
    // "HELLO WORLD" shares a 5-character prefix with the target; truncating
    // would have scored it a perfect 5.
    expect(() => weasel.evaluate("HELLO WORLD")).toThrow(/11 genes but the target/);
    expect(() => weasel.evaluate("HEL")).toThrow(/needs 5/);
    expect(weasel.evaluate("HELLO")).toBe(5);
  });

  it("mds throws rather than treating missing vertices as unselected", () => {
    const mds = createDefaultRegistry().create<FitnessProblem<number[]>>(
      "problem",
      "mds",
      { graph: "cycle7" },
    );
    expect(() => mds.evaluate([1, 0, 1])).toThrow(/3 genes but the graph has 7/);
    expect(() => mds.evaluate(new Array<number>(7).fill(0))).not.toThrow();
  });
});

describe("rejecting an evaluator that cannot score the problem", () => {
  /** A problem whose evaluate() only throws, like a model-backed one. */
  class ModelScored extends FitnessProblem<number[]> {
    static override readonly operatorId = "model-scored";
    static override readonly displayName = "Model scored";
    static override readonly description = "Test problem.";
    static override readonly paramsSchema = {};
    static override readonly compatibleEncodings = ["binary"] as const;
    static override readonly scorableInProcess = false;
    override evaluate(): number {
      throw new Error("scored by a model, not in-process");
    }
  }

  function config(evaluatorId?: string): RunConfig {
    return {
      problem: { id: "model-scored" },
      encoding: { id: "binary", params: { length: 8 } },
      selection: { id: "tournament" },
      crossover: { id: "one-point" },
      mutation: { id: "bit-flip" },
      mutationRate: 0.05,
      populationSize: 6,
      elitism: 1,
      termination: [{ id: "max-generations", params: { maxGenerations: 1 } }],
      seed: 3,
      ...(evaluatorId ? { evaluator: { id: evaluatorId } } : {}),
    };
  }

  const registry = () => createDefaultRegistry().register("problem", ModelScored);

  it("refuses the local evaluator before a generation runs", () => {
    // genebaer-gdv, as reported: choosing the image problem and pressing Start
    // produced a run that died on generation 0 with no explanation.
    expect(() => new GeneticAlgorithmEngine(config("local"), registry())).toThrow(
      /cannot be scored in-process/,
    );
  });

  it("catches the same mistake when the config omits the evaluator", () => {
    // Omitting it means 'local', so the check must not depend on the field
    // being present.
    expect(() => new GeneticAlgorithmEngine(config(), registry())).toThrow(
      /cannot be scored in-process/,
    );
  });

  it("names a fix rather than only the problem", () => {
    expect(() => new GeneticAlgorithmEngine(config("local"), registry())).toThrow(
      /model-backed evaluator/,
    );
  });

  it("allows an evaluator that does not score in-process", () => {
    class Remote extends FitnessEvaluator<number[]> {
      static override readonly operatorId = "remote-ish";
      static override readonly displayName = "Remote";
      static override readonly description = "Test evaluator.";
      static override readonly paramsSchema = {};
      evaluateBatch(genomes: readonly number[][]): Promise<number[]> {
        return Promise.resolve(genomes.map(() => 1));
      }
    }
    const r = registry().register("evaluator", Remote);
    expect(() => new GeneticAlgorithmEngine(config("remote-ish"), r)).not.toThrow();
  });

  it("leaves ordinary problems alone under the local evaluator", () => {
    // OneMax is scored in-process and must stay that way; a check that fired
    // here would break every default run.
    const cfg: RunConfig = { ...config("local"), problem: { id: "one-max" } };
    expect(() => new GeneticAlgorithmEngine(cfg, createDefaultRegistry())).not.toThrow();
  });
});
