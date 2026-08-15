import type {
  GenerationStats,
  RunConfig,
  RunStatus,
} from "@genebaer/shared-types";
import type { Encoding } from "./encoding.js";
import type { OperatorRegistry } from "./registry.js";
import { SeededRandomSource, type RandomSource } from "./random.js";
import type { FitnessProblem } from "./operators/problem/base.js";
import type { SelectionOperator } from "./operators/selection/base.js";
import type { CrossoverOperator } from "./operators/crossover/base.js";
import type { MutationOperator } from "./operators/mutation/base.js";
import type { TerminationCondition } from "./operators/termination/index.js";
import type { FitnessEvaluator } from "./operators/evaluator/base.js";

export interface EngineEvents<G = unknown> {
  generation: (stats: GenerationStats) => void;
  best: (generation: number, genome: G, fitness: number) => void;
  finished: (reason: string, finalBestFitness: number, generations: number) => void;
  status: (status: RunStatus) => void;
  error: (err: Error) => void;
}

/**
 * The genetic algorithm engine. Construct with a declarative RunConfig +
 * registry; drive with start/pause/resume/step/stop; observe via `on`.
 *
 * Encoding-agnostic: all genome knowledge lives in the operators/encoding,
 * resolved by registry id from the config.
 */
export class GeneticAlgorithmEngine<G = unknown> {
  readonly config: RunConfig;
  readonly rng: RandomSource;

  private readonly encoding: Encoding<G>;
  private readonly problem: FitnessProblem<G>;
  private readonly evaluator: FitnessEvaluator<G>;
  private readonly selection: SelectionOperator<G>;
  private readonly crossoverOp: CrossoverOperator<G>;
  private readonly mutationOp: MutationOperator<G>;
  private readonly termination: TerminationCondition[];

  /** Guards against two generations being evaluated concurrently. */
  private evaluating = false;

  private population: G[] = [];
  private fitnesses: number[] = [];
  private history: GenerationStats[] = [];
  private generation = 0;
  private statusValue: RunStatus = "pending";
  private stopRequested = false;
  private loopHandle: ReturnType<typeof setImmediate> | null = null;

  private readonly listeners: {
    [K in keyof EngineEvents<G>]: Set<EngineEvents<G>[K]>;
  } = {
    generation: new Set(),
    best: new Set(),
    finished: new Set(),
    status: new Set(),
    error: new Set(),
  };

  constructor(
    config: RunConfig,
    registry: OperatorRegistry,
    rng?: RandomSource,
  ) {
    this.config = config;
    this.rng = rng ?? new SeededRandomSource(config.seed);

    this.encoding = registry.create<Encoding<G>>(
      "encoding",
      config.encoding.id,
      config.encoding.params,
    );
    this.problem = registry.create<FitnessProblem<G>>(
      "problem",
      config.problem.id,
      config.problem.params,
    );
    // Optional by design: a config written before evaluators existed, or one
    // that simply does not care, scores in-process exactly as it always did.
    this.evaluator = registry.create<FitnessEvaluator<G>>(
      "evaluator",
      config.evaluator?.id ?? "local",
      config.evaluator?.params,
    );
    this.selection = registry.create<SelectionOperator<G>>(
      "selection",
      config.selection.id,
      config.selection.params,
    );
    this.crossoverOp = registry.create<CrossoverOperator<G>>(
      "crossover",
      config.crossover.id,
      config.crossover.params,
    );
    this.mutationOp = registry.create<MutationOperator<G>>(
      "mutation",
      config.mutation.id,
      config.mutation.params,
    );
    this.termination = config.termination.map((t) =>
      registry.create<TerminationCondition>("termination", t.id, t.params),
    );

    if (config.populationSize < 2) {
      throw new RangeError("populationSize must be ≥ 2");
    }
    if (config.elitism < 0 || config.elitism >= config.populationSize) {
      throw new RangeError("elitism must be in [0, populationSize)");
    }
  }

  // ---------- events ----------

  on<K extends keyof EngineEvents<G>>(
    event: K,
    cb: EngineEvents<G>[K],
  ): () => void {
    this.listeners[event].add(cb);
    return () => this.listeners[event].delete(cb);
  }

