# genebaer Architecture

An extensible genetic algorithm runner with a live web visualizer.

This document has two halves. **[Repository Architecture](#part-1--repository-architecture)** covers how the monorepo is laid out, how it builds, and how work moves through it. **[Code Architecture](#part-2--code-architecture)** covers how the GA engine is actually structured — the abstraction every feature hangs off, how a run executes, and how state reaches the browser.

Every claim here was verified against source at the time of writing. Where the code has a sharp edge, this document says so rather than describing the intent.

---

## Part 1 — Repository Architecture

### The four packages

A pnpm workspace driven by turbo. Node >= 20, pnpm 11.9.0.

| Package | Role | Ships to browser? |
| --- | --- | --- |
| `packages/shared-types` | The type contract. Pure declarations, zero runtime code. | Types only |
| `packages/core` | The GA engine and every operator. | **No** |
| `packages/server` | Fastify HTTP + WebSocket host, SQLite persistence. | No |
| `apps/web` | Next.js visualizer. | Yes |

### Dependency direction

```mermaid
graph TD
    ST["shared-types<br/><i>no dependencies</i>"]
    CORE["core<br/><i>the GA engine</i>"]
    SRV["server<br/><i>Fastify + SQLite</i>"]
    WEB["web<br/><i>Next.js</i>"]

    CORE --> ST
    SRV --> CORE
    SRV --> ST
    WEB --> ST

    style ST fill:#2d3748,stroke:#63b3ed,color:#fff
    style CORE fill:#2d3748,stroke:#68d391,color:#fff
    style SRV fill:#2d3748,stroke:#f6ad55,color:#fff
    style WEB fill:#2d3748,stroke:#fc8181,color:#fff
```

Two rules follow from this graph, and both are load-bearing:

**`web` does not depend on `core`.** It imports `@genebaer/shared-types` and nothing else from the workspace. The GA engine never enters the browser bundle — the browser only ever receives *data* about a run, never the machinery that produces it. Adding `@genebaer/core` to `apps/web/package.json` would silently pull the entire engine into the client bundle. Don't.

**`shared-types` depends on nothing.** It is the only package both halves of the system compile against, which is what makes it the wire contract. It deliberately contains no zod schemas — runtime validation lives in `server`, so the frontend bundle never carries duplicated validators. That choice is documented at the top of the file itself.

### Build pipeline

`turbo.json` defines five tasks:

| Task | Depends on | Notes |
| --- | --- | --- |
| `build` | `^build` | Outputs `dist/**`, `.next/**` |
| `test` | `^build` | Needs dependencies built first |
| `typecheck` | `^build` | Same |
| `lint` | — | No dependency; runs in parallel |
| `dev` | — | `cache: false`, `persistent: true` |

`^build` means "build all dependencies first," which is what forces the `shared-types → core → server` ordering. Turbo caches aggressively; a no-op run reports `FULL TURBO`.

### Quality gates

All four are real and cover all four packages. This matters more than usual here — see the loop protocol in `CLAUDE.md` — so the state of each is documented rather than assumed:

| Gate | Command | Coverage |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | 4 packages, `tsc --noEmit`, **including test files** |
| Test | `pnpm test` | 101 tests |
| Lint | `pnpm lint` | ESLint flat config, type-aware, `--max-warnings=0` |
| Build | `pnpm build` | `tsc -p tsconfig.build.json` + `next build` |

Turbo caches these. Note that `turbo.json` declares explicit `$TURBO_ROOT$`
inputs for the root-level configs — without them, editing `eslint.config.mjs` or
`tsconfig.base.json` does **not** invalidate the cache and a gate will replay a
stale green result. Add any new shared root config to the relevant task's inputs.

Testing runs in **two different modes**, which trips people up:

- `core`, `server`, `web` — ordinary vitest. `web` runs under jsdom with Testing Library.
- `shared-types` — **type-level only** (`*.test-d.ts` via `vitest run --typecheck`). The package emits no runtime code, so a runtime test there would assert nothing. These tests guard the wire contract that would otherwise break silently.

`apps/web/vitest.config.ts` deliberately omits `@vitejs/plugin-react`; its Vite-internal imports don't match the Vite that vitest resolves. esbuild's `jsx: "automatic"` covers what the tests need.

### TypeScript configuration

Each package carries **two** configs, and the split is deliberate:

- `tsconfig.json` — **includes test files.** This is what `pnpm typecheck`, the
  IDE, and typescript-eslint's project service resolve, so tests are type-checked
  and type-aware lint rules apply to them.
- `tsconfig.build.json` (`core`, `server`) — extends the above and excludes
  `src/**/*.test.ts`, so tests are never emitted into `dist`.

Getting this backwards is how test files end up unchecked: if `tsconfig.json`
excludes them, they vanish from `typecheck` *and* from the lint project service
at the same time, and nothing reports a gap.

`tsconfig.base.json` is strict in ways that shape the code you'll write:

- `exactOptionalPropertyTypes` — `foo?: string` and `foo: string | undefined` are different types
- `noUncheckedIndexedAccess` — `arr[i]` is `T | undefined`, which is why the engine is full of `as G` and `!` assertions after bounds-checked loops
- `verbatimModuleSyntax` — type-only imports must say `import type`
- `module: NodeNext` — **relative imports need the `.js` extension**, even in `.ts` source

### Issue tracking

Work is tracked in **beads** (`bd`), not markdown TODOs. Issues live in a local Dolt DB; `.beads/issues.jsonl` is a passive export that *is* committed — and this repo is public, so issue bodies are world-readable.

The repo opts into the **team-maintainer** agent profile: agents run the full implement→validate→publish cycle autonomously, one bead per branch (`bead/<id>`), and open a PR. Humans merge. The full protocol, including the `bd export` race that will bite you if you skip it, is in `CLAUDE.md` and `AGENTS.md`.

---

## Part 2 — Code Architecture

### The one abstraction that matters

Everything extensible in genebaer is a `BaseOperator` subclass registered in an `OperatorRegistry` under a `(kind, id)` pair.

```typescript
abstract class BaseOperator {
  static readonly operatorId: string;      // registry id, e.g. "tournament"
  static readonly displayName: string;     // shown in the UI
  static readonly description: string;     // shown in the UI
  static readonly paramsSchema: Record<string, JSONSchema>;  // drives the form

  readonly params: Record<string, unknown>;
  constructor(params: Record<string, unknown> = {}) { ... }
}
```

The static metadata is the whole trick. `paramsSchema` is served to the browser via `GET /api/operators`, and `apps/web` **auto-generates the configuration form from it** (`components/param-fields.tsx`). Declaring a param schema on a new operator is sufficient to make it configurable in the UI — there is no second place to register a form field.

### The six operator kinds

```mermaid
graph LR
    BO["BaseOperator"]
    BO --> ENC["Encoding&lt;G&gt;"]
    BO --> PROB["FitnessProblem&lt;G&gt;"]
    BO --> SEL["SelectionOperator&lt;G&gt;"]
    BO --> CX["CrossoverOperator&lt;G&gt;"]
    BO --> MUT["MutationOperator&lt;G&gt;"]
    BO --> TERM["TerminationCondition"]

    style BO fill:#2d3748,stroke:#63b3ed,color:#fff
```

| Kind | Contract | Built-ins |
| --- | --- | --- |
| `encoding` | `random`, `distance`, `size`, `clone`, `equals` | binary, numeric, string |
| `problem` | `evaluate(genome) → number`, optional `visualize` | one-max, sphere, rastrigin, weasel, mds |
| `selection` | `select(pop, fitnesses, count, rng) → G[]` | tournament, roulette, rank, elitism |
| `crossover` | `crossover(a, b, rng) → [G, G]` | one-point, two-point, uniform, arithmetic |
| `mutation` | `mutate(genome, rate, rng) → G` | bitflip, gaussian, swap, char |
| `termination` | `check(history) → string \| null` | max-generations, target-fitness, stagnation |

**Fitness is always maximized.** Higher is better, everywhere. A minimization problem must negate inside `evaluate`.

**`Encoding<G>` is the type anchor.** It defines what a genome *is* for a run; every other operator is generic over the same `G`. Compatibility is advertised via a static `compatibleEncodings` array, which the registry surfaces as metadata and the UI uses to filter incompatible choices out of the form.

**`TerminationCondition` returns a reason string, not a boolean.** Returning `null` continues; returning a string stops the run and that string becomes the user-visible reason. Any single condition firing ends the run.

### Registry

`OperatorRegistry` maps `(kind, id) → constructor`.

- `register()` **throws on duplicate ids** within a kind — collisions fail loudly at startup, not silently at resolve time
- `resolve()` throws `Unknown ${kind} operator id '${id}'` for anything unregistered
- `listMetadata()` produces the `OperatorMeta[]` the UI consumes
- `clone()` returns an extensible copy — the way to add operators without mutating the default set

`createDefaultRegistry()` in `defaults.ts` is the single place every built-in is wired up. A new operator that isn't registered there does not exist as far as the running system is concerned.

### RunConfig is declarative

```typescript
interface RunConfig {
  problem: OperatorRef;      // { id, params? }
  encoding: OperatorRef;
  selection: OperatorRef;
  crossover: OperatorRef;
  mutation: OperatorRef;
  termination: OperatorRef[];   // ANY firing stops the run
  mutationRate: number;
  populationSize: number;
  elitism: number;
  seed: number;
}
```

Everything is a registry id plus a params object, so a config is JSON-serializable end to end — storable in SQLite, postable over HTTP, saved to localStorage as a preset. The engine resolves ids through the registry in its constructor.

### Run lifecycle

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> running: start()
    running --> paused: pause()
    paused --> running: resume()
    paused --> paused: step()
    running --> finished: termination fires
    running --> error: exception in generation
    running --> stopped: stop()
    paused --> stopped: stop()
    finished --> [*]
    stopped --> [*]
    error --> [*]
```

`start()` on a `finished` or `stopped` run **throws** — runs are not restartable. `step()` executes exactly one generation while paused or pending and leaves status `paused`.

The loop is driven by `setImmediate`, one generation per tick. That is what keeps the server responsive: the engine yields to the event loop between generations rather than blocking on a tight `for`.

### One generation, in order

1. **Evaluate** — `problem.evaluate()` across the population
2. **Compute stats** — best / mean / median / worst / stdDev, plus `diversity`
3. **Emit** `generation` and `best`
4. **Check termination** — against history **including** the generation just computed
5. **Elitism** — clone the top `elitism` genomes verbatim into the next population
6. **Select** parents for the remaining slots
7. **Crossover + mutate** each parent pair into children
8. Increment generation

Two details that surprise people:

**Termination sees the current generation.** `check(history)` is called after the new stats are pushed, so `MaxGenerations(1)` stops after one generation, not two.

**Diversity is sampled, not exhaustive.** `computeDiversity()` shuffles the population and takes up to 50 individuals, making it O(50²) rather than O(n²). It is an estimate — a real one, but don't read it as exact for large populations.

Parent count is rounded up to even (`needed % 2 === 0 ? needed : needed + 1`) because crossover produces children in pairs; the extra child is discarded when `needed` is odd.

### Determinism

`SeededRandomSource` is mulberry32 — seeded, fast, and bit-for-bit reproducible across platforms. **Same seed + same config ⇒ identical run.**

This holds only as long as every operator draws randomness exclusively from the injected `RandomSource`. An operator calling `Math.random()` directly breaks reproducibility for the whole system, and no test will catch it. This is the single easiest way to do real damage here.

(An operator that draws *no* randomness is fine and not a bug — `ArithmeticCrossover` blends on a configured alpha and is deterministic by design, which is why its `rng` parameter is named `_rng`.)

### Server

```mermaid
sequenceDiagram
    participant W as web
    participant API as Fastify
    participant RM as RunManager
    participant E as Engine
    participant DB as SQLite

    W->>API: POST /api/runs {config}
    API->>API: zod validate
    API->>RM: createRun(config)
    RM->>E: new Engine(config, registry)
    RM->>DB: createRun row
    API-->>W: {runId}

    W->>API: WS subscribe {runId}
    API->>RM: subscribe(runId, send)

    loop each generation
        E->>RM: generation event
        RM->>DB: buffer (flush every 10)
        RM-->>W: WS {type:"generation", stats}
    end

    E->>RM: finished
    RM->>DB: flush buffer + markFinished
    RM-->>W: WS {type:"finished", reason}
```

`RunManager` owns every live run and wires each engine to two sinks: WebSocket broadcast and SQLite persistence.

**Stats are buffered.** `FLUSH_EVERY = 10` — generation stats accumulate in memory and write to SQLite in batches, with a final flush on `finished`. WebSocket delivery is *not* buffered; clients see every generation immediately.

`RunStore` applies two deliberate SQLite pragmas: `journal_mode = MEMORY` (no `-wal`/`-shm` files on disk) and `locking_mode = EXCLUSIVE` (single writer, no lock contention).

### REST surface

| Endpoint | Purpose |
| --- | --- |
| `GET /api/operators` | All operator metadata — drives the UI forms |
| `GET /api/problems` | Problem metadata only |
| `POST /api/runs` | Validate config, create **and start** a run |
| `GET /api/runs` | List summaries |
| `GET /api/runs/:id` | Detail + full stats history |
| `POST /api/runs/:id/control` | `pause` / `resume` / `step` / `stop` |
| `GET /api/runs/:id/visual` | Current-best visual frame |
| `DELETE /api/runs/:id` | Stop if running, then delete |

`POST /api/runs` creates *and starts* in one call — there is no separate start endpoint.

Status codes carry meaning: **400** = malformed body (zod), **422** = valid shape but the engine rejected it (unknown operator id, `elitism >= populationSize`), **404** = no such run, **409** = illegal transition for the run's current state.

### WebSocket protocol

Single endpoint `/ws`. Clients send `{type: "subscribe" | "unsubscribe", runId}`; the server sends four message types, all discriminated on `type` and all tagged with `runId`:

| Message | Payload |
| --- | --- |
| `generation` | `stats: GenerationStats` |
| `best` | `generation`, `genome`, `fitness` |
| `status` | `status: RunStatus` |
| `finished` | `reason`, `finalBestFitness`, `generations` |

Subscriptions are tracked per socket in a `Map` keyed by `runId`, so one socket
may watch several runs independently: `unsubscribe` tears down only the named
run, and re-subscribing to a run already being watched *replaces* its handler
rather than stacking a second one. Both behaviors are covered by regression
tests in `server.test.ts`.

### Web data flow

Next.js App Router, five routes: `/`, `/experiments/new`, `/runs`, `/runs/[id]`, `/compare`.

- `lib/config.ts` — `API_URL` from `NEXT_PUBLIC_API_URL` (default `http://localhost:4040`); `WS_URL` is derived from it by rewriting `http→ws` / `https→wss` and appending `/ws`. Set the HTTP URL only; the WS URL follows.
- `lib/api.ts` — thin typed fetch wrapper, throws `ApiError` carrying the status code
- `lib/use-run-stream.ts` — the live subscription hook
- `lib/presets.ts` — configs saved to `localStorage`, degrading to empty on corrupt JSON

`useRunStream` reconnects with exponential backoff (up to 5 attempts, capped at 10s), stops reconnecting once the run has finished, and **de-duplicates generations after a reconnect** by dropping any stats whose generation is `<=` the last one seen.

---

## Adding a new operator

Concretely, for a new selection operator:

1. **Create the class** in `packages/core/src/operators/selection/`, extending `SelectionOperator<G>`:

```typescript
export class MySelection extends SelectionOperator<unknown> {
  static override readonly operatorId = "my-selection";
  static override readonly displayName = "My selection";
  static override readonly description = "One line — this is shown in the UI.";
  static override readonly paramsSchema = {
    pressure: { type: "number", minimum: 0, maximum: 1, default: 0.5, title: "Pressure" },
  } as const;
  static readonly compatibleEncodings = ["binary", "numeric"] as const;

  override select(pop: readonly unknown[], fit: readonly number[], count: number, rng: RandomSource): unknown[] {
    // draw ONLY from rng — never Math.random()
  }
}
```

2. **Register it** in `defaults.ts` inside `createDefaultRegistry()`. Skipping this means it doesn't exist.
3. **Export it** from `packages/core/src/index.ts` if consumers should reach it directly.
4. **Test it** in `packages/core/src/engine.test.ts` or a sibling suite.
5. **Do nothing in the UI.** The form generates itself from `paramsSchema`.

Omit `compatibleEncodings` (or leave it empty) to mean encoding-agnostic.

The same shape applies to the other five kinds — different base class, different registry kind, same five steps.

---

## Known sharp edges

Verified, current, and worth knowing before you debug them:

1. **Runs live in memory.** `RunManager` holds engines in a `Map`. A server restart loses every live engine while its SQLite row still reads `running` — control calls on that run then return 404. There is no rehydration path. (Tracked as genebaer-5ft.)
2. **Runs are not restartable.** `start()` on a `finished` or `stopped` run throws.
3. **`mutationRate` semantics are operator-defined.** Per-gene for `BitFlipMutation`, but each operator interprets the rate itself. Read the operator before assuming.
4. **`data/` is gitignored.** The SQLite DB is local-only; there is no shared run history.
5. **`elitism` is validated in two places with different strictness.** zod accepts any non-negative integer; the engine additionally requires `elitism < populationSize` and throws `RangeError`, surfacing as a 422.
