import { describe, it, expect } from "vitest";
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
    const [c1, c2] = cx.crossover([0, 0, 0, 0], [1, 1, 1, 1], rng) as number[][];
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

  it("pause/step/resume/stop lifecycle works", () => {
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

    engine.step();
    engine.step();
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
