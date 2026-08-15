/**
 * Types for the plain-ESM asset copier.
 *
 * The script itself is .mjs because it runs during the build with no
 * compilation step, but its callers — and its tests — deserve real types.
 */

/** Absolute paths of every .mjs beneath `root`, sorted. */
export declare function findAssets(root: string): Promise<string[]>;

/** Copy every .mjs from `src` into `dist`, preserving structure. */
export declare function copyAssets(src: string, dist: string): Promise<string[]>;
