# Does CLIP provide a climbable gradient?

**genebaer-kz9.** Measured with real inference, not a proxy.

## The question

[The raw bit-string spike](./raw-bitstring-convergence.md) showed the encoding can
climb a *smooth* image-space gradient, using a proxy fitness with a dense
per-pixel signal. It deliberately did not establish that CLIP provides such a
gradient: a CLIP score is one semantic judgement of a whole image, and could
plausibly be too flat or too noisy to select on — especially early, when every
candidate is noise.

## Setup

Real `Xenova/clip-vit-base-patch32` via transformers.js on CPU.

- Load: ~11s once per process. Inference: **~15ms** per image after warmup.
- 32×32 RGB genome (24,576 bits), `binary` encoding, `bit-flip` mutation
- GA: `mutationRate` 5e-4, population 30, tournament k=3, uniform crossover,
  elitism 2 — the defaults recommended by the previous spike
- Baseline: random search at an **equal evaluation budget**

## Result 1: the gradient is real and climbable

| Prompt | Budget | Random search | GA | Δ |
| --- | --- | --- | --- | --- |
| "a solid red image" | 6,000 | 0.2755 | **0.3302** | +0.0547 |
| "a red circle on a white background" | 4,000 | 0.2499 | **0.3449** | +0.0950 |
| "a photograph of a cat" | 4,000 | 0.2474 | **0.3189** | +0.0716 |

The GA beat random search on every prompt, and the trajectories climb smoothly
and monotonically rather than jumping:

```
0.2334 → 0.2590 → 0.2813 → 0.2939 → 0.3037 → 0.3171 → 0.3280 → 0.3352 → 0.3433
```

Still rising at the end of budget in all three runs. **CLIP's signal is not too
flat to climb.** That was the open risk, and it is retired.

## Result 2: what it climbs toward is not the picture you asked for

This is the finding that matters.

For "a red circle on a white background":

| Image | CLIP score |
| --- | --- |
| Random noise | 0.2235 |
| **A genuinely drawn red circle** | **0.2621** |
| **What the GA evolved** | **0.3449** |

The evolved image scores **32% higher than an actual red circle**. The GA is not
learning to draw; it is finding an adversarial input that this particular CLIP
checkpoint rates very highly and a human would call noise.

That is not a bug in the GA. It is the GA doing exactly its job — maximising the
number it was given — and the number turning out to be a poor proxy for the goal.
CLIP was trained to *discriminate* among natural images, never to be *optimised
against* by an unconstrained search over all possible pixel arrays. Nothing
confines the search to the manifold of plausible images, so it leaves it.

The corroborating detail: for "a solid red image" the GA reached 0.3302, while a
perfect solid red field scores 0.3052. It beat the literal correct answer.

### Is a drawn control too easy on CLIP?

Fair challenge. CLIP is trained on natural photographs, so a flat-colour drawn
circle is itself somewhat off-manifold — 0.2621 might be low because the
*control* is a poor image, not because the GA is uniquely adversarial. And the
"photograph of a cat" run had no control at all, which is the prompt where a
real photo is most obviously the right ceiling.

So it was measured with an actual photograph:

| Image | CLIP score |
| --- | --- |
| A real photograph of cats, 640×480 | 0.2370 |
| The same photo resized to 32×32, matching the GA's resolution | 0.2122 |
| **GA-evolved 32×32 noise** | **0.3189** |

The natural baseline makes the result **stronger, not weaker**. The GA's noise
beats a genuine cat photograph by 35%, and beats the resolution-matched control —
the fairest comparison, since both are 32×32 inputs — by **50%**.

The drawn-circle control was being generous to CLIP. A real image of the thing
the prompt asks for scores *lower* than a drawn approximation, and both are far
below what unconstrained search finds.

Note also how low the ceiling is in absolute terms: a correct, high-quality
natural photograph scores 0.2370, while the achievable adversarial score exceeds
0.34. There is more headroom *outside* the manifold than inside it, which is
precisely why an unconstrained optimiser leaves.

## What this means for the epic

The encoding works. The fitness signal is climbable. **The pairing does not
produce recognisable images**, and no amount of tuning mutation rates will fix
that, because the optimum genuinely is adversarial noise.

Two independent levers, in the order I would try them:

**1. Constrain the search space.** An adversarial per-pixel pattern is very hard
to express with 50 translucent polygons; the encoding itself excludes most of
the off-manifold space. This is why the classic "evolving Mona Lisa" approach
uses primitives, and it is the alternative encoding
[the previous spike](./raw-bitstring-convergence.md) named but did not need to
evaluate. It is now needed. Tracked as **genebaer-6hf**, and now built —
see [Constraining the search space with polygons](./polygon-constraint.md).
The representation is in place and its constraining mechanism is measured; its
effect on the adversarial score is not yet, and that doc says so plainly.

**2. Score under augmentation.** Adversarial patterns are brittle: they stop
working under random crops, flips, and resizes. Scoring the mean CLIP similarity
over N random augmentations of the same image is the standard defence in
CLIP-guided generation, and costs N× inference. Tracked as **genebaer-6kh**.

Neither is speculative — both address the measured failure directly, and either
can be evaluated with the same random-search-baseline method used here.

## Honest limits of this measurement

- **One checkpoint.** `clip-vit-base-patch32`. A larger CLIP may be harder to
  fool, though the literature suggests the effect persists.
- **One resolution.** 32×32, upscaled to CLIP's 224×224 input. Larger genomes
  have more room for adversarial structure, not less.
- **"Recognisable" was assessed by comparison, not by a human study.** Two
  independent controls agree - a drawn target and a real photograph - which is a
  strong signal, but not a formal evaluation.
- **Not run in CI.** ~150MB of weights and a network make that a poor trade for
  every push; the spike scripts are reproducible on demand.
