# Plan: genebaer — Extensible Genetic Algorithm Runner + Next.js Visualizer

_Created: 2026-08-12 · Status: Approved for implementation_

## TL;DR

Build a pnpm + Turborepo monorepo with three packages:

- `@genebaer/core` — framework-agnostic GA engine. Every GA aspect (encoding, selection, crossover, mutation, fitness problem, termination) is an abstract base + concrete implementations registered in a central **operator registry** keyed by string. The engine resolves a declarative JSON `RunConfig` through the registry at run start.
- `@genebaer/server` — Fastify + WebSocket server hosting the engine in-process with pause/resume/step/stop, streaming `GenerationStats` over WS, and persisting per-generation stats + best genome per generation to SQLite (macOS guardrails: `journal_mode = MEMORY`, `locking_mode = EXCLUSIVE`).
- `apps/web` — Next.js App Router + React 19 + shadcn/ui + Tailwind frontend: live run view (Recharts fitness/diversity curves streaming over WS), parameter experiment UI (compose operators from registry metadata into a RunConfig, save presets), run history + comparison (overlay curves from past runs), and per-problem canvas visualizers.

Encodings in v1: Binary, NumericVector, String. Demo problems: OneMax (binary), Rastrigin + Sphere (numeric), Weasel target string (string), Minimum Dominating Set (binary over graph vertices, custom canvas visual).

---

## Monorepo layout

```
genebaer/
├── package.json            # root, pnpm workspaces, turborepo pipeline
├── turbo.json
├── tsconfig.base.json
├── packages/
│   ├── core/               # @genebaer/core — GA engine, zero I/O deps
│   ├── server/             # @genebaer/server — Fastify API + WS + SQLite
│   └── shared-types/       # @genebaer/shared-types — wire protocol + DTOs
└── apps/
    └── web/                # Next.js frontend
```

`shared-types` is consumed by server and web (workspace dep) so the wire protocol is compile-time checked end to end.

---

## Phase 1 — Scaffold (step 1)

1. Init root: pnpm-workspace.yaml, turbo.json (build/dev/lint/test pipeline), tsconfig.base.json (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), .gitignore, Prettier + ESLint flat config shared.
2. Create empty packages with package.json + tsconfig wiring; `pnpm i` to link workspaces.

_Verification: `pnpm build` runs turbo pipeline cleanly across all four projects._

## Phase 2 — `@genebaer/core` engine (steps 2–7, internal order matters; all after step 1)

Key abstractions (all in `packages/core/src/`):

2. **Genome & encodings** — `Genome<G>` type param; `Encoding<G>` abstract class: `random(rng): G`, `decode(g): unknown`, `size(g): number`, `distance(a, b): number` (for diversity metric), plus `encodingId`. Implement: `BinaryEncoding(length)`, `NumericVectorEncoding(dimensions, bounds)`, `StringEncoding(alphabet, length)`.

3. **Operator interfaces** — abstract bases, each with a `static readonly operatorId: string`, `paramsSchema` (JSON Schema for UI auto-render), and `validateConfig()`:
   - `SelectionOperator<G>` → `select(population, fitnesses, rng): G[]`
   - `CrossoverOperator<G>` → `crossover(a, b, rng): [G, G]`
   - `MutationOperator<G>` → `mutate(g, rng, rate): G`
   - `FitnessProblem<G>` → `evaluate(g): number` + `problemId` + optional `visualize(best: G): VisualFrame` hook for the frontend canvas
   - `TerminationCondition` → `shouldStop(stats: GenerationStats[]): boolean` (maxGenerations, targetFitness, stagnation)

   Concrete v1 operators:
   - Selection: `TournamentSelection`, `RouletteWheelSelection`, `RankSelection`, `ElitismSelection`
   - Crossover: `OnePointCrossover`, `TwoPointCrossover`, `UniformCrossover`, `ArithmeticCrossover` (numeric), `OrderedCrossover` (future permutation, stub ok)
   - Mutation: `BitFlipMutation`, `GaussianMutation` (numeric), `SwapMutation`, `CharMutation` (string)

