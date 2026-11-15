// The two things this package gives the tests of Nexus: a database wearing the shape of a D1 binding, and the SQL port the
// server's logic runs on. Both have to keep what the real hosts keep, or every test built on them proves less than it says:
// a batch is one transaction, foreign keys are enforced, a row is a plain object and a count is a number.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { memoryD1, sqlOver, statementsOf } from "../src/index.js";

const TABLES = `
  -- A comment line, which a migration may start with.
  CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
  CREATE TABLE versions (note_id INTEGER NOT NULL REFERENCES notes(id), body TEXT NOT NULL);
`;

describe("memoryD1, the stand-in for a D1 binding", () => {
  async function database() {
    const db = memoryD1();
    await db.applyMigration(TABLES);
    return db;
  }

  it("splits a migration into its statements and leaves its comment lines out", () => {
    expect(statementsOf(TABLES)).toEqual([
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL)",
      "CREATE TABLE versions (note_id INTEGER NOT NULL REFERENCES notes(id), body TEXT NOT NULL)",
    ]);
  });

  it("hands a row back as a plain object and a count as a number", async () => {
    const db = await database();
    const written = await db.prepare("INSERT INTO notes (id, title) VALUES (?, ?)").bind(1, "Garden").run();
    expect(written.meta.changes).toBe(1);
    expect(typeof written.meta.changes).toBe("number");
    const row = await db.prepare("SELECT id, title FROM notes WHERE id = ?").bind(1).first<{ id: number; title: string }>();
    expect(row).toEqual({ id: 1, title: "Garden" });
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(await db.prepare("SELECT id FROM notes WHERE id = ?").bind(2).first()).toBeNull();
    const all = await db.prepare("SELECT title FROM notes").all<{ title: string }>();
    expect(all.results).toEqual([{ title: "Garden" }]);
  });

  it("applies a batch as one transaction: when a statement fails, none of the batch stays", async () => {
    const db = await database();
    const insert = (id: number | null) => db.prepare("INSERT INTO notes (id, title) VALUES (?, ?)").bind(id, "Written in a batch");
    await expect(db.batch([insert(1), insert(2), db.prepare("INSERT INTO notes (id, title) VALUES (?, NULL)").bind(3)])).rejects.toThrow();
    expect((await db.prepare("SELECT id FROM notes").all()).results, "the first two were rolled back").toEqual([]);
    const results = await db.batch([insert(1), insert(2)]);
    expect(results.map((r) => r.meta.changes)).toEqual([1, 1]);
    expect((await db.prepare("SELECT id FROM notes ORDER BY id").all()).results).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("enforces foreign keys, as D1 does", async () => {
    const db = await database();
    await expect(db.prepare("INSERT INTO versions (note_id, body) VALUES (?, ?)").bind(99, "no such note").run()).rejects.toThrow(/FOREIGN KEY/i);
  });
});

describe("sqlOver, the server's SQL port over node:sqlite", () => {
  function port() {
    const db = new DatabaseSync(":memory:");
    db.exec(TABLES);
    return { db, sql: sqlOver(db) };
  }

  it("reads and writes with ? placeholders and gives rows as plain objects and counts as numbers", async () => {
    const { sql } = port();
    expect(await sql.run("INSERT INTO notes (id, title) VALUES (?, ?)", [1, "Garden"])).toEqual({ changes: 1 });
    expect(await sql.first("SELECT id, title FROM notes WHERE id = ?", [1])).toEqual({ id: 1, title: "Garden" });
    expect(await sql.first("SELECT id FROM notes WHERE id = ?", [2])).toBeNull();
    expect(await sql.all("SELECT title FROM notes")).toEqual([{ title: "Garden" }]);
    const row = await sql.first<{ id: number }>("SELECT id FROM notes");
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });

  it("binds null, and runs a batch in one transaction: one failing statement undoes the others", async () => {
    const { sql } = port();
    await expect(
      sql.batch([
        { sql: "INSERT INTO notes (id, title) VALUES (?, ?)", params: [1, "Kept only if the batch is"] },
        { sql: "INSERT INTO notes (id, title) VALUES (?, ?)", params: [2, null] },
      ]),
    ).rejects.toThrow();
    expect(await sql.all("SELECT id FROM notes"), "the first statement was rolled back").toEqual([]);
    const results = await sql.batch([{ sql: "INSERT INTO notes (id, title) VALUES (?, ?)", params: [1, "Kept"] }]);
    expect(results).toEqual([{ changes: 1 }]);
    expect(await sql.all("SELECT id FROM notes")).toEqual([{ id: 1 }]);
  });
});
