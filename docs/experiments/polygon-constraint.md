# Constraining the search space with polygons

**genebaer-6hf.** The first of the two levers named at the end of
[the CLIP gradient measurement](./clip-gradient.md).

## The question

That measurement established the problem precisely: CLIP's gradient is real and
climbable, and what an unconstrained per-pixel search climbs toward is
adversarial noise scoring **50% above a resolution-matched photograph of the
subject**. No mutation-rate tuning fixes that, because the optimum genuinely is
noise.

The proposed fix was to change what the genome can express. A raw bit string can
encode any image, including every adversarial one. Translucent triangles cannot:
every gene moves or recolours a whole shape, so high-frequency per-pixel texture
is not in the reachable set at all.

This is a structural defence rather than a penalty term. A penalty is a cost the
search learns to pay; an unrepresentable image is unreachable no matter how
hard the search pushes.

## What was built

`representation: "polygons"` on the `image-prompt` problem, and it is now the
**default**. Each polygon is 10 genes in [0, 1] — three vertices, then RGBA —
over the existing `numeric` encoding with `gaussian` mutation. No new operators.
`representation: "bits"` remains available, because reproducing the original
result is the reason we know any of this.

One consequence worth stating on its own: **raster size no longer drives search
difficulty**. Under `bits`, a 64×64 image is a 98,304-gene genome. Under
`polygons`, 24 polygons is 240 genes whether the canvas is 16×16 or 256×256.
Resolution became a rendering choice instead of a search-space explosion.

## The measurement: the constraint is a ratio, not a property

The claim "polygons cannot express noise" is false as stated. Enough triangles
and they can — each one shrinks toward a pixel.

Measured as the fraction of horizontally adjacent pixels whose value differs, on
random genomes (12 per cell). A random bit string scores **~1.0** on this metric;
a smooth image scores near 0.

| Canvas | Polygons | Pixels/polygon | High-frequency fraction |
| --- | --- | --- | --- |
| 128×128 | 8 | 2048 | 0.058 |
| 64×64 | 8 | 512 | 0.110 |
| 128×128 | 16 | 1024 | 0.109 |
| 64×64 | 16 | 256 | 0.191 |
| **64×64** | **24** | **171** | **0.252** |
| 64×64 | 32 | 128 | 0.289 |
| 64×64 | 64 | 64 | 0.422 |
| 32×32 | 24 | 43 | 0.440 |
| 32×32 | 48 | 21 | 0.575 |
| 48×48 | 128 | 18 | 0.602 |

The metric tracks **pixels per polygon**, not polygon count, and it degrades
smoothly. There is no clean threshold — only a regime where the representation
constrains and a regime where it stops.

### This caught a bad default before it shipped

My first defaults were 32×32 with 48 polygons: 21 pixels each, **0.575** — more
than half of the noise level the whole change exists to prevent. It would have
looked like a defence in the code and in the PR description while providing
little.

The defaults are now 64×64 with 24 polygons (0.252), and `MIN_PIXELS_PER_POLYGON
= 100` with `ImagePrompt.constraintIsWeak` makes a dense configuration
inspectable rather than silently ineffective. A test asserts the shipped
defaults land in the constrained regime, so a future tweak cannot quietly undo
this.

`constraintIsWeak` reports rather than throws. A caller may legitimately want a
detailed image and accept the exposure; claiming the constraint holds when it
does not is the failure mode worth preventing.

## What is NOT yet established

**This has not been run against CLIP.** Everything above measures what the
representation can express, which is the mechanism the defence rests on. It does
not measure the outcome that motivated it: whether a polygon GA under CLIP
produces something recognisable, and where it lands against the
0.2122 resolution-matched photograph baseline.

That run needs the same real-inference harness as `clip-gradient.md` (~150MB of
weights, minutes per run) and belongs in its own experiment. The honest status
is: **the lever is built and its mechanism is measured; its effect on the
adversarial score is not.** Stating otherwise would repeat exactly the error
`clip-gradient.md` was written to correct — assuming a plausible mechanism
implies the outcome.

Two specific things could still go wrong:

1. **The search may exploit polygons adversarially in its own way.** Structural
   constraint bounds the frequency content, not the semantics. Dozens of
   overlapping translucent triangles can still form something CLIP likes and a
   human does not.
2. **Fewer genes may mean a weaker climb.** 240 genes is a far smaller search
   space than 24,576. That is the point, but it may also lower the achievable
   score — and a lower score against a *higher-quality* image is a success this
   metric alone would not distinguish from a failure.

Both are why [scoring under augmentation](./clip-gradient.md) (**genebaer-6kh**)
remains a separate, independent lever rather than a fallback.

## Reproducing

The ratio table is `packages/vision/src/polygons.test.ts` under
`"what the representation forbids"`, which asserts the comparative claim
(polygons vs. bits on the same random numbers) and the degradation, and runs in
CI in milliseconds — no weights, no network.