4. **Registry** — `OperatorRegistry` class: `register(kind, operatorClass)`, `resolve(kind, id): OperatorClass`, `listMetadata(): OperatorMeta[]` (id, kind, displayName, description, paramsSchema, compatibleEncodings). A `createDefaultRegistry()` wires all built-ins. Engine takes a registry in its constructor so users can inject a custom one.

5. **RNG** — `RandomSource` interface (`next(): number`, `int(min,max)`, `pick`, `shuffle`) + `SeededRandomSource` (mulberry32-based, serializable seed for reproducibility). Record seed in RunConfig; same seed + config ⇒ identical run.

6. **Engine** — `GeneticAlgorithmEngine`:
   - constructor(config: `RunConfig`, registry, rng?): resolves operators from config via registry; throws on unknown ids
   - `RunConfig` (shared-types): `{ problem: {id, params}, encoding: {id, params}, selection: {id, params}, crossover: {id, params}, mutation: {id, params, rate}, populationSize, elitism, termination: [{id, params}...], seed }`
   - event emitter interface (tiny, zero-dep): `on('generation', cb)`, `on('finished', cb)`, `on('best', cb)`
   - control: `start()`, `pause()`, `resume()`, `step()`, `stop()`; internal loop uses setImmediate/microtask yield to avoid blocking the event loop
   - per generation: evaluate → termination check → selection → crossover → mutation → elitism carryover → emit `GenerationStats { generation, best, mean, median, worst, stdDev, diversity, bestGenome, elapsedMs }`

