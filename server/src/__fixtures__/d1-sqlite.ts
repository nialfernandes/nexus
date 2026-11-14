// A stand-in for a Cloudflare D1 binding, made from an in-memory SQLite database (node:sqlite), so Nexus's tests
// run on a plain machine and need no Cloudflare runtime. It speaks only the part of the D1 API that the Cloudflare
// plug uses (plugs/cloudflare/d1.ts): prepare, bind, first, all, run and batch.
//
// It keeps D1's two behaviours that Nexus relies on:
//   - a batch is ONE TRANSACTION: every statement is applied or none is (a failure rolls the whole batch back);
//   - foreign keys are enforced, as D1 enforces them.
// A row comes back as a plain object keyed by column name and a count as a JS number, the same as D1 gives.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

interface Meta { changes: number }

/** One statement, with the values bound to it so far. Nothing runs until first, all or run is called. */
class Prepared {
  constructor(private readonly db: DatabaseSync, readonly sql: string, private readonly params: SQLInputValue[] = []) {}

  bind(...params: SQLInputValue[]): Prepared {
    return new Prepared(this.db, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : ({ ...row } as T);
  }

  async all<T>(): Promise<{ results: T[]; meta: Meta }> {
    const rows = this.db.prepare(this.sql).all(...this.params);
    return { results: rows.map((row) => ({ ...row }) as T), meta: { changes: 0 } };
  }

  async run(): Promise<{ meta: Meta }> {
    return this.runNow();
  }

  /** Runs the statement at once, without waiting: a batch needs every statement to run with no gap between them. */
  runNow(): { meta: Meta } {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(result.changes) } };
  }
}

/** The shape of a D1 binding that the tests use, plus `applyMigration` for building the tables. */
export interface MemoryD1 {
  prepare(sql: string): Prepared;
  batch(statements: Prepared[]): Promise<Array<{ meta: Meta }>>;
  /** Runs a migration file: its comment lines out, then one statement for each `;`. */
  applyMigration(sql: string): Promise<void>;
}

/** The statements of a migration file: comment lines out, then one for each `;`. A migration holds no `;` inside a literal or a comment. */
export function statementsOf(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function memoryD1(): D1Database & MemoryD1 {
  const db = new DatabaseSync(":memory:");
  const world: MemoryD1 = {
    prepare: (sql) => new Prepared(db, sql),
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => s.runNow());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async applyMigration(sql) {
      for (const statement of statementsOf(sql)) db.exec(statement);
    },
  };
  return world as unknown as D1Database & MemoryD1;
}
