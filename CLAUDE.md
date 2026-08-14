# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

## Operating Mode: Team-Maintainer (explicit opt-in)

> This section is the repository's explicit opt-in required by **Agent Context
> Profiles** below. It is hand-maintained and lives outside the managed Beads
> block on purpose — do not move it inside, or `bd setup` will overwrite it.

This repo is an experiment in loop engineering / software-factory management.
Agents run the full implement→validate→publish cycle without asking for
approval at each step.

**Granted authority.** An agent may, on its own initiative:

- Create, claim, update, and close beads
- Run quality gates (`pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`)
- Create branches, commit, and push *those branches* to `origin`
- Open pull requests against `master`
- Run `bd dolt push` / `bd dolt pull` to sync issue state

**Withheld — always requires an explicit request in the current session:**

- **Merging a PR.** The human merges. This is the review gate; the loop stops here.
- **Pushing directly to `master`**, or any push that bypasses a PR
- **Force-push, history rewrite, or branch deletion** on `master`
- Committing anything gitignored or credential-bearing (`.env`, `.env.local`,
  `.beads-credential-key`, `.dolt/`, `*.db`, `.beads/proxieddb/`)
- Changing this section, repo visibility, or remote configuration

**This repo is PUBLIC.** Every push and every committed issue body in
`.beads/issues.jsonl` is world-readable. Treat all of it as published.

### Loop protocol

One bead per iteration, one branch per bead:

```bash
bd ready                                  # select highest-priority unblocked work
bd update <id> --claim
git switch -c bead/<id>                   # never work on master
# ...implement...
pnpm typecheck && pnpm test && pnpm lint  # gates must pass; do not proceed on red
bd close <id>                             # BEFORE committing — see note
bd export -o .beads/issues.jsonl          # force a synchronous export — see note
git add -A && git commit -m "<summary> (<id>)"
git push -u origin HEAD
gh pr create --title "<summary> (<id>)" --body "Closes <id>. <what changed, gate results>"
git switch master                         # leave the tree clean for the next iteration
```

**Close the bead, force the export, then commit.** `.beads/issues.jsonl` is a
tracked file written by beads itself, and `export.auto = true` flushes it on a
**60s debounce** — not synchronously with `bd close`. That race has two distinct
symptoms, and both have bitten this repo:

1. `git add` immediately after `bd close` stages the *stale* JSONL, committing
   issue state that reads `in_progress` for work that is actually closed.
2. The debounce then fires after the commit, dirtying the tree and aborting
   `git switch master` — stranding the iteration.

`bd export -o .beads/issues.jsonl` writes synchronously and closes the race.
Never rely on the auto-export having run.

`bd export` excludes `bd remember` memories by default. Keep it that way: this
repo is PUBLIC and memories may carry agent context that should not be
published. Do not add `--include-memories`.

**Gate honesty is the core discipline of this experiment.** Never report a gate
as passing that did not execute. If a gate is a no-op, say so and file a bead.
If gates go red, stop the iteration and report — do not commit around a
failure, weaken an assertion, or skip a gate to close a bead.

If an iteration is blocked, leave the bead claimed with a note explaining why,
and report the exact command and error.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

pnpm + turbo monorepo. Node >= 20, pnpm 11.9.0.

```bash
pnpm install
pnpm typecheck   # tsc --noEmit across all 4 packages — REAL GATE
pnpm test        # vitest — REAL GATE (core: 36 tests, server: 5)
pnpm build       # tsc + next build
pnpm lint        # eslint (flat config) — REAL GATE, --max-warnings=0
pnpm dev         # turbo run dev: server + web visualizer
```

### Gate status

| Gate | Real? | Coverage |
| --- | --- | --- |
| `typecheck` | yes | all 4 packages |
| `test` | yes | all 4 packages — 99 tests (core 36, server 5, web 37, shared-types 21 type-level) |
| `lint` | yes | all 4 packages; ESLint flat config at repo root, `--max-warnings=0` |
| `build` | yes | all 4 packages |

**Linting.** One flat config at the repo root (`eslint.config.mjs`); each package
runs `eslint . --config ../../eslint.config.mjs --max-warnings=0`, so config
patterns must stay relative. Type-aware rules are not enabled yet (genebaer-bum).

**Testing.** vitest everywhere, but two different modes:

- `core`, `server`, `web` — ordinary runtime tests. `web` runs under jsdom with
  Testing Library; its vitest config deliberately omits `@vitejs/plugin-react`
  (incompatible Vite internals) and uses esbuild's `jsx: "automatic"` instead.
- `shared-types` — **type-level only** (`*.test-d.ts`, `vitest run --typecheck`).
  The package emits no runtime code, so a runtime test there would assert
  nothing. These tests guard the server↔web wire contract, which otherwise
  breaks silently.

When adding a package, add its test script in the matching mode. A package with
no suite is a hole in the gate, not a package that "passes".

## Architecture Overview

Extensible genetic algorithm runner with a live web visualizer.

- `packages/core` — the GA engine: population, selection, crossover, mutation,
  termination. Pure and dependency-light; where the real logic and the real
  test coverage live.
- `packages/server` — runs the engine and streams generation-by-generation
  state to clients.
- `packages/shared-types` — the type contract between server and web; imported
  by both, so changes here are breaking changes in two directions.
- `apps/web` — Next.js visualizer (dev on port 3000).

## Conventions & Patterns

- Issue tracking is **beads only** — no TodoWrite, no markdown TODO lists.
  Persistent knowledge goes in `bd remember`, not MEMORY.md files.
- One bead per branch, branch named `bead/<id>`; see the loop protocol above.
- Use non-interactive shell flags (`rm -f`, `cp -f`) — see AGENTS.md.
