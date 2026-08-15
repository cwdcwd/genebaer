# genebaer

An extensible genetic algorithm runner with a live web visualizer.

```text
┌──────────────┐  WS/REST   ┌───────────────┐   uses    ┌────────────────┐
│  apps/web    │ ◄────────► │ packages/     │ ────────► │ packages/core  │
│  (Next.js)   │            │ server        │           │ (GA engine)    │
└──────────────┘            │ (Fastify+WS)  │           └────────────────┘
       ▲                    │ + SQLite      │                  ▲
       │                    │ + job queue   │      shared wire types
       │  worker protocol   └───────────────┘   ┌────────────────────────┐
       │  (/ws/worker)              ▲   ▲   └── │ packages/shared-types  │
       └────────────────────────────┘   │       └────────────────────────┘
                                        │  uses ┌────────────────────────┐
   workers: browser tabs, worker        └────── │ packages/vision        │
   threads, or anything over HTTP              │ (image genome + PNG)   │
                                                └────────────────────────┘
```

**Fitness can run anywhere.** A run names a scoring *contract*; whichever
workers are connected — server threads, browser tabs, remote boxes — serve it.
See **[docs/architecture.md](docs/architecture.md)**.

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
| `problem`     | `one-max`, `sphere`, `rastrigin`, `weasel`, `mds`, `image-prompt` |
| `evaluator`   | `local` (in-process), `clip-similarity` (model-backed, distributed) |

`GeneticAlgorithmEngine` consumes a declarative `RunConfig` (JSON-serializable), resolves it via the registry, and exposes `start/pause/resume/step/stop` plus typed events (`generation`, `best`, `finished`, `status`, `error`). Runs are seeded (mulberry32) → same seed + config = identical run, PROVIDED the evaluator is deterministic. A model-backed evaluator is not; the score cache is what makes a replay exact. See docs/architecture.md.

### `@genebaer/server` — Fastify REST + WebSocket + SQLite

`RunManager` holds live engines, fans events out to WS subscribers and SQLite. Persists: run config/status, per-generation stats, best genome per generation. macOS-safe pragmas: `journal_mode = MEMORY`, `locking_mode = EXCLUSIVE`.

It also hosts distributed evaluation: a job queue, a worker registry with versioned capability matching, leases with re-dispatch, and a score cache.

REST (default `:4040`):
```
GET    /api/operators                  registry metadata for UI forms
GET    /api/problems                   problems only
POST   /api/runs        {config} → {runId}   (auto-starts)
GET    /api/runs → RunSummary[]
GET    /api/runs/:id → RunDetail (incl. stats[])
POST   /api/runs/:id/control  {action: pause|resume|step|stop}
GET    /api/runs/:id/visual    current-best visual frame
GET    /api/runs/:id/image.png best genome as a PNG
DELETE /api/runs/:id

# workers
POST   /api/workers/register   {capabilities:[{evaluatorId,version}]} → {workerId}
POST   /api/workers/claim      → lease + jobs, or {idle:true}
POST   /api/workers/score      {leaseId,evaluationId,index,score}
POST   /api/workers/heartbeat  → {extended} — false means re-claim
POST   /api/workers/fail       fail an evaluation this worker cannot score
GET    /api/workers            connected workers + queue stats
GET    /api/eval/stats         queue depth, cache, and NAMED blockers
```

WS:
- `ws://:4040/ws` — runs. Send `{"type":"subscribe","runId":"…"}`; receive `generation | best | finished | status | annotation`.
- `ws://:4040/ws/worker` — workers. Same protocol as the HTTP endpoints above, so a browser tab is a transport, not a special case.

See `packages/shared-types/src/index.ts` for both.

### `@genebaer/vision` — image genome, image problem, PNG

Raw pixel bit-string genomes (reusing the existing `binary` encoding and
`bit-flip` mutation unchanged), the `image-prompt` problem, and a
dependency-free PNG encoder built on Node's `zlib`.

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
pnpm test   # 292 tests across all 5 packages
```

## Data

SQLite lives at `packages/server/data/genebaer.db` by default (`DB_PATH` env to override). Delete it to wipe history.

## License

MIT
