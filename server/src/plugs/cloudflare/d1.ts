// The SQL plug for Cloudflare D1. One of the few files that names a Cloudflare type.

import type { RunResult, SqlDb, SqlStatement, SqlValue } from "../../ports";

export function d1Sql(db: D1Database): SqlDb {
  const prepared = (sql: string, params: readonly SqlValue[]) => db.prepare(sql).bind(...params);
  return {
    async first<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
      return (await prepared(sql, params).first<T>()) ?? null;
    },
    async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
      const { results } = await prepared(sql, params).all<T>();
      return results ?? [];
    },
    async run(sql: string, params: readonly SqlValue[] = []): Promise<RunResult> {
      const result = await prepared(sql, params).run();
      return { changes: result.meta?.changes ?? 0 };
    },
    // D1 runs a batch as one transaction: if a statement fails, the others are rolled back.
    async batch(statements: readonly SqlStatement[]): Promise<RunResult[]> {
      if (statements.length === 0) return [];
      const results = await db.batch(statements.map((s) => prepared(s.sql, s.params)));
      return results.map((r) => ({ changes: r.meta?.changes ?? 0 }));
    },
  };
}
