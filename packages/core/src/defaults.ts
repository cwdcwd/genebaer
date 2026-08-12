import { OperatorRegistry } from "./registry.js";
import { BinaryEncoding } from "./encodings/binary.js";
import { NumericVectorEncoding } from "./encodings/numeric.js";
import { StringEncoding } from "./encodings/string.js";
import { TournamentSelection } from "./operators/selection/tournament.js";
import { RouletteWheelSelection } from "./operators/selection/roulette.js";
import { RankSelection } from "./operators/selection/rank.js";
import { ElitismSelection } from "./operators/selection/elitism.js";
import {
  OnePointCrossover,
  TwoPointCrossover,
  UniformCrossover,
  ArithmeticCrossover,
} from "./operators/crossover/index.js";
import { BitFlipMutation } from "./operators/mutation/bitflip.js";
import { GaussianMutation } from "./operators/mutation/gaussian.js";
import { SwapMutation } from "./operators/mutation/swap.js";
import { CharMutation } from "./operators/mutation/char.js";
import {
  MaxGenerations,
  TargetFitness,
  Stagnation,
} from "./operators/termination/index.js";
import { OneMax } from "./problems/one-max.js";
import { Sphere, Rastrigin } from "./problems/functions.js";
import { Weasel } from "./problems/weasel.js";
import { MinimumDominatingSet } from "./problems/mds.js";

/** Registry pre-loaded with all built-in encodings, operators, and problems. */
export function createDefaultRegistry(): OperatorRegistry {
  const r = new OperatorRegistry();

  r.register("encoding", BinaryEncoding)
    .register("encoding", NumericVectorEncoding)
    .register("encoding", StringEncoding);

  r.register("selection", TournamentSelection)
    .register("selection", RouletteWheelSelection)
    .register("selection", RankSelection)
    .register("selection", ElitismSelection);

  r.register("crossover", OnePointCrossover)
    .register("crossover", TwoPointCrossover)
    .register("crossover", UniformCrossover)
    .register("crossover", ArithmeticCrossover);

  r.register("mutation", BitFlipMutation)
    .register("mutation", GaussianMutation)
    .register("mutation", SwapMutation)
    .register("mutation", CharMutation);

  r.register("termination", MaxGenerations)
    .register("termination", TargetFitness)
    .register("termination", Stagnation);

  r.register("problem", OneMax)
    .register("problem", Sphere)
    .register("problem", Rastrigin)
    .register("problem", Weasel)
    .register("problem", MinimumDominatingSet);

  return r;
}
