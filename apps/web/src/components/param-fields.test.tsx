import type { JSONSchema } from "@genebaer/shared-types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParamField, defaultsFromSchema, schemaDefault } from "./param-fields";

afterEach(cleanup);

describe("schemaDefault", () => {
  it("prefers an explicitly declared default over any type fallback", () => {
    expect(schemaDefault({ type: "number", default: 5 })).toBe(5);
    expect(schemaDefault({ type: "boolean", default: true })).toBe(true);
    expect(schemaDefault({ type: "string", default: "x", enum: ["a", "b"] })).toBe("x");
  });

  it("has no default for numbers without one — the field stays empty", () => {
    expect(schemaDefault({ type: "number" })).toBeUndefined();
    expect(schemaDefault({ type: "integer" })).toBeUndefined();
  });

  it("falls back to the first enum member for enum strings", () => {
    expect(schemaDefault({ type: "string", enum: ["alpha", "beta"] })).toBe("alpha");
  });

  it("has no default for a free-text string", () => {
    expect(schemaDefault({ type: "string" })).toBeUndefined();
  });

  it("defaults booleans to false, since an absent switch reads as off", () => {
    expect(schemaDefault({ type: "boolean" })).toBe(false);
  });
});

describe("defaultsFromSchema", () => {
  it("omits keys that have no default rather than emitting undefined", () => {
    const schema: Record<string, JSONSchema> = {
      generations: { type: "integer" },
      elitist: { type: "boolean" },
      rate: { type: "number", default: 0.5 },
    };
    const out = defaultsFromSchema(schema);
    expect(out).toEqual({ elitist: false, rate: 0.5 });
    expect("generations" in out).toBe(false);
  });

  it("returns an empty object for an empty schema", () => {
    expect(defaultsFromSchema({})).toEqual({});
  });
});

describe("ParamField rendering", () => {
  it("renders a boolean as a switch reflecting the current value", () => {
    render(
      <ParamField
        name="elitist"
        schema={{ type: "boolean" }}
        value={true}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("switch")).toHaveProperty("ariaChecked", "true");
  });

  it("toggles a boolean to the opposite of its current value", () => {
    const onChange = vi.fn();
    render(
      <ParamField
        name="elitist"
        schema={{ type: "boolean" }}
        value={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("prefers the schema title over the raw param name as the label", () => {
    render(
      <ParamField
        name="swapProbability"
        schema={{ type: "boolean", title: "Swap probability" }}
        value={false}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Swap probability")).toBeDefined();
    expect(screen.queryByText("swapProbability")).toBeNull();
  });

  it("renders an enum string as a select listing every member", () => {
    render(
      <ParamField
        name="mode"
        schema={{ type: "string", enum: ["alpha", "beta", "gamma"] }}
        value="beta"
        onChange={() => {}}
      />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("beta");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("reports the newly selected enum value", () => {
    const onChange = vi.fn();
    render(
      <ParamField
        name="mode"
        schema={{ type: "string", enum: ["alpha", "beta"] }}
        value="alpha"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "beta" } });
    expect(onChange).toHaveBeenCalledWith("beta");
  });

  it("coerces a non-string value to an empty text field instead of crashing", () => {
    render(
      <ParamField
        name="label"
        schema={{ type: "string" }}
        value={undefined}
        onChange={() => {}}
      />,
    );
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
  });
});
