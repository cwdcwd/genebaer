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

export const DIVERSITY_MAX_SAMPLE = 50;
export const DIVERSITY_MIN_SAMPLE = 5;

/**
 * How many individuals to compare for the diversity statistic.
 *
 * Cost is O(pairs x genomeLength) and pairs grows quadratically, so a fixed
 * sample makes the statistic explode as genomes grow: at 50 individuals and a
 * 98,304-bit image genome it is ~120 million element comparisons EVERY
 * generation. Diversity is diagnostic, not part of selection, so it must never
 * dominate the loop it describes.
 *
 * Solves pairs(k) * genomeLength <= budget for k, where pairs(k) = k(k-1)/2,
 * then clamps. Exported as a pure function so the policy can be asserted
 * directly rather than inferred from a wall-clock measurement.
 */
export function diversitySampleSize(
  populationSize: number,
  genomeLength: number,
  budget: number,
): number {
  const affordablePairs = budget / Math.max(1, genomeLength);
  // k(k-1)/2 <= pairs  =>  k <= (1 + sqrt(1 + 8*pairs)) / 2
  const k = Math.floor((1 + Math.sqrt(1 + 8 * affordablePairs)) / 2);
  return Math.max(
    DIVERSITY_MIN_SAMPLE,
    Math.min(DIVERSITY_MAX_SAMPLE, Math.min(populationSize, k)),
  );
}

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
  /**
   * Ceiling on element comparisons spent on the diversity statistic per
   * generation. Diversity is diagnostic, not part of selection, so it must
   * never dominate the loop it is describing.
   */
  private static readonly DIVERSITY_BUDGET = 2_000_000;

  readonly config: RunConfig;
  readonly rng: RandomSource;

  private readonly encoding: Encoding<G>;
  private readonly problem: FitnessProblem<G>;
  private readonly selection: SelectionOperator<G>;
  private readonly crossoverOp: CrossoverOperator<G>;
  private readonly mutationOp: MutationOperator<G>;
  private readonly termination: TerminationCondition[];

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

  /** Run exactly one generation while paused (or pending). */
  step(): void {
    if (this.statusValue === "finished" || this.statusValue === "stopped") return;
    if (this.statusValue === "running") return;
    if (this.generation === 0) this.initialize();
    this.setStatus("paused");
    this.runGeneration();
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
      try {
        this.runGeneration();
      } catch (err) {
        this.clearLoop();
        this.setStatus("error");
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (this.statusValue === "running") {
        this.loopHandle = setImmediate(tick);
      }
    };
    this.loopHandle = setImmediate(tick);
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

  private evaluatePopulation(): void {
    this.fitnesses = this.population.map((g) => this.problem.evaluate(g));
  }

  /**
   * Mean pairwise distance across a sample of the population.
   *
   * The sample size adapts to genome length, because the cost is
   * O(pairs x genomeLength) and pairs grows quadratically. At 50 individuals
   * that is 1,225 pairs; on a 98,304-bit image genome the exact metric would
   * be ~120 million element comparisons EVERY generation, dominating the loop
   * entirely — and having nothing to do with fitness.
   *
   * Capping total element comparisons keeps the cost flat as genomes grow.
   * Diversity was always an estimate over a shuffled sample; this makes the
   * sample smaller for large genomes rather than making the metric wrong.
   * Small genomes are unaffected and still use the full 50.
   */
  private computeDiversity(): number {
    const n = this.population.length;
    if (n < 2) return 0;

    const sampleSize = this.diversitySampleSize(n);
    if (sampleSize < 2) return 0;

    const sample = this.rng.shuffle([...this.population]).slice(0, sampleSize);
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

  /**
   * How many individuals to compare, given how big a genome is.
   *
   * Solves pairs(k) * genomeLength <= budget for k, where
   * pairs(k) = k(k-1)/2, then clamps to [MIN, MAX].
   */
  private diversitySampleSize(populationSize: number): number {
    const first = this.population[0];
    if (first === undefined) return Math.min(populationSize, DIVERSITY_MAX_SAMPLE);

    let genomeLength: number;
    try {
      genomeLength = Math.max(1, this.encoding.size(first));
    } catch {
      // An encoding that cannot size a genome gets the old behaviour rather
      // than a crash inside a statistic.
      return Math.min(populationSize, DIVERSITY_MAX_SAMPLE);
    }
    return diversitySampleSize(
      populationSize,
      genomeLength,
      GeneticAlgorithmEngine.DIVERSITY_BUDGET,
    );
  }

  private median(sorted: readonly number[]): number {
    const n = sorted.length;
    if (n === 0) return NaN;
    const mid = Math.floor(n / 2);
    return n % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }

  private runGeneration(): void {
    const t0 = performance.now();
    this.evaluatePopulation();

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
