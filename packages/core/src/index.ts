export type {
  JSONSchema,
  OperatorKind,
  OperatorMeta,
  OperatorRef,
  RunConfig,
  RunStatus,
  RunSummary,
  RunDetail,
  GenerationStats,
  CreateRunRequest,
  CreateRunResponse,
  RunControlAction,
  RunControlRequest,
  WsServerMessage,
  WsClientMessage,
} from "@genebaer/shared-types";

export { BaseOperator, type OperatorConstructor } from "./base.js";
export { Encoding } from "./encoding.js";
export { BinaryEncoding } from "./encodings/binary.js";
export { NumericVectorEncoding } from "./encodings/numeric.js";
export { StringEncoding } from "./encodings/string.js";

export { SelectionOperator } from "./operators/selection/base.js";
export { TournamentSelection } from "./operators/selection/tournament.js";
export { RouletteWheelSelection } from "./operators/selection/roulette.js";
export { RankSelection } from "./operators/selection/rank.js";
export { ElitismSelection } from "./operators/selection/elitism.js";

export { CrossoverOperator } from "./operators/crossover/base.js";
export {
  OnePointCrossover,
  TwoPointCrossover,
  UniformCrossover,
  ArithmeticCrossover,
} from "./operators/crossover/index.js";

export { MutationOperator } from "./operators/mutation/base.js";
export { BitFlipMutation } from "./operators/mutation/bitflip.js";
export { GaussianMutation } from "./operators/mutation/gaussian.js";
export { SwapMutation } from "./operators/mutation/swap.js";
export { CharMutation } from "./operators/mutation/char.js";

export {
  TerminationCondition,
  MaxGenerations,
  TargetFitness,
  Stagnation,
} from "./operators/termination/index.js";

export {
  FitnessProblem,
  type VisualFrame,
} from "./operators/problem/base.js";
export { OneMax } from "./problems/one-max.js";
export { Sphere, Rastrigin } from "./problems/functions.js";
export { Weasel } from "./problems/weasel.js";
export {
  MinimumDominatingSet,
  petersenGraph,
  cycleGraph,
  type MdsGraph,
} from "./problems/mds.js";

export {
  OperatorRegistry,
} from "./registry.js";
export { createDefaultRegistry } from "./defaults.js";
export {
  GeneticAlgorithmEngine,
  type EngineEvents,
} from "./engine.js";
export {
  SeededRandomSource,
  type RandomSource,
  paramWithDefault,
  numberParam,
  stringParam,
} from "./random.js";
