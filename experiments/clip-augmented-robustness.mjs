// genebaer-6kh: does scoring under random augmentation blunt adversarial exploitation?
//
// The measured failure (genebaer-kz9) is that an unconstrained per-pixel search
// finds an image CLIP rates far above a real photograph of the subject. The
// claim under test: adversarial patterns depend on exact pixel alignment, so
// averaging CLIP similarity over N random crops/flips should collapse their
// score while leaving a genuinely recognisable image roughly intact.
//
// Run from packages/server so node resolves @huggingface/transformers:
//   cd packages/server && node ../../experiments/clip-augmented-robustness.mjs
// Optional: IMAGE=./cats.jpg to include a natural-photograph control.
import { scoreImageAgainstPrompt } from "../packages/server/src/eval/clip-backend.mjs";
import {
  createDefaultRegistry,
  GeneticAlgorithmEngine,
  FitnessProblem,
  FitnessEvaluator,
} from "../packages/core/dist/index.js";
import { renderPolygons, polygonGenomeLength } from "../packages/vision/dist/index.js";

const W = 32,
  H = 32,
  BITS = W * H * 24;
const BUDGET = Number(process.env.BUDGET ?? 3000);
const N_AUG = Number(process.env.N_AUG ?? 8);
const PROMPT = process.env.PROMPT ?? "a photograph of a cat";
const SEED = Number(process.env.SEED ?? 11);

function bitsToRgb(g) {
  const out = new Array(W * H * 3);
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    const base = i * 8;
    for (let b = 0; b < 8; b++) v = (v << 1) | (g[base + b] ? 1 : 0);
    out[i] = v;
  }
  return out;
}

const img = (rgb) => ({ width: W, height: H, rgb });
const score = (rgb, n) => scoreImageAgainstPrompt(img(rgb), PROMPT, n);

/** Evolve against `objectiveAug` views; returns the best genome's pixels. */
async function evolve({ objectiveAug, representation, seed = SEED }) {
  const polygons = 24;
  const length = representation === "bits" ? BITS : polygonGenomeLength(polygons);
  const toRgb =
    representation === "bits"
      ? bitsToRgb
      : (g) => [...renderPolygons(g, { width: W, height: H })];

  let calls = 0;
  class P extends FitnessProblem {
    static operatorId = "aug-image";
    static displayName = "6kh";
    static description = "spike";
    static paramsSchema = {};
    static compatibleEncodings = [representation === "bits" ? "binary" : "numeric"];
    evaluate() {
      throw new Error("scored by evaluator");
    }
  }
  class E extends FitnessEvaluator {
    static operatorId = "aug-clip";
    static displayName = "6kh";
    static description = "spike";
    static paramsSchema = {};
    async evaluateBatch(genomes) {
      const out = [];
      for (const g of genomes) {
        calls++;
        out.push(await score(toRgb(g), objectiveAug));
      }
      return out;
    }
  }

  const registry = createDefaultRegistry()
    .register("problem", P)
    .register("evaluator", E);
  const engine = new GeneticAlgorithmEngine(
    {
      problem: { id: "aug-image" },
      encoding:
        representation === "bits"
          ? { id: "binary", params: { length } }
          : { id: "numeric", params: { dimensions: length, min: 0, max: 1 } },
      selection: { id: "tournament", params: { k: 3 } },
      crossover: { id: "uniform" },
      mutation: representation === "bits" ? { id: "bit-flip" } : { id: "gaussian" },
      mutationRate: representation === "bits" ? 5e-4 : 0.05,
      populationSize: 30,
      elitism: 2,
      // Budget is in EVALUATIONS, so N=8 costs 8x the inference for the same
      // number of candidates seen. Comparing at equal candidates is the point.
      termination: [{ id: "max-generations", params: { maxGenerations: Math.floor(BUDGET / 30) } }],
      seed,
      evaluator: { id: "aug-clip" },
    },
    registry,
  );

  await new Promise((resolve, reject) => {
    engine.on("finished", resolve);
    engine.on("error", reject);
    engine.start();
  });
  return { rgb: toRgb(engine.bestGenome), calls, fitness: engine.bestFitness };
}

const row = (label, s1, sN) =>
  console.log(
    `${label.padEnd(46)} ${s1.toFixed(4).padStart(8)} ${sN.toFixed(4).padStart(10)}` +
      `  ${(sN - s1 >= 0 ? "+" : "") + (sN - s1).toFixed(4)}`,
  );

console.log(`prompt: "${PROMPT}"   budget: ${BUDGET} evals   N_AUG: ${N_AUG}   seed: ${SEED}\n`);
console.log(`${"".padEnd(46)} ${"N=1".padStart(8)} ${`N=${N_AUG}`.padStart(10)}   delta`);

// 1. The attack, reproduced: evolve against the UNAUGMENTED objective.
const attack = await evolve({ objectiveAug: 1, representation: "bits" });
row("bits GA, optimised at N=1 (the attack)", await score(attack.rgb, 1), await score(attack.rgb, N_AUG));

// 2. Controls that are not adversarial.
const noise = Array.from({ length: W * H * 3 }, (_, i) => (i * 97) % 256);
row("random noise", await score(noise, 1), await score(noise, N_AUG));
const flat = new Array(W * H * 3).fill(200);
row("flat grey", await score(flat, 1), await score(flat, N_AUG));

if (process.env.IMAGE) {
  // Resolve from packages/server, where the optional dependency is installed.
  // A bare specifier resolves relative to THIS file and fails no matter the cwd.
  const { createRequire } = await import("node:module");
  const req = createRequire(new URL("../packages/server/package.json", import.meta.url));
  const { RawImage } = await import(req.resolve("@huggingface/transformers"));
  // resize() is async in transformers.js v3+; rgb() drops any alpha channel.
  const loaded = await RawImage.fromURL(process.env.IMAGE);
  const photo = (await (await loaded.resize(W, H)).rgb());
  row("real photograph, resized to 32x32", await score([...photo.data], 1), await score([...photo.data], N_AUG));
}

// 3. Does optimising the augmented objective directly still find an exploit?
const defended = await evolve({ objectiveAug: N_AUG, representation: "bits" });
row(`bits GA, optimised at N=${N_AUG}`, await score(defended.rgb, 1), await score(defended.rgb, N_AUG));

// 4. Both levers together: constrained representation AND augmented objective.
const both = await evolve({ objectiveAug: N_AUG, representation: "polygons" });
row(`polygon GA, optimised at N=${N_AUG}`, await score(both.rgb, 1), await score(both.rgb, N_AUG));

const polyPlain = await evolve({ objectiveAug: 1, representation: "polygons" });
row("polygon GA, optimised at N=1", await score(polyPlain.rgb, 1), await score(polyPlain.rgb, N_AUG));

console.log(
  `\ninference calls: attack=${attack.calls} defended=${defended.calls} ` +
    `(the N=${N_AUG} runs each cost ${N_AUG}x that in image embeddings)`,
);
