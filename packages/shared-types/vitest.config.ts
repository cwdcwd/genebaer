import { defineConfig } from "vitest/config";

/**
 * @genebaer/shared-types contains no runtime code — it is pure type
 * declarations. So the meaningful test surface is type-level: `*.test-d.ts`
 * files run through vitest's typecheck mode, asserting the wire contract
 * shared by server and web still holds.
 *
 * `include: []` is deliberate: there are no runtime tests to find, and
 * declaring that explicitly is honest about what this gate does and does not
 * cover.
 */
export default defineConfig({
  test: {
    include: [],
    typecheck: {
      enabled: true,
      include: ["src/**/*.test-d.ts"],
      tsconfig: "./tsconfig.json",
    },
  },
});