  private emit<K extends keyof EngineEvents<G>>(
    event: K,
    ...args: Parameters<EngineEvents<G>[K]>
  ): void {
    for (const cb of this.listeners[event]) {
      (cb as (...a: unknown[]) => void)(...args);
    }
  }

  // ---------- introspection ----------

  get status(): RunStatus {
    return this.statusValue;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get statsHistory(): readonly GenerationStats[] {
    return this.history;
  }

  get bestGenome(): G | null {
    if (this.population.length === 0) return null;
    const g = this.population[this.argBest()];
    return g === undefined ? null : g;
  }

  get bestFitness(): number | null {
    if (this.fitnesses.length === 0) return null;
    const f = this.fitnesses[this.argBest()];
    return f === undefined ? null : f;
  }

  /** Current-best payload for the frontend canvas (null if unsupported). */
  visualFrame(): { problemId: string; data: unknown } | null {
    const best = this.bestGenome;
    if (best === null) return null;
    return this.problem.visualize(best);
  }

  // ---------- control ----------

  start(): void {
    if (this.statusValue === "running") return;
    if (this.statusValue === "finished" || this.statusValue === "stopped") {
      throw new Error(`Cannot start a ${this.statusValue} run`);
    }
    if (this.generation === 0) this.initialize();
    this.setStatus("running");
    this.scheduleLoop();
  }

  pause(): void {
    if (this.statusValue !== "running") return;
    this.clearLoop();
    this.setStatus("paused");
  }

  resume(): void {
    if (this.statusValue !== "paused") return;
    this.setStatus("running");
    this.scheduleLoop();
  }

  /**
   * Run exactly one generation while paused (or pending).
   *
   * Returns a promise because evaluation may be asynchronous. Callers that
   * only want to trigger a step can ignore it; callers that need to observe
   * the result — tests especially — must await it.
   */
  async step(): Promise<void> {
    if (this.statusValue === "finished" || this.statusValue === "stopped") return;
    if (this.statusValue === "running") return;
    // A step while a generation is already in flight would evaluate a
    // population that is about to be replaced.
    if (this.evaluating) return;
    if (this.generation === 0) this.initialize();
    this.setStatus("paused");
    try {
      await this.runGeneration();
    } catch (err) {
      this.fail(err);
    }
  }

  stop(): void {
    this.clearLoop();
    this.stopRequested = true;
    if (this.statusValue !== "finished") {
      this.setStatus("stopped");
      const best = this.bestFitness ?? Number.NEGATIVE_INFINITY;
      this.emit("finished", "Stopped by user", best, this.generation);
    }
  }

  private setStatus(s: RunStatus): void {
    if (this.statusValue === s) return;
    this.statusValue = s;
    this.emit("status", s);
  }

  // ---------- internals ----------

  private initialize(): void {
    this.population = [];
    for (let i = 0; i < this.config.populationSize; i++) {
      this.population.push(this.encoding.random(this.rng));
    }
  }

  private scheduleLoop(): void {
    this.clearLoop();
    const tick = (): void => {
      if (this.statusValue !== "running") return;
      // The next tick is scheduled only after this generation settles, so a
      // slow evaluator throttles the loop naturally instead of piling up
      // overlapping generations.
      void this.runGeneration().then(
        () => {
          if (this.statusValue === "running") {
            this.loopHandle = setImmediate(tick);
          }
        },
        (err: unknown) => this.fail(err),
      );
    };
    this.loopHandle = setImmediate(tick);
  }

  /** Terminal failure path: stop the loop and report, never retry silently. */
  private fail(err: unknown): void {
    this.clearLoop();
    this.setStatus("error");
    this.emit("error", err instanceof Error ? err : new Error(String(err)));
  }

  private clearLoop(): void {
    if (this.loopHandle !== null) {
      clearImmediate(this.loopHandle);
      this.loopHandle = null;
    }
  }

  private argBest(): number {
    let best = 0;
    let bestFit = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.fitnesses.length; i++) {
      const f = this.fitnesses[i] as number;
      if (f > bestFit) {
        bestFit = f;
        best = i;
      }
    }
    return best;
  }

