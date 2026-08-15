import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  GenerationStats,
  RunConfig,
  RunDetail,
  RunStatus,
  RunSummary,
} from "@genebaer/shared-types";

export interface RunRow {
  id: string;
  config_json: string;
  status: string;
  created_at: number;
  finished_at: number | null;
  final_best_fitness: number | null;
  current_generation: number;
  /** Null on rows written before this column existed, and while a run is live. */
  stop_reason: string | null;
}

export interface GenerationRow {
  run_id: string;
  generation: number;
  best: number;
  mean: number;
  median: number;
  worst: number;
  std_dev: number;
  diversity: number;
  best_genome_json: string;
  elapsed_ms: number;
}

/**
 * SQLite persistence for runs + per-generation stats.
 * macOS guardrails (applied regardless of disk type, per project memory):
 *   - journal_mode = MEMORY: no -wal/-shm journal files on disk
 *   - locking_mode = EXCLUSIVE: single-writer, no lock contention
 */
export class RunStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = MEMORY");
    this.db.pragma("locking_mode = EXCLUSIVE");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        final_best_fitness REAL,
        current_generation INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS generations (
        run_id TEXT NOT NULL REFERENCES runs(id),
        generation INTEGER NOT NULL,
        best REAL NOT NULL,
        mean REAL NOT NULL,
        median REAL NOT NULL,
        worst REAL NOT NULL,
        std_dev REAL NOT NULL,
        diversity REAL NOT NULL,
        best_genome_json TEXT NOT NULL,
        elapsed_ms REAL NOT NULL,
        PRIMARY KEY (run_id, generation)
      );
      CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
    `);

    // CREATE TABLE IF NOT EXISTS does not add columns to an existing database,
    // so new columns need an explicit guarded ALTER.
    this.addColumnIfMissing("runs", "stop_reason", "TEXT");
  }

  private addColumnIfMissing(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  private readonly insertRunStmt = () =>
    this.db.prepare(`
      INSERT INTO runs (id, config_json, status, created_at, current_generation)
      VALUES (?, ?, ?, ?, 0)
    `);

  private readonly insertGenStmt = () =>
    this.db.prepare(`
      INSERT OR REPLACE INTO generations
        (run_id, generation, best, mean, median, worst, std_dev, diversity, best_genome_json, elapsed_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

  createRun(id: string, config: RunConfig): void {
    this.insertRunStmt().run(id, JSON.stringify(config), "pending", Date.now());
  }

  /**
   * Set a run's status, optionally recording why.
   *
   * `stop_reason` doubles as the reason a run is *currently* paused, not only
   * why it ended. Passing null clears it — a run that resumes should not keep
   * explaining a condition that no longer holds.
   */
  setStatus(id: string, status: RunStatus, reason?: string | null): void {
    if (reason === undefined) {
      this.db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, id);
      return;
    }
    this.db
      .prepare("UPDATE runs SET status = ?, stop_reason = ? WHERE id = ?")
      .run(status, reason, id);
  }

  /**
   * Record a run reaching a terminal status.
   *
   * `status` is passed in rather than hardcoded to 'finished' because a run
   * stopped by the user is not a run that finished — writing 'finished' for
   * both made a stopped run read as completed once its engine was gone.
   */
  markTerminal(
    id: string,
    status: RunStatus,
    finalBestFitness: number | null,
    reason: string,
  ): void {
    this.db
      .prepare(
        "UPDATE runs SET status = ?, finished_at = ?, final_best_fitness = ?, stop_reason = ? WHERE id = ?",
      )
      .run(status, Date.now(), finalBestFitness, reason, id);
  }

  /**
   * Reconcile runs left mid-flight by a process that died.
   *
   * Engines live only in memory, so on a fresh process no run can still be
   * executing — yet its row may still read 'pending'/'running'/'paused'. Left
   * alone, the UI shows a live run that nothing is driving and every control
   * call 404s. Anything non-terminal is therefore closed out as 'stopped'.
   *
   * Returns the ids it reconciled. Must run before any new run is created.
   */
  reconcileInterruptedRuns(reason: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM runs WHERE status IN ('pending', 'running', 'paused')",
      )
      .all() as Array<{ id: string }>;

    const lastBest = this.db.prepare(
      "SELECT best FROM generations WHERE run_id = ? ORDER BY generation DESC LIMIT 1",
    );
    const tx = this.db.transaction((ids: readonly string[]) => {
      for (const id of ids) {
        const row = lastBest.get(id) as { best: number } | undefined;
        this.markTerminal(id, "stopped", row?.best ?? null, reason);
      }
    });
    const ids = rows.map((r) => r.id);
    tx(ids);
    return ids;
  }

  updateGeneration(id: string, generation: number): void {
    this.db
      .prepare("UPDATE runs SET current_generation = ? WHERE id = ?")
      .run(generation, id);
  }

  /** Batch-insert generation stats inside a transaction. */
  writeGenerations(id: string, stats: readonly GenerationStats[]): void {
    const stmt = this.insertGenStmt();
    const tx = this.db.transaction((rows: readonly GenerationStats[]) => {
      for (const s of rows) {
        stmt.run(
          id,
          s.generation,
          s.bestFitness,
          s.meanFitness,
          s.medianFitness,
          s.worstFitness,
          s.stdDev,
          s.diversity,
          JSON.stringify(s.bestGenome ?? null),
          s.elapsedMs,
        );
      }
    });
    tx(stats);
  }

  getRun(id: string): RunDetail | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(id) as RunRow | undefined;
    if (!row) return null;
    const statsRows = this.db
      .prepare("SELECT * FROM generations WHERE run_id = ? ORDER BY generation ASC")
      .all(id) as unknown as GenerationRow[];
    return {
      ...rowToSummary(row),
      stats: statsRows.map(rowToStats),
    };
  }

  listRuns(): RunSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM runs ORDER BY created_at DESC")
      .all() as unknown as RunRow[];
    return rows.map(rowToSummary);
  }

  deleteRun(id: string): boolean {
    const info = this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
    return info.changes > 0;
  }

  /**
   * The underlying connection, so collaborators such as the score cache can
   * share it. RunStore opens SQLite with locking_mode = EXCLUSIVE, so opening
   * a second connection to the same file would contend with this one.
   */
  get database(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

function rowToSummary(r: RunRow): RunSummary {
  const summary: RunSummary = {
    id: r.id,
    status: r.status as RunStatus,
    config: JSON.parse(r.config_json) as RunConfig,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    finalBestFitness: r.final_best_fitness,
    currentGeneration: r.current_generation,
  };
  // exactOptionalPropertyTypes: assign the key only when there is a value,
  // rather than setting it to undefined.
  if (r.stop_reason !== null && r.stop_reason !== undefined) {
    summary.stopReason = r.stop_reason;
  }
  return summary;
}

function rowToStats(r: GenerationRow): GenerationStats {
  return {
    generation: r.generation,
    bestFitness: r.best,
    meanFitness: r.mean,
    medianFitness: r.median,
    worstFitness: r.worst,
    stdDev: r.std_dev,
    diversity: r.diversity,
    bestGenome: JSON.parse(r.best_genome_json),
    elapsedMs: r.elapsed_ms,
  };
}
