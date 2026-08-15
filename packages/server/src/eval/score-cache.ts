import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface CacheStats {
  hits: number;
  misses: number;
  /** Genomes served from another entry in the SAME batch. */
  dedupedInBatch: number;
}

/**
 * Stable key for "this genome, scored by this exact evaluator".
 *
 * The evaluator identity and params are in the key, not just the genome. The
 * same image scored by clip@1 and clip@2 are different numbers, and two runs
 * targeting different prompts are measuring different things — a key that
 * ignored either would silently serve one run's scores to another and corrupt
 * the comparison with no error anywhere.
 *
 * Params are serialised with sorted keys so that `{a:1,b:2}` and `{b:2,a:1}`
 * — the same configuration written two ways — do not miss each other.
 */
export function scoreKey(
  evaluatorId: string,
  evaluatorVersion: string,
  params: Record<string, unknown>,
  genome: unknown,
): string {
  const payload = JSON.stringify({
    e: `${evaluatorId}@${evaluatorVersion}`,
    p: stableStringify(params),
    g: genome,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export interface ScoreCache {
  get(key: string): number | undefined;
  set(key: string, score: number): void;
  stats(): CacheStats;
  resetStats(): void;
}

/**
 * SQLite-backed score cache.
 *
 * Two jobs at once. It is the largest available speedup, because elitism
 * clones the top N genomes verbatim into every subsequent generation and those
 * identical genomes would otherwise be re-scored forever at full cost. And it
 * is the reproducibility story for this system: model-backed scoring is not
 * deterministic, but a replay of a run that hits cache for every genome
 * produces identical fitness values.
 *
 * It shares the RunStore connection on purpose — the store opens SQLite with
 * `locking_mode = EXCLUSIVE`, so a second connection to the same file would
 * fight it.
 */
export class SqliteScoreCache implements ScoreCache {
  private readonly db: Database.Database;
  private hits = 0;
  private misses = 0;
  private deduped = 0;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS score_cache (
        key TEXT PRIMARY KEY,
        score REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  get(key: string): number | undefined {
    const row = this.db
      .prepare("SELECT score FROM score_cache WHERE key = ?")
      .get(key) as { score: number } | undefined;
    if (row) {
      this.hits += 1;
      return row.score;
    }
    this.misses += 1;
    return undefined;
  }

  set(key: string, score: number): void {
    this.db
      .prepare(
        "INSERT INTO score_cache (key, score, created_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET score = excluded.score",
      )
      .run(key, score, Date.now());
  }

  countDeduped(n: number): void {
    this.deduped += n;
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, dedupedInBatch: this.deduped };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.deduped = 0;
  }

  /** Number of entries held. Useful for tests and observability. */
  size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM score_cache").get() as {
      n: number;
    };
    return row.n;
  }
}

/** In-memory cache, for tests and for running without persistence. */
export class MemoryScoreCache implements ScoreCache {
  private readonly entries = new Map<string, number>();
  private hits = 0;
  private misses = 0;
  private deduped = 0;

  get(key: string): number | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return hit;
  }

  set(key: string, score: number): void {
    this.entries.set(key, score);
  }

  countDeduped(n: number): void {
    this.deduped += n;
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, dedupedInBatch: this.deduped };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.deduped = 0;
  }

  size(): number {
    return this.entries.size;
  }
}

let activeCache: (ScoreCache & { countDeduped?: (n: number) => void }) | null = null;

export function setActiveScoreCache(
  cache: (ScoreCache & { countDeduped?: (n: number) => void }) | null,
): void {
  activeCache = cache;
}

export function getActiveScoreCache():
  | (ScoreCache & { countDeduped?: (n: number) => void })
  | null {
  return activeCache;
}
