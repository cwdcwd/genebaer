/**
 * Seed the database with a few completed demo runs so the UI has content on
 * first boot. Usage: pnpm -F @genebaer/server seed
 */
import { createDefaultRegistry, GeneticAlgorithmEngine } from "@genebaer/core";
import type { GenerationStats, RunConfig } from "@genebaer/shared-types";
import { randomUUID } from "node:crypto";
import { RunStore } from "./db/run-store.js";

const DB_PATH = process.env.DB_PATH ?? "./data/genebaer.db";
const registry = createDefaultRegistry();

function runConfig(config: RunConfig): Promise<{ runId: string; finalBest: number; generations: number }> {
  return new Promise((resolve, reject) => {
    const runId = randomUUID();
    const engine = new GeneticAlgorithmEngine(config, registry);
    const store = new RunStore(DB_PATH);
    store.createRun(runId, config);

    const history: GenerationStats[] = [];
    engine.on("generation", (s) => history.push(s));
    engine.on("finished", (_reason, finalBest, generations) => {
      store.writeGenerations(runId, history);
      store.markFinished(runId, finalBest);
      store.close();
      resolve({ runId, finalBest, generations });
    });
    engine.on("error", (err) => {
      store.close();
      reject(err);
    });
    engine.start();
  });
}

const runs: Array<{ name: string; config: RunConfig }> = [
  {
    name: "OneMax 64-bit (tournament)",
    config: {
      problem: { id: "one-max" },
      encoding: { id: "binary", params: { length: 64 } },
      selection: { id: "tournament", params: { k: 3 } },
      crossover: { id: "uniform" },
      mutation: { id: "bit-flip" },
      mutationRate: 0.015,
      populationSize: 100,
      elitism: 2,
      termination: [
        { id: "max-generations", params: { maxGenerations: 500 } },
        { id: "target-fitness", params: { target: 64 } },
      ],
      seed: 1234,
    },
  },
  {
    name: "Weasel (uniform crossover)",
    config: {
      problem: { id: "weasel", params: { target: "METHINKS IT IS LIKE A WEASEL" } },
      encoding: { id: "string", params: { length: 28 } },
      selection: { id: "tournament" },
      crossover: { id: "uniform" },
      mutation: { id: "char" },
      mutationRate: 0.02,
      populationSize: 200,
      elitism: 2,
      termination: [
        { id: "max-generations", params: { maxGenerations: 2000 } },
        { id: "target-fitness", params: { target: 28 } },
      ],
      seed: 7,
    },
  },
  {
    name: "MDS Petersen",
    config: {
      problem: { id: "mds", params: { graph: "petersen" } },
      encoding: { id: "binary", params: { length: 10 } },
      selection: { id: "rank", params: { pressure: 1.7 } },
      crossover: { id: "one-point" },
      mutation: { id: "bit-flip" },
      mutationRate: 0.05,
      populationSize: 100,
      elitism: 1,
      termination: [
        { id: "max-generations", params: { maxGenerations: 300 } },
        { id: "target-fitness", params: { target: -3 } },
      ],
      seed: 99,
    },
  },
];

for (const { name, config } of runs) {
  const { runId, finalBest, generations } = await runConfig(config);
  console.log(`✓ ${name}  (id=${runId}, best=${finalBest}, gens=${generations})`);
}
console.log(`Seeded ${runs.length} runs into ${DB_PATH}`);
