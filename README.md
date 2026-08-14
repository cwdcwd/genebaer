# genebaer

An extensible genetic algorithm runner with a live web visualizer.

```text
┌──────────────┐  WS/REST   ┌───────────────┐    uses     ┌────────────────┐
│  apps/web    │ ◄────────► │ packages/     │ ──────────► │ packages/core  │
│  (Next.js)   │            │ server        │             │ (GA engine)    │
└──────────────┘            │ (Fastify+WS)  │             └────────────────┘
                            │ + SQLite      │                    ▲
                            └───────────────┘     shared wire types
                                     ▲          ┌────────────────────────┐
                                     └───────── │ packages/shared-types  │
                                                └────────────────────────┘
```

## Quick start

```sh
pnpm install
pnpm build            # build all packages
pnpm -F @genebaer/server dev     # API+WS on :4040 (tsx watch)
pnpm -F @genebaer/web dev        # UI on :3000
```

Or with Turborepo (parallel): `pnpm dev` runs every package's `dev` script.

Open http://localhost:3000 → **New experiment** → pick a problem (e.g. OneMax) → **Start run**.

## Architecture

> For the full treatment — repo layout and dependency rules, the run lifecycle,
> the WebSocket protocol, how to add an operator, and the known sharp edges —
> see **[docs/architecture.md](docs/architecture.md)**. The summary below is the
> orientation version.

### `@genebaer/core` — engine, zero I/O deps

Every GA aspect is an abstract base class with a static `operatorId` + JSON Schema `paramsSchema`. Concrete operators are registered in an `OperatorRegistry` keyed by `(kind, id)`:

| kind          | built-ins |
|---------------|-----------|
| `encoding`    | `binary`, `numeric`, `string` |
| `selection`   | `tournament`, `roulette`, `rank`, `elitism` |
| `crossover`   | `one-point`, `two-point`, `uniform`, `arithmetic` |
| `mutation`    | `bit-flip`, `gaussian`, `swap`, `char` |
| `termination` | `max-generations`, `target-fitness`, `stagnation` |
| `problem`     | `one-max`, `sphere`, `rastrigin`, `weasel`, `mds` |

`GeneticAlgorithmEngine` consumes a declarative `RunConfig` (JSON-serializable), resolves it via the registry, and exposes `start/pause/resume/step/stop` plus typed events (`generation`, `best`, `finished`, `status`, `error`). Runs are seeded (mulberry32) → same seed + config = identical run.

### `@genebaer/server` — Fastify REST + WebSocket + SQLite

`RunManager` holds live engines, fans events out to WS subscribers and SQLite. Persists: run config/status, per-generation stats, best genome per generation. macOS-safe prisma: `journal_mode = MEMORY`, `locking_mode = EXCLUSIVE`.

REST (default `:4040`):
```
GET    /api/operators                  registry metadata for UI forms
GET    /api/problems                   problems only
POST   /api/runs        {config} → {runId}   (auto-starts)
GET    /api/runs → RunSummary[]
GET    /api/runs/:id → RunDetail (incl. stats[])
POST   /api/runs/:id/control  {action: pause|resume|step|stop}
GET    /api/runs/:id/visual    current-best visual frame
DELETE /api/runs/:id
```

WS: `ws://:4040/ws` — send `{"type":"subscribe","runId":"…"}`; receive `generation | best | finished | status`. See `packages/shared-types/src/index.ts`.

### `apps/web` — Next.js 15 visualizer

- `/experiments/new` — form auto-generated from registry metadata (no hardcoded operators)
- `/runs` — history table + multi-select compare
- `/runs/[id]` — live Recharts fitness/diversity curves, pause/resume/step/stop, per-problem canvas visualizer (OneMax cells, Weasel diff, MDS graph, vector scatter)
- `/compare?ids=a,b` — overlayed best-fitness curves + config diff

## Extending: add a custom problem/operator

```ts
import { FitnessProblem, createDefaultRegistry } from "@genebaer/core";
import { createServer } from "@genebaer/server";

class LeadingZeros extends FitnessProblem<number[]> {
  static override readonly operatorId = "leading-zeros";
  static override readonly displayName = "Leading zeros";
  static override readonly paramsSchema = {};
  static override readonly compatibleEncodings = ["binary"] as const;
  evaluate(g: number[]) {
    let i = 0;
    while (i < g.length && g[i] === 0) i++;
    return i;
  }
}

const registry = createDefaultRegistry().register("problem", LeadingZeros);
createServer({ dbPath: "./data/genebaer.db", registry }).listen({ port: 4040 });
```

Restart the server; `leading-zeros` appears in the UI automatically.

## Adding a termination condition / operator

Same pattern: subclass the base (`SelectionOperator`, `CrossoverOperator`, `MutationOperator`, `TerminationCondition`, `Encoding`), declare static `operatorId` + `paramsSchema`, register it. The UI renders param forms from the JSON Schema.

## Tests

```sh
pnpm test   # vitest in core (36) + server (5)
```

## Data

SQLite lives at `packages/server/data/genebaer.db` by default (`DB_PATH` env to override). Delete it to wipe history.

## License

MIT
