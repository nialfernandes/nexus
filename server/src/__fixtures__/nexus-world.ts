// A world for Nexus's tests: the Nexus Worker as the Cloudflare plug builds it (plugs/cloudflare/worker.ts), the owner's
// sign-in, and Nexus's own database.
//
// Nothing here knows how Nexus is built. Every test asks the Worker a question over HTTP and reads the answer, so the
// logic behind the routes is free to be shaped as it likes (ports, a SQL plug, a clock). What the tests do fix is the
// wire contract below, because the routes and their answers are what the devices that sync notes will call.
//
// WHERE THINGS COME FROM
//   - The database: an in-memory SQLite (node:sqlite) wearing the shape of a D1 binding (d1-sqlite.ts), with the real
//     migration files in migrations/ applied in name order, the way `wrangler d1 migrations apply` would. No file name
//     is assumed. The statements are split at `;`, so a migration holds no `;` inside a literal, a trigger or a
//     comment.
//   - The owner: the Worker is given NEXUS_OWNER and NEXUS_OWNER_SECRET like a real one, and the owner's session is
//     the cookie the real plug reads (`nexus_owner`). A stranger is a cookie with the wrong secret. Nothing is planted
//     in a table: sign-in reads no table.
//   - The identities `agents` and `recorder` are made the way an operator makes them: the owner calls POST identity
//     through the real route. The migrations seed nothing.
//   - The notes are the encrypted blobs in device-blobs.ts, made by the real @nexus/crypto. The server never opens them.
//   - The static page (the approval page) comes from public/ through a stand-in for Cloudflare's asset server
//     (assets.ts), which the Worker is handed as ASSETS.
//
// THE WIRE CONTRACT (every answer is JSON; a refusal is `{ error: "<plain words>" }`)
//
//   Every route is under /nexus/api (and, for one release, /apps/nexus/api: see prefixes.test.ts). A note is named by
//   its id, which the device chose at random: 1 to 128 letters, digits, hyphens or underscores. It is never a path.
//   A blob and a wrap are standard base64 of bytes the server cannot read.
//
//   POST /save      { id, base, kid, blob }
//       200 { result: "saved", id, version }          `base` is the version the save starts from, 0 for a new note
//       409 { error, current }                        the note is at version `current` (0 when there is no such note)
//       400 a missing or wrong field, or a field that is not one of these four   413 a blob over the limit
//   GET  /note      ?id=I[&version=N]
//       200 { id, version, kind, kid, blob, hash, writer, at }     (latest, or the version asked for)
//       404 no such note or version, and the latest of a deleted note
//   GET  /history   ?id=I
//       200 { id, versions: [ { version, kind, kid, writer, at, hash } ] }   (oldest first, no blobs)
//   GET  /list
//       200 { notes: [ { id, version, at, kid, hash } ] }          (every live note)
//   GET  /changes   [?after=CURSOR][&limit=N]
//       200 { changes: [ { id, version, kind, kid, writer, at, hash, blob } ], next }    (a delete has no blob)
//   POST /delete    { id, base }
//       200 { result: "deleted", id, version }
//       404 no such note   409 { error, current } the note is at another version
//   GET  /wraps
//       200 { wraps: [ { kid, kind, wrap, writer, at } ] }
//
//   `kind` is "save" or "delete". `hash` is SHA-256 of the blob, 64 lower case hex characters. `at` is unix
//   milliseconds. `writer` is the name of the identity that wrote the version ("owner", "agents", "recorder", ...).
//   A version number counts every version of the note, a delete included, from 1.
//   Without the owner's sign-in or an identity's bearer token every route answers 401 (not a redirect, not a 404). How a
//   token is got, and the routes only the owner may call, are in identity-world.ts.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { NexusEnv } from "../plugs/cloudflare/host";
import worker from "../plugs/cloudflare/worker";
import { staticAssets } from "./assets";
import { memoryD1 } from "./d1-sqlite";

/** The address the tests call Nexus on. */
export const ORIGIN = "https://nexus.example.test";

/** The name of the owner's identity, as the Worker's NEXUS_OWNER setting gives it. */
export const OWNER = "owner";

/** The owner's secret, as the Worker's NEXUS_OWNER_SECRET gives it. It is for the tests only: no host uses it. */
export const OWNER_SECRET = "owner-secret-used-by-the-tests-only".padEnd(64, "x");

/** A session cookie for someone who does not hold the owner's secret. */
const STRANGER_COOKIE = `nexus_owner=${"b".repeat(64)}`;

export const API = "/nexus/api";

export interface Answer {
  status: number;
  /** The parsed JSON, or null when the answer was not JSON (a page, a redirect). */
  body: any;
  text: string;
  location: string | null;
}

/** A person who is signed in, as the cookie their browser sends. */
export interface Account { cookie: string }

const MIGRATIONS = join(import.meta.dirname, "../../migrations");

/** The SQL of Nexus's migrations in the order they are applied. */
export function nexusMigrations(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(join(MIGRATIONS, name), "utf8"));
}

