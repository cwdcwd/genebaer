// genebaer-kz9: does CLIP provide a climbable gradient?
// GA vs random search, equal evaluation budget, REAL CLIP inference.
import { scoreImageAgainstPrompt } from "../packages/server/src/eval/clip-backend.mjs";
import { createDefaultRegistry, GeneticAlgorithmEngine, SeededRandomSource, FitnessProblem, FitnessEvaluator }
  from "../packages/core/dist/index.js";

const W = 32, H = 32, BITS = W * H * 24;
const BUDGET = Number(process.env.BUDGET ?? 6000);
const PROMPT = process.env.PROMPT ?? "a solid red image";

function bitsToRgb(g) {
  const out = new Array(W * H * 3);
  for (let i = 0; i < out.length; i++) {
    let v = 0; const base = i * 8;
    for (let b = 0; b < 8; b++) v = (v << 1) | (g[base + b] ? 1 : 0);
    out[i] = v;
  }
  return out;
}
let calls = 0;
async function clip(genome) {
  calls++;
  return scoreImageAgainstPrompt({ width: W, height: H, rgb: bitsToRgb(genome) }, PROMPT);
}

class ImgProblem extends FitnessProblem {
  static operatorId = "kz9-image";
  static displayName = "kz9"; static description = "spike";
  static paramsSchema = {}; static compatibleEncodings = ["binary"];
  evaluate() { throw new Error("scored by evaluator"); }
}
class ClipEval extends FitnessEvaluator {
  static operatorId = "kz9-clip";
  static displayName = "kz9"; static description = "spike"; static paramsSchema = {};
  async evaluateBatch(genomes) {
    const out = [];
    for (const g of genomes) out.push(await clip(g));
    return out;
  }
}

async function randomSearch(seed) {
  const rng = new SeededRandomSource(seed);
  let best = -Infinity, first = null;
  for (let i = 0; i < BUDGET; i++) {
    const g = new Array(BITS);
    for (let j = 0; j < BITS; j++) g[j] = rng.next() < 0.5 ? 1 : 0;
    const f = await clip(g);
    if (first === null) first = f;
    if (f > best) best = f;
  }
  return { best, first };
}

async function evolve(rate, pop, seed) {
  const registry = createDefaultRegistry()
    .register("problem", ImgProblem).register("evaluator", ClipEval);
  const engine = new GeneticAlgorithmEngine({
    problem: { id: "kz9-image" },
    encoding: { id: "binary", params: { length: BITS } },
    selection: { id: "tournament", params: { k: 3 } },
    crossover: { id: "uniform" },
    mutation: { id: "bit-flip" },
    mutationRate: rate, populationSize: pop, elitism: 2,
    termination: [{ id: "max-generations", params: { maxGenerations: Math.floor(BUDGET / pop) } }],
    seed,
    evaluator: { id: "kz9-clip" },
  }, registry);
  const trace = [];
  engine.on("generation", (s) => trace.push(s.bestFitness));
  await new Promise((res, rej) => {
    engine.on("finished", () => res()); engine.on("error", rej); engine.start();
  });
  return { best: engine.bestFitness, trace };
}

console.log(`prompt: "${PROMPT}"  budget: ${BUDGET} evaluations each\n`);

calls = 0;
let t = Date.now();
const rs = await randomSearch(1);
console.log(`random search: best ${rs.best.toFixed(4)}  (a single random image scores ${rs.first.toFixed(4)})`);
console.log(`  ${calls} inferences in ${((Date.now()-t)/1000).toFixed(0)}s\n`);

calls = 0; t = Date.now();
const ga = await evolve(0.0005, 30, 1);
console.log(`GA rate=5e-4 pop=30: best ${ga.best.toFixed(4)}`);
console.log(`  ${calls} inferences in ${((Date.now()-t)/1000).toFixed(0)}s`);
const step = Math.max(1, Math.floor(ga.trace.length / 8));
console.log(`  trajectory: ${ga.trace.filter((_, i) => i % step === 0).map((v) => v.toFixed(4)).join(" -> ")}`);
console.log("");
const delta = ga.best - rs.best;
console.log(`GA - random = ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}   ${ga.best > rs.best ? "GA BEATS random" : "GA does NOT beat random"}`);
