#!/usr/bin/env bash
#
# Installs the `beads-export` git merge driver into this clone's .git/config.
#
# .gitattributes maps .beads/issues.jsonl to merge=beads-export, but the driver
# definition itself lives in .git/config, which git cannot distribute. Every
# clone and every worktree host must run this once. It is idempotent and safe to
# re-run, and it is wired into the root `prepare` script so `pnpm install` does
# it for you.
#
# Why a driver at all: the JSONL is a derived export of the Dolt DB in .beads/.
# Every bead rewrites the whole file, so two concurrent branches always conflict
# there. Merging two snapshots of a database line-by-line is meaningless; the
# correct resolution is always "regenerate from the DB", which is what the
# driver does.
#
# Caveat: the driver regenerates from the LOCAL Dolt DB, so that DB must already
# contain both sides' issues. On a single machine it does. Across machines, run
# `bd dolt pull` before merging.

set -euo pipefail

# Not a git repo (e.g. a tarball install, or a CI checkout without .git) — do
# nothing rather than fail the install.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "setup-git-merge-driver: not a git repository, skipping."
  exit 0
fi

if ! command -v bd >/dev/null 2>&1; then
  echo "setup-git-merge-driver: 'bd' not on PATH, skipping driver install."
  echo "  Install beads, then re-run: bash scripts/setup-git-merge-driver.sh"
  exit 0
fi

# %A is the path git wants the merged result written to. We ignore %O (ancestor)
# and %B (theirs) entirely and regenerate the file from the Dolt DB.
git config merge.beads-export.name "regenerate the beads export from the Dolt DB"
git config merge.beads-export.driver "bd export -o %A"

echo "setup-git-merge-driver: installed 'beads-export' merge driver."
