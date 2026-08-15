import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copyAssets, findAssets } from "../../scripts/copy-runtime-assets.mjs";

const srcRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The worker pool loads its thread entry as a real file at runtime. tsc does
 * not copy files it does not compile, so without the copy step
 * dist/eval/score-thread.mjs would simply not exist — and the pool would work
 * perfectly in dev and in these tests while failing only in production. This
 * suite is the guard for that specific asymmetry.
 */
describe("runtime assets", () => {
  it("the thread entry sits where the pool resolves it", () => {
    const entry = fileURLToPath(new URL("./score-thread.mjs", import.meta.url));
    expect(existsSync(entry)).toBe(true);
  });

  it("finds every .mjs the build must carry across", async () => {
    const assets = await findAssets(srcRoot);
    const names = assets.map((p) => p.split("/").pop());
    expect(names).toContain("score-thread.mjs");
    expect(names).toContain("scorers.mjs");
  });

  it("copies them preserving directory structure", async () => {
    const dest = await mkdtemp(join(tmpdir(), "genebaer-assets-"));
    try {
      const copied = await copyAssets(srcRoot, dest);
      expect(copied.length).toBeGreaterThan(0);
      // Structure matters: the pool resolves ./score-thread.mjs relative to the
      // compiled worker-pool.js, so a flattened copy would not be found.
      expect(existsSync(join(dest, "eval", "score-thread.mjs"))).toBe(true);
      expect(existsSync(join(dest, "eval", "scorers.mjs"))).toBe(true);
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });

  it("copies nothing from a directory with no assets, so a miss is detectable", async () => {
    const empty = await mkdtemp(join(tmpdir(), "genebaer-empty-"));
    const dest = await mkdtemp(join(tmpdir(), "genebaer-dest-"));
    try {
      const copied = await copyAssets(empty, dest);
      expect(copied).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });
});
