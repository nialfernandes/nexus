// The SQL port of the Nexus server (SqlDb in server/src/ports.ts), over an in-memory SQLite database (node:sqlite). The
// plugin's tests run the server's own code over it; so can any test that wants the server without a Cloudflare runtime.
//
// The types here are the port's, written out again because this package may not depend on the server (the server's tests
// depend on this package). They are structural: a value of this `SqlDb` is accepted wherever the server asks for its own,
// and the plugin's type check says so every time it builds a host from one.
//
// The contract it keeps (server/src/ports.ts): `?` placeholders, a batch is ONE TRANSACTION, a row is a plain object keyed
// by column name, and a count is a JS number.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params: readonly SqlValue[];
}

export interface RunResult {
  /** Rows the statement inserted, updated or deleted. */
  changes: number;
}

export interface SqlDb {
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult>;
  batch(statements: readonly SqlStatement[]): Promise<RunResult[]>;
}

/** The SQL port over `db`. */
export function sqlOver(db: DatabaseSync): SqlDb {
  const params = (values: readonly SqlValue[]): SQLInputValue[] => [...values];
  const runOne = (sql: string, values: readonly SqlValue[]): RunResult => ({ changes: Number(db.prepare(sql).run(...params(values)).changes) });
  return {
    async first<T>(sql: string, values: readonly SqlValue[] = []): Promise<T | null> {
      const row = db.prepare(sql).get(...params(values));
      return row === undefined ? null : ({ ...row } as T);
    },
    async all<T>(sql: string, values: readonly SqlValue[] = []): Promise<T[]> {
      return db.prepare(sql).all(...params(values)).map((row) => ({ ...row }) as T);
    },
    async run(sql: string, values: readonly SqlValue[] = []): Promise<RunResult> {
      return runOne(sql, values);
    },
    // One transaction: every statement is applied or none is.
    async batch(statements: readonly SqlStatement[]): Promise<RunResult[]> {
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => runOne(s.sql, s.params));
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