/** What the Worker is handed, for the file that is running: set by setUpNexus. */
let current: NexusEnv | undefined;

/** The Worker's own bindings and variables, as the tests run it. */
export function appEnv(): NexusEnv {
  expect(current, "setUpNexus ran first").toBeDefined();
  return current!;
}

/** Nexus's own database as the Worker is handed it. */
export const nexusDb = (): D1Database | undefined => current?.NEXUS_DB;

/** What an operator makes first: the identities the tests use, called through the real route as the owner. */
const STARTING_IDENTITIES = [
  { name: "agents", kind: "agent" },
  { name: "recorder", kind: "app" },
];

/** A fresh database with the migrations applied, and a Worker's variables pointing at it. `settings` change or take away what the Worker is told. */
export async function nexusEnv(settings: Partial<NexusEnv> = {}): Promise<NexusEnv> {
  const db = memoryD1();
  for (const sql of nexusMigrations()) await db.applyMigration(sql);
  return {
    NEXUS_DB: db,
    NEXUS_OWNER: OWNER,
    NEXUS_OWNER_SECRET: OWNER_SECRET,
    ASSETS: staticAssets(),
    ...settings,
  };
}

/** A fresh world and the starting identities made in it. Once per test file. */
export async function setUpNexus(): Promise<void> {
  current = await nexusEnv();
  const owner = (await signInOwner()).cookie;
  for (const identity of STARTING_IDENTITIES) {
    expect((await send("POST", `${API}/identity`, owner, identity)).status, `making ${identity.name}`).toBe(200);
  }
}

/** The owner, signed in: the cookie their browser sends. */
export const signInOwner = async (): Promise<Account> => ({ cookie: `nexus_owner=${OWNER_SECRET}` });

/** Someone who is signed in as nobody Nexus knows: a cookie that does not hold the owner's secret. */
export const signInStranger = async (): Promise<Account> => ({ cookie: STRANGER_COOKIE });

/** One request through the Worker, as the person holding `cookie` (or nobody). */
export async function send(
  method: string, path: string, cookie: string | null, body?: unknown, env: NexusEnv = appEnv(),
): Promise<Answer> {
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    }),
    env,
  );
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON: a page or a redirect */ }
  return { status: res.status, body: parsed, text, location: res.headers.get("location") };
}

const query = (params: Record<string, string | number | undefined>): string => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) q.set(key, String(value));
  const text = q.toString();
  return text ? `?${text}` : "";
};

/** A note as a device sends it: an id and the base64 of its encrypted blob (device-blobs.ts holds some). */
export interface Sent { id: string; blob: string }

/** The key number every blob in device-blobs.ts is under. */
const DEFAULT_KID = 1;

/** The routes, called as the person holding `cookie`. */
export function vault(cookie: string | null, env?: Record<string, unknown>) {
  const get = (route: string, params: Record<string, string | number | undefined>) =>
    send("GET", `${API}/${route}${query(params)}`, cookie, undefined, env);
  const post = (route: string, body: unknown) => send("POST", `${API}/${route}`, cookie, body, env);
  return {
    save: (note: Sent, base: number, kid = DEFAULT_KID) => post("save", { id: note.id, base, kid, blob: note.blob }),
    note: (id: string, version?: number) => get("note", { id, version }),
    history: (id: string) => get("history", { id }),
    list: () => get("list", {}),
    changes: (after?: string | number, limit?: number) => get("changes", { after, limit }),
    remove: (id: string, base: number) => post("delete", { id, base }),
    wraps: () => get("wraps", {}),
  };
}

/** Every route once, with the smallest request that reaches it, for the tests that hold them all to one rule. */
export const EVERY_ROUTE: ReadonlyArray<{ name: string; method: "GET" | "POST"; path: string; body?: unknown }> = [
  { name: "save", method: "POST", path: `${API}/save`, body: { id: "gate-1", base: 0, kid: 1, blob: "AAAA" } },
  { name: "note", method: "GET", path: `${API}/note?id=gate-1` },
  { name: "history", method: "GET", path: `${API}/history?id=gate-1` },
  { name: "list", method: "GET", path: `${API}/list` },
  { name: "changes", method: "GET", path: `${API}/changes` },
  { name: "delete", method: "POST", path: `${API}/delete`, body: { id: "gate-1", base: 1 } },
  { name: "wraps", method: "GET", path: `${API}/wraps` },
];

/**
 * The body of an answer that must have `status`. A route that is not there answers with a page, so the test fails
 * here, on "expected 404 to be 200", and never on a read of a body that is not there.
 */
export function bodyOf(answer: Answer, status = 200): any {
  expect(answer.status, `status of the answer (${answer.text.slice(0, 100)})`).toBe(status);
  return answer.body;
}

/** An answer that must be a refusal: this status and `{ error }` in plain words. */
export function expectRefusal(answer: Answer, status: number, what = "the answer"): void {
  expect(answer.status, `${what}: status (${answer.text.slice(0, 100)})`).toBe(status);
  expect(typeof answer.body?.error, `${what}: a JSON body with an error`).toBe("string");
}
