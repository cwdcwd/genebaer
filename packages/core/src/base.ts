import type { JSONSchema } from "@genebaer/shared-types";

/**
 * Base class for every extensible GA component. Concrete operators declare a
 * static `operatorId` and static `paramsSchema`; instances are constructed via
 * `new (params)` by the registry/engine.
 */
export abstract class BaseOperator {
  static readonly operatorId: string = "base";
  static readonly displayName: string = "Base operator";
  static readonly description: string = "";
  /** JSON Schema describing the constructor `params` object. {} = no params. */
  static readonly paramsSchema: Record<string, JSONSchema> = {};

  /** The params this instance was constructed with. */
  readonly params: Record<string, unknown>;

  constructor(params: Record<string, unknown> = {}) {
    this.params = params;
  }
}

/** Constructor type the registry stores. Properties are optional because
 *  `OperatorConstructor` only needs the construct signature at build time. */
export type OperatorConstructor<T extends BaseOperator = BaseOperator> = (new (
  params?: Record<string, unknown>,
) => T) & {
  readonly operatorId: string;
  readonly displayName: string;
  readonly description: string;
  readonly paramsSchema: Record<string, JSONSchema>;
};
