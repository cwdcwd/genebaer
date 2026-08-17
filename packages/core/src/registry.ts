import type { OperatorKind, OperatorMeta } from "@genebaer/shared-types";
import type { BaseOperator, OperatorConstructor } from "./base.js";

/**
 * Central registry: maps (kind, id) → operator class. The engine resolves a
 * declarative RunConfig through a registry, and the server serves
 * `listMetadata()` to the UI so forms can be auto-generated.
 */
export class OperatorRegistry {
  private readonly table = new Map<OperatorKind, Map<string, OperatorConstructor>>();

  register(kind: OperatorKind, ctor: OperatorConstructor): this {
    let byKind = this.table.get(kind);
    if (!byKind) {
      byKind = new Map();
      this.table.set(kind, byKind);
    }
    const id = ctor.operatorId;
    if (byKind.has(id)) {
      throw new Error(`OperatorRegistry: duplicate id '${id}' for kind '${kind}'`);
    }
    byKind.set(id, ctor);
    return this;
  }

  has(kind: OperatorKind, id: string): boolean {
    return this.table.get(kind)?.has(id) ?? false;
  }

  resolve(kind: OperatorKind, id: string): OperatorConstructor {
    const ctor = this.table.get(kind)?.get(id);
    if (!ctor) {
      throw new Error(`Unknown ${kind} operator id '${id}'`);
    }
    return ctor;
  }

  /** Instantiate an operator by (kind, id). */
  create<T extends BaseOperator>(
    kind: OperatorKind,
    id: string,
    params?: Record<string, unknown>,
  ): T {
    const ctor = this.resolve(kind, id);
    return new ctor(params) as T;
  }

  listMetadata(kind?: OperatorKind): OperatorMeta[] {
    const out: OperatorMeta[] = [];
    for (const [k, byId] of this.table) {
      if (kind && k !== kind) continue;
      for (const ctor of byId.values()) {
        const meta: OperatorMeta = {
          id: ctor.operatorId,
          kind: k,
          displayName: ctor.displayName,
          description: ctor.description,
          paramsSchema: ctor.paramsSchema,
        };
        const compat = (ctor as OperatorConstructor & {
          compatibleEncodings?: readonly string[];
        }).compatibleEncodings;
        if (compat && compat.length > 0) meta.compatibleEncodings = [...compat];
        // Evaluators carry a contract version; nothing else does. Surfacing it
        // here is what allows a remote worker to register with the version the
        // server wants rather than one hardcoded at build time.
        const version = (ctor as OperatorConstructor & { version?: unknown }).version;
        if (typeof version === "string" && version.length > 0) meta.version = version;
        // Encodings name the param that sets genome size, so a client can size
        // one to a problem without hardcoding which key that is per encoding.
        const sizeParam = (ctor as OperatorConstructor & { sizeParam?: unknown }).sizeParam;
        if (typeof sizeParam === "string" && sizeParam.length > 0) {
          meta.sizeParam = sizeParam;
        }
        // Published only when they differ from the ordinary case, so the
        // metadata stays quiet for the problems and evaluators that pair fine.
        const scorable = (ctor as OperatorConstructor & {
          scorableInProcess?: unknown;
        }).scorableInProcess;
        if (scorable === false) meta.scorableInProcess = false;
        const scores = (ctor as OperatorConstructor & { scoresInProcess?: unknown })
          .scoresInProcess;
        if (scores === true) meta.scoresInProcess = true;

        out.push(meta);
      }
    }
    return out;
  }

  ids(kind: OperatorKind): string[] {
    return [...(this.table.get(kind)?.keys() ?? [])];
  }

  /** Shallow-clone: new registry with the same entries (safe to extend). */
  clone(): OperatorRegistry {
    const r = new OperatorRegistry();
    for (const [k, byId] of this.table) {
      for (const ctor of byId.values()) r.register(k, ctor);
    }
    return r;
  }
}