7. **Demo problems** (`packages/core/src/problems/`): `OneMax`, `Sphere`, `Rastrigin`, `Weasel`, `MinimumDominatingSet(graph: {nodes, edges} param — MDS encoding = binary genome where 1 = vertex in set; fitness penalizes non-domination + set size; ships with 2 sample graphs). Each problem declares `compatibleEncodings` and a `visualize` payload (e.g. Weasel → current best string; MDS → graph + selected vertices; Rastrigin → best vector coords).

_Verification: `pnpm test` in core — vitest unit tests per operator (statistical sanity), registry resolution, full engine run on OneMax with fixed seed asserts convergence < 200 generations and reproducibility (two same-seed runs produce identical best genome sequences)._

## Phase 3 — `@genebaer/server` (steps 8–10; depends on Phase 2)

8. **Fastify app** (`packages/server/src/index.ts`): `@fastify/websocket`, `@fastify/cors`.
   REST: `GET /api/operators` (registry metadata for UI), `GET /api/problems` (with default params), `POST /api/runs` (body = RunConfig → creates run, returns runId), `GET /api/runs` (history list), `GET /api/runs/:id` (detail + full generation stats), `POST /api/runs/:id/control` (`{action: pause|resume|step|stop}`), `DELETE /api/runs/:id`.
9. **RunManager**: map runId → engine instance + status; wires engine events to (a) WS broadcast and (b) persistence writer. Multiple concurrent runs allowed (in-process, cooperative).
10. **Persistence** — better-sqlite3, `packages/server/src/db/`:
    - Schema: `runs(id, config_json, status, created_at, finished_at, final_best_fitness)`, `generations(run_id, generation, best, mean, median, worst, std_dev, diversity, best_genome_json, elapsed_ms, PRIMARY KEY(run_id, generation))`
    - `PRAGMA journal_mode = MEMORY` + `PRAGMA locking_mode = EXCLUSIVE`; write via prepared statements in a transaction per generation batch (buffer 10 gens or flush on pause/finish).
    - DB path configurable via env, default `./data/genebaer.db`.

_Verification: vitest integration test boots server on ephemeral port, POSTs a OneMax run, expects WS `generation` messages arriving in order, control actions honored, and rows in SQLite; manual smoke via curl/wscat commands listed in README._

## Phase 4 — `apps/web` (steps 11–15; depends on Phase 3 API/WS contract; styling sub-steps parallelizable)

11. **Scaffold**: Next.js App Router, Tailwind v4, shadcn/ui init; env `NEXT_PUBLIC_API_URL` + WS URL; typed API client (`apps/web/src/lib/api.ts`) + WS hook (`useRunStream(runId)`) built on shared-types.
12. **Experiment builder page** (`/experiments/new`): form auto-generated from `GET /api/operators` — pick problem (shows its params schema), encoding, selection/crossover/mutation operators with param forms rendered from `paramsSchema` (zod + react-hook-form + shadcn Form), population size, mutation rate, elitism, termination, seed. Save config as preset (localStorage + optional server persistence later). "Start run" → POST /api/runs → route to live view.
13. **Live run view** (`/runs/[id]`):
    - Recharts streaming line chart: best/mean/worst fitness vs generation (rolling window), second chart for diversity
    - Run control bar: pause/resume/step/stop buttons → REST control endpoint; status badge via WS
    - Canvas panel: per-problem visualizer component registry — `Visualizer` React component keyed by `problemId` (Weasel → monospace string diff; MDS → force-graph on `<canvas>` with highlighted dominant set; numeric problems → 2D contour/heat marker; OneMax → bit-row heat strip)
    - Best-genome inspector (JSON/structured view), generation stats table (virtualized)
14. **History + comparison** (`/runs`): table of past runs (config summary, status, final best, created date) from `GET /api/runs`; select N runs → `/compare?ids=` overlaid Recharts fitness curves + config diff table.
15. **Plugin API surface (code-level)**: document + example `examples/custom-problem/` showing how to subclass `FitnessProblem` + operators, register into a registry, and pass it to the server factory (`createServer({ registry })`) so the new problem appears in the UI automatically.

_Verification: `pnpm build` all; manual E2E checklist — run OneMax live (watch curve converge), pause/step/resume, run Weasel + MDS, reload page mid-run (state from REST), compare two runs with different selection operators._

## Phase 5 — Polish

16. Root README: architecture diagram, dev commands (`pnpm dev` turbo parallel), how to add an operator/problem, API + WS protocol reference.
17. Seed data script: pre-populates registry defaults + one sample completed run so UI isn't empty on first boot.

---

## Dependency versions (pin to known-good)

- pnpm 9+, turbo 2.x, Node 20+
- core: zero runtime deps; dev: vitest, typescript 5.x
- server: fastify 5, @fastify/websocket, @fastify/cors, better-sqlite3, zod; dev: vitest, tsx
- shared-types: typescript only
- web: next 15.x, react 19, tailwindcss 4, shadcn/ui (latest), recharts 2.x, zod, react-hook-form, @hookform/resolvers

## Explicit scope

**In:** everything above. **Out:** user auth, multi-user, cloud deploy config, WebSocket auth, operator hot-reload without server restart, GPU/parallel fitness evaluation (evaluation is synchronous), permutation/TSP (registry supports it; not implemented v1), runtime user-defined JS fitness strings (security risk), i18n, mobile-specific layouts.

## Decisions locked

- Monorepo pnpm + Turborepo; separate Node API server + WS; in-process pausable runs; registry-pattern extensibility (code-level plugins, no file-drop loading in v1); persist per-generation stats + best genome; encodings: binary/numeric/string; demos: OneMax, Sphere, Rastrigin, Weasel, Min Dominating Set.

## Key risks / watch items

1. **better-sqlite3 native build** on macOS — prebuilds exist for Node 20 LTS; fallback `pnpm rebuild better-sqlite3`.
2. **WS message volume** at high pop sizes / fast gens — throttle to ≤10 msgs/s per run client-side + server coalesces.
3. **paramsSchema ↔ zod drift** — generate zod schemas from JSON Schema (small util) so UI forms and server validation share one source.
4. **MDS fitness design** — needs penalty tuning (non-dominated vertices ≫ set size); unit-test with known graph optimum.
5. macOS SQLite journal guards applied even on local disk — cheap insurance.
