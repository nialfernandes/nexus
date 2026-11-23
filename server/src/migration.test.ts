// Migration 0003 turns today's tables into the blob shape. The server cannot encrypt, so it cannot convert a plain text
// vault: the migration drops the tables that hold paths and texts, and the first device that connects afterwards
// uploads every note again, encrypted. What is not about notes survives: the identities, and the tokens that were given
// out. This builds the database the way an operator's is: migrations 0001 and 0002 applied (and 0004, 0006 and 0007, which only add the
// device key, the sealed approval, the caller and the order to the sign-in tables and which the device approval code needs), a plain vault written with
// the SQL the old store used, an identity and a token made through the real device approval; then 0003 is applied.

import { beforeAll, describe, expect, it } from "vitest";
import { GARDEN_V1 } from "./__fixtures__/device-blobs";
import { API, OWNER_SECRET, bodyOf, freshDatabase, nexusEnv, nexusMigrations } from "./__fixtures__/nexus-world";
import { device, manage, sendAs, vaultAs, type Who } from "./__fixtures__/identity-world";
import type { NexusEnv } from "./plugs/cloudflare/host";

/** What the plain vault held: a path and a text that must be nowhere afterwards. */
const OLD_PATH = "Old plain vault/Secret folder/Private diary.md";
const OLD_TEXT = "Dear diary, the plain text the old server held.\n";

const owner: Who = { cookie: `nexus_owner=${OWNER_SECRET}` };

let env: NexusEnv;
let oldToken: string;

/** Every row of every table, as text, read straight from the database. */
async function dump(db: D1Database): Promise<string> {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all<{ name: string }>();
  const parts: string[] = [];
  for (const { name } of tables.results) parts.push(`${name}: ${JSON.stringify((await db.prepare(`SELECT * FROM "${name}"`).all()).results)}`);
  return parts.join("\n");
}

const tableNames = async (db: D1Database): Promise<string[]> =>
  (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);

const columnsOf = async (db: D1Database, table: string): Promise<string[]> =>
  (await db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all<{ name: string }>()).results.map((r) => r.name);

let db: ReturnType<typeof freshDatabase>;
let before: string;

beforeAll(async () => {
  const migrations = nexusMigrations();
  expect(migrations.length, "0001 to 0004, 0006 and 0007 at least").toBeGreaterThanOrEqual(7);
  db = freshDatabase();
  // The first two migrations: the database as it was before this change. Migrations 0004 (a device's public key and its sealed
  // approval), 0006 (the caller a sign-in was started from) and 0007 (the order it was started in) only add to the sign-in tables, which 0003 never touches, and the
  // device approval the code runs today needs all three, so they are applied here, before 0003, where an operator's database would have
  // had them applied after.
  for (const sql of [migrations[0]!, migrations[1]!, migrations[3]!, migrations[5]!, migrations[6]!]) await db.applyMigration(sql);
  env = { ...(await nexusEnv()), NEXUS_DB: db };

  // A plain vault, written with the statements the old store ran (server/src/store.ts before this change): the note's
  // row with its path, and a version row with the whole text, a short hash and the path again.
  await db.prepare("INSERT INTO nexus_notes (id, path, deleted, head_version, head_at, last_version, clash) VALUES (1, ?, 0, 1, 1700000000000, 1, 0)").bind(OLD_PATH).run();
  await db.prepare(
    `INSERT INTO nexus_versions (note_id, version, seq, path, from_path, kind, body, writer, saved_at, hash, merged, clash, resolves)
     VALUES (1, 1, 1, ?, NULL, 'save', ?, 'owner', 1700000000000, '0123456789abcdef', 0, 0, NULL)`,
  ).bind(OLD_PATH, OLD_TEXT).run();
  await db.prepare("INSERT INTO nexus_identities (name, kind, created_at) VALUES ('agents', 'agent', 1700000000000)").run();
  await db.prepare("INSERT INTO nexus_rights (identity, slot, path, access) VALUES ('agents', 0, 'Secret folder/', 'write')").run();

  // A token that was given out before the change, through the real device approval (it touches only the identity and
  // token tables, which 0003 leaves alone).
  const started = bodyOf(await sendAs("POST", `${API}/device/start`, null, { identity: "agents", label: "before the migration" }, env));
  bodyOf(await device(owner, env).approve(started.code));
  oldToken = bodyOf(await device(null, env).poll(started.secret)).token;

  before = await dump(db);
  await db.applyMigration(migrations[2]);
});

describe("before the migration, the database holds the plain vault", () => {
  it("held the path and the text in plain, so the test is looking for something that was there", () => {
    expect(before).toContain(OLD_PATH);
    expect(before).toContain(OLD_TEXT.trim());
    expect(before).toContain("nexus_rights");
  });
});

describe("migration 0003", () => {
  it("leaves no path and no text anywhere in the database", async () => {
    const after = await dump(db);
    expect(after).not.toContain("Old plain vault");
    expect(after).not.toContain("Private diary");
    expect(after).not.toContain("Secret folder");
    expect(after).not.toContain("plain text the old server held");
  });

  it("drops the rights table, and keeps the identities, tokens and sign-ins tables", async () => {
    const tables = await tableNames(db);
    expect(tables).not.toContain("nexus_rights");
    expect(tables).toEqual(expect.arrayContaining(["nexus_identities", "nexus_tokens", "nexus_signins", "nexus_notes", "nexus_versions", "nexus_wraps"]));
  });

  it("makes the notes and versions tables the blob shape: no path, no text, and no old columns", async () => {
    expect(await columnsOf(db, "nexus_notes")).toEqual(["id", "deleted", "version", "updated_at"]);
    expect(await columnsOf(db, "nexus_versions")).toEqual(["note_id", "version", "seq", "kind", "kid", "blob", "hash", "writer", "saved_at"]);
    expect(await columnsOf(db, "nexus_wraps")).toEqual(["kid", "kind", "wrap", "writer", "saved_at"]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM nexus_notes").first<{ n: number }>())?.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM nexus_versions").first<{ n: number }>())?.n).toBe(0);
  });

  it("keeps the identity and the token: the token given out before still works, and the first device uploads a note", async () => {
    expect((await manage(owner, env).tokens()).status).toBe(200);
    const device = vaultAs({ bearer: oldToken }, env);
    expect(bodyOf(await device.list()).notes).toEqual([]);
    expect(bodyOf(await device.save(GARDEN_V1, 0))).toMatchObject({ result: "saved", id: "n-1", version: 1 });
    expect(bodyOf(await device.note("n-1"))).toMatchObject({ blob: GARDEN_V1.blob, writer: expect.stringMatching(/^device:[0-9a-f]{16}$/) });
    expect(bodyOf(await device.changes()).changes).toHaveLength(1);
  });

  it("has no SQL a Postgres host could not run: it holds nothing of SQLite's own", () => {
    const sql = nexusMigrations()[2];
    expect(sql).not.toMatch(/PRAGMA|AUTOINCREMENT|rowid|INSERT\s+OR/i);
  });
});
