# Does augmented scoring blunt adversarial exploitation?

**genebaer-6kh.** The second of the two levers named at the end of
[the CLIP gradient measurement](./clip-gradient.md). Measured with real
inference, three seeds.

## The claim under test

Adversarial patterns depend on precise pixel alignment. Averaging CLIP
similarity over N random crops and flips should therefore collapse an
adversarial score while leaving a genuinely recognisable image roughly intact —
because a real picture of a cat is still a picture of a cat after you crop it.

This is independent of [the polygon representation](./polygon-constraint.md):
that constrains what can be drawn, this changes what is rewarded.

## Setup

Real `Xenova/clip-vit-base-patch32`, prompt "a photograph of a cat", 32×32,
budget 1,500 evaluations per arm, N=8 augmented views, seeds 11/23/37. Every
number below is the mean of the three.

Budget is counted in **evaluations**, so the N=8 arms saw the same number of
candidates as the N=1 arms while costing eight times the image-side inference.

## Result 1: the attack collapses, and genuine images do not

Each row scored both ways. `delta` is N=8 minus N=1 — how much the score depends
on exact alignment.

| Image | N=1 | N=8 | delta |
| --- | --- | --- | --- |
| **bits GA, optimised at N=1 (the attack)** | **0.2937** | **0.2316** | **−0.0620** |
| polygon GA, optimised at N=1 | 0.2488 | 0.2173 | −0.0315 |
| random noise | 0.2336 | 0.2216 | −0.0119 |
| flat grey | 0.2100 | 0.2100 | 0.0000 |
| real photograph, resized to 32×32 | 0.2122 | 0.2088 | −0.0034 |

The signature is exactly as predicted, and `delta` turns out to be a clean
diagnostic on its own:

- The adversarial image loses **0.062** — a 21% drop — landing at 0.2316, which
  is *below random noise's own aligned score*. Almost the entire advantage it
  had was alignment-dependent.
- A real photograph loses **0.003**, and flat grey loses nothing at all. The
  penalty is specific to the artifact, not a general effect of cropping.

**Augmentation is not a blur.** Views are nearest-neighbour resampled precisely
so the defence cannot come from quietly low-passing the image; it comes from
requiring the image to survive a change of viewpoint.

## Result 2: it raises the cost of the attack, it does not end it

The harder question is what happens when the search optimises the augmented
objective *directly*. It finds a new exploit — weaker, but real.

Measured as the margin over a real photograph, each judged on the objective its
run optimised:

| Run | Score | Photo baseline | Margin |
| --- | --- | --- | --- |
| bits GA at N=1, judged at N=1 | 0.2937 | 0.2122 | **+38%** |
| polygon GA at N=1, judged at N=1 | 0.2488 | 0.2122 | +17% |
| bits GA at N=8, judged at N=8 | 0.2350 | 0.2088 | **+13%** |
| polygon GA at N=8, judged at N=8 | 0.2229 | 0.2088 | **+7%** |

Augmentation alone cuts the adversarial margin from 38% to 13%. Both levers
together cut it to 7%. That is roughly an 82% reduction — and it is **not
elimination**. An optimiser pointed at a proxy will find the best available
exploit of that proxy; making the proxy harder to exploit buys a smaller
exploit, not an honest one.

The sign of `delta` separates the two regimes cleanly. Everything optimised at
N=1 is strongly negative (bits −0.062, polygons −0.032). Everything optimised at
N=8 sits near zero or positive (bits −0.010, polygons **+0.007**) — the same
place genuine images sit. A robust image is one whose score does not care how
you look at it.

## Result 3: this partly corrects the polygon write-up

[polygon-constraint.md](./polygon-constraint.md) said plainly that the
representation's effect on the adversarial score was **not** established, and
listed "the search may exploit polygons adversarially in its own way" as a way
it could fail. That is now measured, and that is what happens: polygons alone,
at N=1, still reach 0.2488 against a photograph's 0.2122 — a 17% margin. The
constraint roughly halves the exploit; it does not remove it.

Both levers were worth building, and neither is sufficient alone. Their
combination is the only configuration that lands near photograph parity.

## Recommendation on the default

**Keep `augmentations: 1`.** Not because 1 is good, but because the cost is the
caller's to spend: N=8 multiplies image-side inference by eight, and
`clip-similarity` is a general contract that non-image callers also use.
Silently octupling everyone's inference bill is not a default's decision to
make.

**Use `augmentations: 8` for any run that cares whether the image is
recognisable**, together with the polygon representation. The param description
in the registry says so, so it reaches the form rather than only this file.

Diminishing returns were not measured — N=4 and N=16 were not swept. N=8 is the
conventional choice in CLIP-guided generation and is what these numbers describe.

## Honest limits of this measurement

- **Budget 1,500, not 4,000.** [clip-gradient.md](./clip-gradient.md) reached
  0.3189 with a larger budget; the attack reproduced here peaks at 0.2937. A
  longer run would likely widen every margin in the table, including the
  defended ones.
- **Three seeds, one prompt, one checkpoint.** The direction was identical
  across all three seeds and the spread was small, but this is not a study.
- **The N=8 arms are judged on the objective they optimised.** That is why the
  comparison is stated as a margin over the photograph on a common objective,
  rather than as raw scores across rows.
- **"Recognisable" is still assessed by comparison, not by a human study.**
  A score at photograph parity is evidence that the exploit is gone, not
  evidence that the picture looks like a cat.
- **Not run in CI.** Weights and a network make that a poor trade per push. The
  augmentation mechanism itself — determinism, view geometry, server/browser
  agreement — is fully covered by fast tests that need neither.

## Reproducing

```sh
cd packages/server
SEED=11 BUDGET=1500 N_AUG=8 IMAGE=/path/to/cats.jpg \
  node ../../experiments/clip-augmented-robustness.mjs
```
