"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  JSONSchema,
  OperatorKind,
  OperatorMeta,
  OperatorRef,
  RunConfig,
} from "@genebaer/shared-types";
import { api } from "@/lib/api";
import { randomSeed } from "@/lib/utils";
import { deletePreset, listPresets, loadPreset, savePreset } from "@/lib/presets";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ParamsForm, defaultsFromSchema } from "@/components/param-fields";

interface OperatorState {
  id: string;
  params: Record<string, unknown>;
}

type OpSelectionState = Record<"selection" | "crossover" | "mutation", OperatorState>;

function refToState(ref: OperatorRef, schema: Record<string, JSONSchema>): OperatorState {
  return {
    id: ref.id,
    params: { ...defaultsFromSchema(schema), ...(ref.params ?? {}) },
  };
}

function compatible(
  meta: OperatorMeta,
  encodingId: string | undefined,
): boolean {
  if (!encodingId) return true;
  if (!meta.compatibleEncodings || meta.compatibleEncodings.length === 0) return true;
  return meta.compatibleEncodings.includes(encodingId);
}

export default function NewExperimentPage() {
  const router = useRouter();
  const [operators, setOperators] = useState<OperatorMeta[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [problem, setProblem] = useState<OperatorState | null>(null);
  const [encoding, setEncoding] = useState<OperatorState | null>(null);
  const [ops, setOps] = useState<OpSelectionState | null>(null);
  const [terminations, setTerminations] = useState<OperatorState[]>([]);

  const [populationSize, setPopulationSize] = useState(100);
  const [mutationRate, setMutationRate] = useState(0.01);
  const [elitism, setElitism] = useState(2);
  const [seed, setSeed] = useState<number>(() => randomSeed());

  const [presetNames, setPresetNames] = useState<string[]>([]);
  const [presetName, setPresetName] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .listOperators()
      .then(setOperators)
      .catch((err) => setLoadError((err as Error).message));
    setPresetNames(listPresets());
  }, []);

  const byKind = useMemo(() => {
    const map = new Map<OperatorKind, OperatorMeta[]>();
    for (const op of operators ?? []) {
      const list = map.get(op.kind) ?? [];
      list.push(op);
      map.set(op.kind, list);
    }
    return map;
  }, [operators]);

  const metaById = useMemo(() => {
    const map = new Map<string, OperatorMeta>();
    for (const op of operators ?? []) map.set(`${op.kind}:${op.id}`, op);
    return map;
  }, [operators]);

  const problems = byKind.get("problem") ?? [];
  const encodings = byKind.get("encoding") ?? [];
  const selections = byKind.get("selection") ?? [];
  const crossovers = byKind.get("crossover") ?? [];
  const mutations = byKind.get("mutation") ?? [];
  const terminationOps = byKind.get("termination") ?? [];

  const problemMeta = problem ? metaById.get(`problem:${problem.id}`) : undefined;
  const encodingMeta = encoding ? metaById.get(`encoding:${encoding.id}`) : undefined;

  const problemEncodings = useMemo(() => {
    if (problemMeta?.compatibleEncodings?.length) {
      const allowed = new Set(problemMeta.compatibleEncodings);
      return encodings.filter((e) => allowed.has(e.id));
    }
    return encodings;
  }, [encodings, problemMeta]);

  const compatibleSelections = selections.filter((s) => compatible(s, encoding?.id));
  const compatibleCrossovers = crossovers.filter((c) => compatible(c, encoding?.id));
  const compatibleMutations = mutations.filter((m) => compatible(m, encoding?.id));
  const compatibleTerminations = terminationOps.filter((t) => compatible(t, encoding?.id));

  const pickOp = useCallback(
    (kind: "selection" | "crossover" | "mutation", candidates: OperatorMeta[], keep?: OperatorState | null): OperatorState | null => {
      if (candidates.length === 0) return null;
      const current = keep?.id ? candidates.find((c) => c.id === keep.id) : undefined;
      const chosen = current ?? candidates[0]!;
      const params =
        keep && chosen.id === keep.id
          ? keep.params
          : defaultsFromSchema(chosen.paramsSchema);
      return { id: chosen.id, params };
    },
    [],
  );

  // Auto-select problem → encoding → operators as metadata and choices change.
  useEffect(() => {
    if (!operators) return;
    if (!problem && problems.length > 0) {
      const first = problems[0]!;
      setProblem({ id: first.id, params: defaultsFromSchema(first.paramsSchema) });
    }
  }, [operators, problem, problems]);

  useEffect(() => {
    if (!problem) return;
    if (problemEncodings.length === 0) {
      setEncoding(null);
      return;
    }
    const current = encoding && problemEncodings.find((e) => e.id === encoding.id);
    if (!current) {
      const first = problemEncodings[0]!;
      setEncoding({ id: first.id, params: defaultsFromSchema(first.paramsSchema) });
    }
  }, [problem, problemEncodings, encoding]);

  useEffect(() => {
    if (!encoding) return;
    setOps((prev) => ({
      selection: pickOp("selection", compatibleSelections, prev?.selection),
      crossover: pickOp("crossover", compatibleCrossovers, prev?.crossover),
      mutation: pickOp("mutation", compatibleMutations, prev?.mutation),
    }) as OpSelectionState);
    setTerminations((prev) => {
      // Keep checked terminations that are still compatible.
      const kept = prev.filter((t) =>
        compatibleTerminations.some((c) => c.id === t.id),
      );
      if (kept.length > 0 || prev.length > 0) return kept;
      // Default: check max-generations (or first available) on initial load.
      const def =
        compatibleTerminations.find((t) => t.id === "max-generations") ??
        compatibleTerminations[0];
      return def
        ? [{ id: def.id, params: defaultsFromSchema(def.paramsSchema) }]
        : [];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoding?.id, compatibleSelections, compatibleCrossovers, compatibleMutations, compatibleTerminations, pickOp]);

  const changeOperator = (
    kind: keyof OpSelectionState,
    candidates: OperatorMeta[],
    id: string,
  ) => {
    const meta = candidates.find((c) => c.id === id);
    if (!meta) return;
    setOps((prev) =>
      prev
        ? { ...prev, [kind]: { id, params: defaultsFromSchema(meta.paramsSchema) } }
        : prev,
    );
  };

  const buildConfig = useCallback((): RunConfig | null => {
    if (!problem || !encoding || !ops?.selection || !ops.crossover || !ops.mutation) {
      return null;
    }
    return {
      problem: { id: problem.id, params: problem.params },
      encoding: { id: encoding.id, params: encoding.params },
      selection: { id: ops.selection.id, params: ops.selection.params },
      crossover: { id: ops.crossover.id, params: ops.crossover.params },
      mutation: { id: ops.mutation.id, params: ops.mutation.params },
      mutationRate,
      populationSize,
      elitism,
      termination: terminations.map((t) => ({ id: t.id, params: t.params })),
      seed,
    };
  }, [problem, encoding, ops, terminations, mutationRate, populationSize, elitism, seed]);

  const startRun = async () => {
    const config = buildConfig();
    if (!config) {
      setSubmitError("Incomplete configuration.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { runId } = await api.createRun(config);
      router.push(`/runs/${runId}`);
    } catch (err) {
      setSubmitError((err as Error).message);
      setSubmitting(false);
    }
  };

  const onLoadPreset = (name: string) => {
    if (!name || !operators) return;
    const config = loadPreset(name);
    if (!config) return;
    const p = metaById.get(`problem:${config.problem.id}`);
    const e = metaById.get(`encoding:${config.encoding.id}`);
    if (p) setProblem(refToState(config.problem, p.paramsSchema));
    if (e) setEncoding(refToState(config.encoding, e.paramsSchema));
    setOps({
      selection: refToState(
        config.selection,
        metaById.get(`selection:${config.selection.id}`)?.paramsSchema ?? {},
      ),
      crossover: refToState(
        config.crossover,
        metaById.get(`crossover:${config.crossover.id}`)?.paramsSchema ?? {},
      ),
      mutation: refToState(
        config.mutation,
        metaById.get(`mutation:${config.mutation.id}`)?.paramsSchema ?? {},
      ),
    });
    setTerminations(
      config.termination.map((t) =>
        refToState(t, metaById.get(`termination:${t.id}`)?.paramsSchema ?? {}),
      ),
    );
    setPopulationSize(config.populationSize);
    setMutationRate(config.mutationRate);
    setElitism(config.elitism);
    setSeed(config.seed);
  };

  if (loadError) {
    return (
      <div className="mx-auto max-w-xl py-16 text-center">
        <h1 className="mb-2 text-lg font-semibold">Cannot reach genebaer server</h1>
        <p className="mono text-sm text-danger">{loadError}</p>
        <p className="mt-2 text-sm text-muted">
          Ensure the backend is running (default port 4040) and reload.
        </p>
      </div>
    );
  }

  if (!operators) {
    return <p className="py-16 text-center text-sm text-muted">Loading operator registry…</p>;
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">New experiment</h1>

        {/* Problem */}
        <Card>
          <CardHeader>
            <CardTitle>1 · Problem</CardTitle>
          </CardHeader>
          <Select
            value={problem?.id ?? ""}
            onChange={(e) => {
              const meta = problems.find((p) => p.id === e.target.value);
              if (meta) {
                setProblem({ id: meta.id, params: defaultsFromSchema(meta.paramsSchema) });
              }
            }}
          >
            {problems.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </Select>
          {problemMeta && (
            <p className="mt-2 text-xs text-muted">{problemMeta.description}</p>
          )}
          {problem && (
            <div className="mt-3">
              <ParamsForm
                paramsSchema={problemMeta?.paramsSchema ?? {}}
                values={problem.params}
                onChange={(params) => setProblem({ ...problem, params })}
              />
            </div>
          )}
        </Card>

        {/* Encoding */}
        <Card>
          <CardHeader>
            <CardTitle>2 · Encoding</CardTitle>
            {problemMeta?.compatibleEncodings?.length ? (
              <span className="text-[10px] text-muted">
                filtered by problem
              </span>
            ) : null}
          </CardHeader>
          <Select
            value={encoding?.id ?? ""}
            onChange={(e) => {
              const meta = problemEncodings.find((en) => en.id === e.target.value);
              if (meta) {
                setEncoding({ id: meta.id, params: defaultsFromSchema(meta.paramsSchema) });
              }
            }}
          >
            {problemEncodings.map((en) => (
              <option key={en.id} value={en.id}>
                {en.displayName}
              </option>
            ))}
          </Select>
          {encodingMeta && (
            <p className="mt-2 text-xs text-muted">{encodingMeta.description}</p>
          )}
          {encoding && Object.keys(encodingMeta?.paramsSchema ?? {}).length > 0 && (
            <div className="mt-3">
              <ParamsForm
                paramsSchema={encodingMeta?.paramsSchema ?? {}}
                values={encoding.params}
                onChange={(params) => setEncoding({ ...encoding, params })}
              />
            </div>
          )}
        </Card>

        {/* Selection / crossover / mutation */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {(
            [
              ["selection", "3 · Selection", selections, compatibleSelections],
              ["crossover", "4 · Crossover", crossovers, compatibleCrossovers],
              ["mutation", "5 · Mutation", mutations, compatibleMutations],
            ] as const
          ).map(([kind, title, all, compat]) => {
            const state = ops?.[kind];
            const meta = state ? metaById.get(`${kind}:${state.id}`) : undefined;
            return (
              <Card key={kind}>
                <CardHeader>
                  <CardTitle>{title}</CardTitle>
                </CardHeader>
                <Select
                  value={state?.id ?? ""}
                  onChange={(e) => changeOperator(kind, compat.length > 0 ? compat : [...all], e.target.value)}
                >
                  {compat.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName}
                    </option>
                  ))}
                </Select>
                {meta && <p className="mt-2 text-xs text-muted">{meta.description}</p>}
                {state && meta && Object.keys(meta.paramsSchema).length > 0 && (
                  <div className="mt-3">
                    <ParamsForm
                      paramsSchema={meta.paramsSchema}
                      values={state.params}
                      onChange={(params) =>
                        setOps((prev) => (prev ? { ...prev, [kind]: { ...state, params } } : prev))
                      }
                    />
                  </div>
                )}
              </Card>
            );
          })}
        </div>

        {/* Termination */}
        <Card>
          <CardHeader>
            <CardTitle>6 · Termination (any condition stops the run)</CardTitle>
          </CardHeader>
          <div className="space-y-3">
            {compatibleTerminations.map((t) => {
              const checked = terminations.some((sel) => sel.id === t.id);
              const state = terminations.find((sel) => sel.id === t.id);
              return (
                <div key={t.id} className="rounded-md border border-border p-3">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        setTerminations((prev) =>
                          e.target.checked
                            ? [...prev, { id: t.id, params: defaultsFromSchema(t.paramsSchema) }]
                            : prev.filter((sel) => sel.id !== t.id),
                        );
                      }}
                      className="h-4 w-4 accent-accent"
                    />
                    <span className="text-sm font-medium">{t.displayName}</span>
                    <span className="text-xs text-muted">— {t.description}</span>
                  </label>
                  {checked && state && Object.keys(t.paramsSchema).length > 0 && (
                    <div className="mt-3 border-l-2 border-border pl-3">
                      <ParamsForm
                        paramsSchema={t.paramsSchema}
                        values={state.params}
                        onChange={(params) =>
                          setTerminations((prev) =>
                            prev.map((sel) => (sel.id === t.id ? { ...sel, params } : sel)),
                          )
                        }
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {compatibleTerminations.length === 0 && (
              <p className="text-xs text-muted">No termination conditions available.</p>
            )}
          </div>
        </Card>
      </div>

      {/* Sidebar: globals + presets + start */}
      <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <Card>
          <CardHeader>
            <CardTitle>Global</CardTitle>
          </CardHeader>
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Population size</span>
              <Input
                type="number"
                min={2}
                step={1}
                value={populationSize}
                onChange={(e) => setPopulationSize(Math.max(2, Math.round(Number(e.target.value) || 2)))}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Mutation rate</span>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.001}
                value={mutationRate}
                onChange={(e) => setMutationRate(Number(e.target.value) || 0)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Elitism</span>
              <Input
                type="number"
                min={0}
                step={1}
                value={elitism}
                onChange={(e) => setElitism(Math.max(0, Math.round(Number(e.target.value) || 0)))}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Seed</span>
              <div className="flex gap-2">
                <Input
                  type="number"
                  step={1}
                  value={seed}
                  onChange={(e) => setSeed(Math.round(Number(e.target.value) || 0))}
                />
                <Button
                  type="button"
                  variant="secondary"
                  title="Randomize seed"
                  onClick={() => setSeed(randomSeed())}
                >
                  🎲
                </Button>
              </div>
            </label>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Presets</CardTitle>
          </CardHeader>
          <Select value="" onChange={(e) => onLoadPreset(e.target.value)}>
            <option value="">Load preset…</option>
            {presetNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <div className="mt-3 flex gap-2">
            <Input
              placeholder="Preset name"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={!presetName.trim()}
              onClick={() => {
                const config = buildConfig();
                if (!config) return;
                savePreset(presetName.trim(), config);
                setPresetNames(listPresets());
                setPresetName("");
              }}
            >
              Save
            </Button>
          </div>
          {presetNames.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {presetNames.map((n) => (
                <button
                  key={n}
                  type="button"
                  title={`Delete preset ${n}`}
                  onClick={() => {
                    deletePreset(n);
                    setPresetNames(listPresets());
                  }}
                  className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted hover:border-danger hover:text-danger"
                >
                  {n} ×
                </button>
              ))}
            </div>
          )}
        </Card>

        {submitError && (
          <p className="mono rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
            {submitError}
          </p>
        )}
        <Button
          type="button"
          size="md"
          className="w-full text-base"
          disabled={submitting || !problem || !encoding || terminations.length === 0}
          onClick={startRun}
        >
          {submitting ? "Starting…" : "Start run →"}
        </Button>
        {terminations.length === 0 && (
          <p className="text-center text-xs text-warn">
            Select at least one termination condition.
          </p>
        )}
      </div>
    </div>
  );
}
