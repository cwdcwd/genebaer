"use client";

import type { JSONSchema } from "@genebaer/shared-types";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

/** Extract a default value declared in a JSON Schema, if any. */
export function schemaDefault(schema: JSONSchema): unknown {
  if ("default" in schema && schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case "number":
    case "integer":
      return undefined;
    case "string":
      return schema.enum?.[0];
    case "boolean":
      return false;
    default:
      return undefined;
  }
}

/** Populate an entire params object from its schema defaults. */
export function defaultsFromSchema(
  paramsSchema: Record<string, JSONSchema>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(paramsSchema)) {
    const def = schemaDefault(schema);
    if (def !== undefined) out[key] = def;
  }
  return out;
}

/**
 * Auto-generated form field for one JSON Schema param.
 * number/integer → numeric input, string → text or select (enum), boolean → switch.
 */
export function ParamField({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: JSONSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = schema.title ?? name;
  const description = schema.description;

  if (schema.type === "boolean") {
    return (
      <label className="flex cursor-pointer items-center justify-between gap-3 py-1">
        <span className="text-xs text-muted" title={description}>
          {label}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(value)}
          onClick={() => onChange(!value)}
          className={`relative h-5 w-9 rounded-full transition-colors ${
            value ? "bg-accent" : "bg-border"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
              value ? "translate-x-4.5" : "translate-x-0.5"
            }`}
          />
        </button>
      </label>
    );
  }

  if (schema.type === "string") {
    if (schema.enum) {
      return (
        <label className="block">
          <span className="mb-1 block text-xs text-muted" title={description}>
            {label}
          </span>
          <Select
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          >
            {schema.enum.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </Select>
        </label>
      );
    }
    return (
      <label className="block">
        <span className="mb-1 block text-xs text-muted" title={description}>
          {label}
        </span>
        <Input
          type="text"
          value={typeof value === "string" ? value : ""}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  }

  if (schema.type === "number" || schema.type === "integer") {
    const step = schema.type === "integer" ? 1 : "any";
    return (
      <label className="block">
        <span className="mb-1 block text-xs text-muted" title={description}>
          {label}
        </span>
        <Input
          type="number"
          value={typeof value === "number" && Number.isFinite(value) ? value : ""}
          min={schema.minimum}
          max={schema.maximum}
          step={step}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(undefined);
              return;
            }
            const num = Number(raw);
            onChange(schema.type === "integer" ? Math.round(num) : num);
          }}
        />
      </label>
    );
  }

  return null;
}

/** Render all param fields for an operator's paramsSchema. */
export function ParamsForm({
  paramsSchema,
  values,
  onChange,
}: {
  paramsSchema: Record<string, JSONSchema>;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
}) {
  const entries = Object.entries(paramsSchema);
  if (entries.length === 0) {
    return <p className="text-xs text-muted/60">No parameters.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {entries.map(([key, schema]) => (
        <ParamField
          key={key}
          name={key}
          schema={schema}
          value={values[key]}
          onChange={(v) => {
            const next = { ...values };
            if (v === undefined) delete next[key];
            else next[key] = v;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}
