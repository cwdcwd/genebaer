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

# Does scoring under random augmentation blunt the exploit? (genebaer-6kh)
# Run from packages/server so node resolves the optional dependency.
cd packages/server
BUDGET=4000 N_AUG=8 IMAGE=/path/to/cats.jpg \
  node ../../experiments/clip-augmented-robustness.mjs
```

`clip-augmented-robustness.mjs` is the expensive one: the N=8 arms cost eight
image embeddings per candidate, so budget for ~20 minutes at BUDGET=4000.

The first run downloads weights and takes ~11s longer.

## What they found

`clip-gradient.mjs` — CLIP *does* provide a climbable gradient. The GA beat
random search on every prompt tested.

`clip-drawn-target-control.mjs` — and what it climbs toward is adversarial. The
evolved image scored **0.3449** against "a red circle on a white background";
an actually-drawn red circle scored **0.2621**.

`clip-natural-baseline.mjs` — the same conclusion against a real photograph,
which is the fairer ceiling. GA-evolved noise **0.3189** vs a genuine cat photo
**0.2370**, and **0.2122** for that photo resized to the GA resolution.

`clip-augmented-robustness.mjs` — averaging over 8 random crops/flips strips the
attack of most of its score (**−21%**) while a real photograph loses **1.6%**.
It is not a cure: optimising the augmented objective directly still beats the
photograph by 13%, and only augmentation *plus* the polygon representation
brings that to 7%.

Full write-up: [`../docs/experiments/clip-gradient.md`](../docs/experiments/clip-gradient.md).
