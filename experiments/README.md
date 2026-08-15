# Experiments

Reproducible spikes backing the findings in [`../docs/experiments/`](../docs/experiments/).

These are **not** part of the test suite and do not run in CI. They need real
model weights (~150MB) and a network, which is a poor trade on every push — but
a claim nobody can re-run is not a measurement, so the scripts live here.

## Running the CLIP experiments

Real inference needs transformers.js, which is deliberately **not** a workspace
dependency: it pulls `onnxruntime-node` and together they add ~819MB, more than
doubling `node_modules` for something only these scripts and real CLIP workers
use. Install it where you need it:

```sh
pnpm --filter @genebaer/server add -D @huggingface/transformers
pnpm build            # the scripts import built dist output
```

Then:

```sh
# GA vs random search at equal budget, real CLIP
node experiments/clip-gradient.mjs
BUDGET=4000 PROMPT="a photograph of a cat" node experiments/clip-gradient.mjs

# Is the evolved image on-manifold, or adversarial?
node experiments/clip-drawn-target-control.mjs
```

The first run downloads weights and takes ~11s longer.

## What they found

`clip-gradient.mjs` — CLIP *does* provide a climbable gradient. The GA beat
random search on every prompt tested.

`clip-drawn-target-control.mjs` — and what it climbs toward is adversarial. The
evolved image scored **0.3449** against "a red circle on a white background";
an actually-drawn red circle scored **0.2621**.

Full write-up: [`../docs/experiments/clip-gradient.md`](../docs/experiments/clip-gradient.md).
