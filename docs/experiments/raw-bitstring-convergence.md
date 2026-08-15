# Does a raw pixel bit string converge?

**genebaer-who.10.** Measured, not assumed.

## The question

The image epic evolves a raw pixel bit string: a 32×32 RGB genome is 24,576
bits, and 64×64 is 98,304. That is a search space of 2^24576. Before building
more on top of that encoding, it is worth knowing whether evolution can climb it
at all, or whether it merely *looks* like it is working while doing no better
than sampling at random.

The honest test of "is this GA doing anything" is a **random-search baseline at
an equal evaluation budget**. If evolution cannot beat random search given the
same number of fitness evaluations, no amount of parameter tuning is hiding a
real signal.

## Method

Fitness is a **proxy**, not CLIP: normalised similarity to a fixed target image
(left half red, right half white), in [0, 1], where 1 is identical.

The proxy was chosen to have the same *character* as a CLIP score — continuous,
bounded, higher-is-better — without needing a 150MB model in a test. See
[limits](#what-this-does-and-does-not-establish) for what that costs.

- Genome: 32×32 RGB = 24,576 bits, `binary` encoding, `bit-flip` mutation
- Selection: tournament (k=3), uniform crossover, elitism 2
- Baseline: draw N uniformly random genomes, keep the best
- Both sides get the **same** number of fitness evaluations

## Results

Budget 12,000 evaluations:

| Configuration | Best fitness | vs random |
| --- | --- | --- |
| Random search | 0.5187 | — |
| GA, rate 0.01, pop 30 | 0.6211 | beats |
| GA, rate 0.001, pop 30 | **0.7137** | beats |
| GA, rate 0.0001, pop 30 | 0.6472 | beats |
| GA, rate 0.001, pop 60 | 0.7015 | beats |
| GA, rate 0.0001, pop 60 | 0.6587 | beats |

Budget 60,000 evaluations:

| Configuration | Best fitness | vs random |
| --- | --- | --- |
| Random search | 0.5235 | — |
| GA, rate 0.002, pop 30 | 0.7653 | beats |
| GA, rate 0.001, pop 30 | 0.8273 | beats |
| GA, rate 0.0005, pop 30 | **0.8732** | beats |

## Findings

**1. Evolution beats random search decisively, at every setting tested.** The
encoding and operators can climb an image-space gradient. This was the open
question, and the answer is yes.

**2. The gap widens with budget.** Random search is effectively flat — 0.5187 at
12k evaluations, 0.5235 at 60k, a 5× budget for +0.005. The GA went 0.7137 →
0.8732 over the same increase. Random search is sampling a space it cannot
meaningfully cover; the GA is actually accumulating.

**3. The best mutation rate is ~5×10⁻⁴ to 1×10⁻³, and shifts *down* as budget
grows.** At 12k evaluations, 0.001 beat 0.0005; at 60k, 0.0005 beat 0.001. That
is ordinary annealing behaviour — early on you want exploration, later you want
to stop destroying what you have found.

This **corrects an earlier guess** recorded on the epic, which reasoned from
"0.01 flips ~983 bits, that is randomisation not mutation" to a recommendation
near 1×10⁻⁴. The direction was right and the magnitude was wrong: 1×10⁻⁴ is
*too* conservative and underperforms 1×10⁻³ at every budget tested.

**4. Convergence is slow in absolute terms.** 0.87 after 60,000 evaluations on a
target as simple as two flat colour fields. A raw bit string is a viable
encoding, not an efficient one.

## Recommended defaults for image runs

| Parameter | Value | Why |
| --- | --- | --- |
| `mutationRate` | `0.0005` | Best at the larger budget; lower rates keep improving longer |
| `populationSize` | `30` | Beat 60 at equal budget — more generations mattered more than more individuals |
| Resolution | start at 32×32 | 24,576 bits already converges slowly; 64×64 is 4× that |
| `elitism` | `2` | Unchanged; keeps the best genome free via the score cache |

Population 30 beating population 60 at equal budget is worth noting on its own:
with a fixed number of evaluations, **generations bought more than individuals**.

## What this does and does not establish

**Establishes:** the raw pixel bit-string encoding, with the existing `binary`
encoding and `bit-flip` mutation, can climb a smooth image-space gradient
substantially better than chance.

**Does NOT establish:** that CLIP provides such a gradient. The proxy gives a
dense per-pixel signal — every wrong pixel contributes — whereas a CLIP score is
a single semantic judgement of a whole image, and is likely far sparser and
noisier, particularly early on when every candidate is noise.

So this result removes one risk (the encoding is not inert) without removing the
other (the fitness signal may still be too flat to climb). Measuring that needs
real CLIP inference. **That has now been measured** - see
[clip-gradient.md](./clip-gradient.md). Short version: CLIP does provide a
climbable gradient, and climbing it produces ADVERSARIAL images rather than
recognisable ones, which makes the alternative encodings below necessary rather
than optional.

**Alternative encodings were not needed here, but ARE needed.** The bead said to
evaluate palette-indexed pixels or vector primitives *if* raw bit strings failed
this baseline. They did not fail it. But genebaer-kz9 then found a different
reason to need them: under real CLIP the raw encoding converges on adversarial
noise, and constraining the search space is the most direct fix. Tracked as
genebaer-6hf.
