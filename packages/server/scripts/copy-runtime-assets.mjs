/**
 * Copy non-TypeScript runtime assets from src/ into dist/.
 *
 * The worker-thread entry point and its scorers are plain .mjs, because a
 * worker_thread needs a real file to load and a .ts file would only exist
 * after a build. tsc does not copy files it does not compile, so without this
 * step `dist/eval/score-thread.mjs` simply would not exist and spawning a pool
 * thread would fail in production while working perfectly in dev and tests.
 *
 * Exits non-zero if it finds nothing to copy: silently copying zero files is
 * how this breaks again.
 */
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = process.argv[2] ?? join(here, "..", "src");
const distRoot = process.argv[3] ?? join(here, "..", "dist");

/** @returns {Promise<string[]>} absolute paths of every .mjs under a directory */
export async function findAssets(root) {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".mjs")) found.push(full);
    }
  }
  await walk(root);
  return found.sort();
}

export async function copyAssets(src, dist) {
  const assets = await findAssets(src);
  for (const asset of assets) {
    const target = join(dist, relative(src, asset));
    await mkdir(dirname(target), { recursive: true });
    await cp(asset, target);
  }
  return assets;
}

// Only act when run directly, so the functions above stay testable.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const copied = await copyAssets(srcRoot, distRoot);
  if (copied.length === 0) {
    console.error(
      `copy-runtime-assets: found no .mjs under ${srcRoot}. ` +
        `If the worker thread entry moved, update this script — a silent zero-copy ` +
        `breaks the worker pool in production only.`,
    );
    process.exit(1);
  }
  // Sanity: the thread entry must be among them.
  if (!copied.some((p) => p.endsWith("score-thread.mjs"))) {
    console.error("copy-runtime-assets: score-thread.mjs was not copied.");
    process.exit(1);
  }
  await stat(join(distRoot, "eval", "score-thread.mjs"));
  console.log(`copy-runtime-assets: copied ${String(copied.length)} asset(s).`);
}