  /**
   * Score the current population through the configured evaluator.
   *
   * Returns the scores rather than assigning them, so the caller can discard
   * a result that arrived after the run ended without having already mutated
   * engine state.
   */
  private async evaluatePopulation(): Promise<number[]> {
    const scores = await this.evaluator.evaluateBatch(this.population, {
      problem: this.problem,
      generation: this.generation,
    });
    if (scores.length !== this.population.length) {
      throw new Error(
        `Evaluator '${this.config.evaluator?.id ?? "local"}' ` +
          `returned ${scores.length} scores for ${this.population.length} genomes. ` +
          `Fitness is assigned positionally, so a length mismatch would silently ` +
          `pair genomes with the wrong scores.`,
      );
    }
    return scores;
  }

  private computeDiversity(): number {
    const n = this.population.length;
    if (n < 2) return 0;
    // Sample up to 50 individuals for pairwise mean — O(50²) instead of O(n²).
    const sample = this.rng.shuffle([...this.population]).slice(0, 50);
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < sample.length; i++) {
      for (let j = i + 1; j < sample.length; j++) {
        sum += this.encoding.distance(sample[i] as G, sample[j] as G);
        pairs++;
      }
    }
    return pairs === 0 ? 0 : sum / pairs;
  }

  private median(sorted: readonly number[]): number {
    const n = sorted.length;
    if (n === 0) return NaN;
    const mid = Math.floor(n / 2);
    return n % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }

  private async runGeneration(): Promise<void> {
    const t0 = performance.now();
    this.evaluating = true;
    let scores: number[];
    try {
      scores = await this.evaluatePopulation();
    } finally {
      this.evaluating = false;
    }

    // Evaluation can take arbitrarily long once it leaves this process, so the
    // run may be over by the time scores arrive. Discard them rather than
    // resurrecting a stopped run or emitting a generation after 'finished'.
    if (
      this.statusValue === "stopped" ||
      this.statusValue === "finished" ||
      this.statusValue === "error"
    ) {
      return;
    }
    this.fitnesses = scores;

    const sorted = [...this.fitnesses].sort((a, b) => a - b);
    const best = sorted[sorted.length - 1] as number;
    const worst = sorted[0] as number;
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const median = this.median(sorted);
    const variance =
      sorted.reduce((a, b) => a + (b - mean) * (b - mean), 0) / sorted.length;

    const bestIdx = this.argBest();
    const bestGenome = this.encoding.clone(this.population[bestIdx] as G);

    const stats: GenerationStats = {
      generation: this.generation,
      bestFitness: best,
      meanFitness: mean,
      medianFitness: median,
      worstFitness: worst,
      stdDev: Math.sqrt(variance),
      diversity: this.computeDiversity(),
      bestGenome,
      elapsedMs: performance.now() - t0,
    };
    this.history.push(stats);
    this.emit("generation", stats);
    this.emit("best", this.generation, bestGenome, best);

    // Termination checked against history INCLUDING this generation.
    for (const cond of this.termination) {
      const reason = cond.check(this.history);
      if (reason !== null) {
        this.clearLoop();
        this.setStatus("finished");
        this.emit("finished", reason, best, this.generation);
        return;
      }
    }
    if (this.stopRequested) return;

    // --- produce next generation ---
    const eliteCount = this.config.elitism;
    const order = Array.from({ length: this.population.length }, (_, i) => i).sort(
      (a, b) => (this.fitnesses[b] as number) - (this.fitnesses[a] as number),
    );
    const next: G[] = [];
    for (let i = 0; i < eliteCount; i++) {
      next.push(this.encoding.clone(this.population[order[i] as number] as G));
    }

    const needed = this.config.populationSize - eliteCount;
    const parents = this.selection.select(
      this.population,
      this.fitnesses,
      needed % 2 === 0 ? needed : needed + 1,
      this.rng,
    );

    let produced = 0;
    for (let i = 0; i + 1 < parents.length && produced < needed; i += 2) {
      const a = this.encoding.clone(parents[i] as G);
      const b = this.encoding.clone(parents[i + 1] as G);
      const [c1, c2] = this.crossoverOp.crossover(a, b, this.rng);
      const m1 = this.mutationOp.mutate(c1, this.config.mutationRate, this.rng);
      const m2 = this.mutationOp.mutate(c2, this.config.mutationRate, this.rng);
      next.push(m1);
      produced++;
      if (produced < needed) {
        next.push(m2);
        produced++;
      }
    }

    this.population = next;
    this.generation++;
  }
}
