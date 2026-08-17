# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd prime` for full workflow context.

> **Architecture in one line:** Issues live in a local Dolt database
> (`.beads/dolt/`); cross-machine sync uses `bd dolt push/pull` (a
> git-compatible protocol), stored under `refs/dolt/data` on your git
> remote — separate from `refs/heads/*` where your code lives.
> `.beads/issues.jsonl` is a passive export, not the wire protocol.
>
> See [sync-concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md)
> for the one-screen overview and anti-patterns (don't treat JSONL as the
> source of truth; don't `bd import` during normal operation; don't
> reach for third-party Dolt hosting before trying the default).

## Operating Mode: Team-Maintainer (explicit opt-in)

> This section is the repository's explicit opt-in required by **Agent Context
> Profiles** below. It is hand-maintained and lives outside the managed Beads
> block on purpose — do not move it inside, or `bd setup` will overwrite it.
> Mirrored in CLAUDE.md; keep both copies in sync.

This repo is an experiment in loop engineering / software-factory management.
Agents run the full implement→validate→publish cycle without asking for
approval at each step.

**Granted authority.** An agent may, on its own initiative:

- **Survey the repo, decide what is worth doing, and file beads for it.**
  Agents are self-directed: you are not limited to work someone else scoped.
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
**60s debounce** — not synchronously with `bd close`. Committing without a
forced export stages stale issue state, and the debounce then fires afterward,
dirtying the tree and aborting `git switch master`. `bd export -o
.beads/issues.jsonl` writes synchronously and closes the race.

`bd export` excludes `bd remember` memories by default. Keep it that way: this
repo is PUBLIC. Do not add `--include-memories`.

**Gate honesty is the core discipline of this experiment.** Never report a gate
as passing that did not execute. If a gate is a no-op, say so and file a bead.
If gates go red, stop the iteration and report — do not commit around a
failure, weaken an assertion, or skip a gate to close a bead.

Current gate status: `typecheck`, `test`, `lint` and `build` are all real and
cover all 5 packages (468 tests). Note that `shared-types` is tested at the type
level only (`vitest run --typecheck`) because it emits no runtime code. Counts
drift - re-run `pnpm test` before quoting one. See CLAUDE.md for the full gate
table and docs/architecture.md for how distributed evaluation works.

### Self-directed work

Agents choose their own work. `bd ready` is the queue, but when it is empty or
nothing there is worth doing, survey the repo and file what is.

**Justifies a bead:** a gate that does not gate, a documented behavior that is
not true, a sharp edge that has become a real bug, dead or duplicated code, a
missing test for logic that can silently break.

**Does not:** speculative refactors, dependency bumps with no failing symptom,
restyling working code, or "improvements" to something you have not first shown
to be broken. Prefer one finished bead over three opened ones.

Two hard limits:

- **Do not redefine the mission.** Adding a capability nobody asked for is out
  of scope even if the code would be better for it. Fix and harden what exists.
- **Do not touch this section, the gates, or CI to make your own work easier.**
  Weakening the referee to get a green run is the one unrecoverable failure in a
  factory. If a gate is wrong, file a bead saying so and leave it red.

### Running agents in parallel

**1. Claim before you work.** `bd update <id> --claim` takes a ~5 minute lease
(`lease_expires_at`), so two agents cannot hold the same bead. Release a bead
abandoned by a crashed agent with `bd unclaim <id>`. Never work an issue you did
not successfully claim.

**2. Isolate your checkout.** One agent per working tree — concurrent agents in
one directory fight over the index, the branch, and `.beads/`:

```bash
git worktree add ../genebaer-<id> -b bead/<id> master
cd ../genebaer-<id> && pnpm install
```

Override ports if you run the app (`PORT` for the server, `next dev -p` for
web); two agents on defaults collide on 4040/3000. Tests are already
parallel-safe — the server suite uses in-memory SQLite.

**3. Let the merge driver handle `.beads/issues.jsonl`.** Every bead rewrites
it, so any two concurrent branches conflict there. `.gitattributes` maps it to a
`beads-export` driver that regenerates it from the Dolt DB.

Install **once per clone** with `pnpm setup:git`; worktrees share `.git/config`
and inherit it. The `prepare` script also runs it, but pnpm skips lifecycle
scripts when the install is already up to date, so `pnpm install` only covers a
genuinely fresh checkout. Verify with
`git config --get merge.beads-export.driver` (expect `bd export -o %A`).

Never hand-merge that file. Conflict markers mean the driver is missing: run
`pnpm setup:git`, then resolve with `bd export -o .beads/issues.jsonl`. The
driver regenerates from the local Dolt DB, so across machines `bd dolt pull`
first.

### CI is the referee

`.github/workflows/ci.yml` runs all four gates on every PR and on `master`, and
the check is **required** — `master` rejects a merge whose gates failed.

This does not replace running gates locally. Push only when green on your
machine; CI catches what a local run missed and makes "gates passed"
independently verifiable. A red CI run on your own PR is yours to fix.

**The human still merges.** CI decides whether a PR *may* merge; a person
decides whether it *should*.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

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

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
