// A world for the identity tests: the same Nexus Worker, owner sign-in and database as nexus-world.ts builds them,
// plus the calls that identities add. Nothing here knows how identities are built:
// every test asks the Worker over HTTP, or the in-worker entry (app-identity.test.ts), and reads the answer.
//
// WHERE THINGS COME FROM
//   - Tokens are never planted. A token is got the way a device gets one in use: it starts a sign-in, the owner's
//     session approves it, the device polls and is handed the token (`issueToken` below runs those three calls).
//   - The identities `agents` and `recorder` are made by setUpNexus (nexus-world.ts) through the real route, as the
//     owner. The owner's own identity is the name the Worker's NEXUS_OWNER setting gives (`owner` in these tests).
//   - The database is read directly in one place only: tokens.test.ts scans every table for the token text, which
//     needs no column name and so holds the builder to nothing but "the token is not kept".
//   - The answers' shapes are written here by hand (no recorded answer exists before the code does); they are
//     the contract, in the same way nexus-world.ts's header is the contract of the store routes.
//
// THE WIRE CONTRACT OF IDENTITIES (all routes are under /apps/nexus/api, JSON in and out, a refusal is
// `{ error: "<plain words>" }`; the store routes of nexus-world.ts keep their shapes)
//
//   WHO IS CALLING. The owner's own session cookie is the identity `owner`. A header `Authorization: Bearer <token>` is
//   the identity the token was made for. No credential, a token that is not known, and a revoked token are all 401,
//   before any route runs. A signed-in person who is not the owner and sends no token is 401 too.
//
//   FOLDER RIGHTS. An identity has a list of `{ path, access }`. `path` is a folder prefix as the notes' own paths
//   are written, with its closing slash ("Podcasts/Transcripts/"); "" is the whole vault. `access` is "read",
//   "write" (which includes read) or "none". For a note, the entry with the longest `path` that the note's path
//   starts with decides; a note no entry reaches is not allowed at all. "none" exists so that "everything except
//   Private/" can be written as { "" write } and { "Private/" none }.
//   A save, a delete and a move need write on the path (a move needs write on both ends). A note read and a
//   history read need read. Each answers 403 with an error that names the path, whether or not a note is there.
//   `list`, `search` and `changes` answer 200 and leave out what the identity may not read; the changes cursor
//   still moves past what was left out. `owner` has write on every path, always.
//
//   DEVICE APPROVAL (a device asks, the owner allows it, the device is handed a token)
//   POST device/start   { identity, label }       no credential needed
//       200 { code, link, secret, expiresAt }     `code` is short (4 to 16 characters), `link` is
//                                                 `<origin>/apps/nexus/approve?code=<code>`, `secret` is long and
//                                                 only the device knows it, `expiresAt` is unix ms, 10 minutes on
//       404 no such identity    400 a label that is missing or blank
//   GET  device/pending ?code=C                   the owner only
//       200 { code, identity, label, expiresAt }  what the approval page shows
//       404 no such code        410 the code has expired, or has been allowed or denied already
//   POST device/approve { code }                  the owner only
//       200 { result: "approved", code, identity, label }
//       401 nobody the owner's  403 someone who is signed in as another identity  404 / 410 as above
//   POST device/deny    { code }                  the owner only, answers as approve does with result "denied"
//   POST device/poll    { secret }                no credential needed
//       200 { status: "pending" }                                       not decided yet
//       200 { status: "approved", token, identity, label }              the first poll after approval, only once
//       403 denied   404 no such secret   410 expired, or the token was already handed over
//
//   MANAGING (only the identity `owner`: the owner's session, or a token made for `owner`; any other identity is 403)
//   POST identity    { name, kind, rights? }   200 { name, kind, rights }   kind is "person", "agent" or "app"
//                                              400 a bad kind or name, 409 the name is taken
//   POST rights      { identity, rights }      200 { identity, rights }     replaces the whole list; 404 no such identity
//                                              `owner` cannot be narrowed or emptied: refused, 4xx, nothing changes
//   GET  tokens                                200 { tokens: [ { id, identity, label, createdAt, lastUsedAt } ] }
//                                              `id` is text that means nothing by itself
//                                              `lastUsedAt` is null until the token has been used, then unix ms.
//                                              A token itself, and anything made from it, is never in an answer.
//   POST token/revoke { id }                   200 { result: "revoked", id }, 404 no such token
//
//   THE IN-WORKER ENTRY. An app inside the same Worker does not use a token. The Cloudflare plug exports
//   `nexusAsApp(env, identity)`; see app-identity.test.ts for what it gives back.

import { expect } from "vitest";
import type { NexusEnv } from "../plugs/cloudflare/host";
import worker from "../plugs/cloudflare/worker";
import { API, ORIGIN, appEnv, bodyOf, nexusDb, type Answer } from "./nexus-world";

/** The Worker's own bindings, as the tests run it: what an app inside the Worker is handed. */
export const workerEnv = (): NexusEnv => appEnv();

/**
 * Who is calling: the owner's session cookie, a bearer token, an Authorization header written out whole, nobody, or a
 * token that is only made when it is first used (`tokenFor`), so a test that needs one fails in its own body and a
 * file does not fail whole before any test has run.
 */
export type Who = { cookie: string } | { bearer: string } | { authorization: string } | { lazy: () => Promise<Who> } | null;

export interface FolderRight { path: string; access: "read" | "write" | "none" }

/** One request through the Nexus Worker, as `who`. */
export async function sendAs(
  method: string, path: string, who: Who, body?: unknown, env: NexusEnv = workerEnv(),
): Promise<Answer> {
  const headers: Record<string, string> = {};
  while (who && "lazy" in who) who = await who.lazy();
  if (who && "cookie" in who) headers.cookie = who.cookie;
  if (who && "bearer" in who) headers.authorization = `Bearer ${who.bearer}`;
  if (who && "authorization" in who) headers.authorization = who.authorization;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual",
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

/** The store's routes (nexus-world.ts's `vault`), called as `who`. */
export function vaultAs(who: Who) {
  const get = (route: string, params: Record<string, string | number | undefined>) =>
    sendAs("GET", `${API}/${route}${query(params)}`, who);
  const post = (route: string, body: unknown) => sendAs("POST", `${API}/${route}`, who, body);
  return {
    save: (path: string, text: string, options: { base?: number; resolves?: number } = {}) =>
      post("save", { path, text, ...options }),
    note: (path: string, version?: number) => get("note", { path, version }),
    history: (path: string) => get("history", { path }),
    list: (folder?: string) => get("list", { folder }),
    search: (q: string) => get("search", { q }),
    changes: (after?: string | number, limit?: number) => get("changes", { after, limit }),
    move: (from: string, to: string) => post("move", { from, to }),
    remove: (path: string) => post("delete", { path }),
  };
}

/** The routes only `owner` may call, as `who`. */
export function manage(who: Who) {
  const post = (route: string, body: unknown) => sendAs("POST", `${API}/${route}`, who, body);
  return {
    createIdentity: (name: string, kind: string, rights?: FolderRight[]) =>
      post("identity", { name, kind, ...(rights ? { rights } : {}) }),
    setRights: (identity: string, rights: FolderRight[]) => post("rights", { identity, rights }),
    tokens: () => sendAs("GET", `${API}/tokens`, who),
    revoke: (id: string) => post("token/revoke", { id }),
  };
}

/** The device's calls, and the owner's answers to them. `who` is whoever makes the call. */
export function device(who: Who = null) {
  const post = (route: string, body: unknown) => sendAs("POST", `${API}/device/${route}`, who, body);
  return {
    start: (identity: string, label: string) => post("start", { identity, label }),
    pending: (code: string) => sendAs("GET", `${API}/device/pending${query({ code })}`, who),
    approve: (code: string) => post("approve", { code }),
    deny: (code: string) => post("deny", { code }),
    poll: (secret: string) => post("poll", { secret }),
  };
}

export interface Issued { token: string; code: string; secret: string; identity: string; label: string }

/** A token made the way a device gets one: start, the owner approves, the device polls. Every step must work. */
export async function issueToken(ownerCookie: string, identity: string, label: string): Promise<Issued> {
  const started = bodyOf(await device().start(identity, label));
  expect(typeof started.code, "start hands back a code").toBe("string");
  bodyOf(await device({ cookie: ownerCookie }).approve(started.code));
  const polled = bodyOf(await device().poll(started.secret));
  expect(polled.status, "the first poll after approval").toBe("approved");
  expect(typeof polled.token, "the first poll after approval hands over the token").toBe("string");
  return { token: polled.token, code: started.code, secret: started.secret, identity, label };
}

/** A bearer token for `identity`, made through the device approval the first time a call uses it. */
export function tokenFor(ownerCookie: () => string, identity: string, label: string): Who {
  let made: Promise<Who> | undefined;
  return { lazy: () => (made ??= issueToken(ownerCookie(), identity, label).then((issued) => ({ bearer: issued.token }))) };
}

/** The text of every row of every table in Nexus's own database, so a test can look for text that must not be there. */
export async function everythingStored(): Promise<string> {
  const db = nexusDb();
  expect(db, "NEXUS_DB is bound").toBeTruthy();
  const tables = await db!
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
    .all<{ name: string }>();
  const parts: string[] = [];
  for (const { name } of tables.results) {
    const rows = await db!.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all();
    parts.push(`${name}: ${JSON.stringify(rows.results)}`);
  }
  return parts.join("\n");
}

/** The paths of the notes in a list answer, in the order given. */
export const listedPaths = (answer: Answer): string[] => bodyOf(answer).notes.map((n: { path: string }) => n.path);

/**
 * Every change a feed holds for `who`, read `size` at a time by following the cursor until it stops moving. A page
 * that holds nothing the caller may read can still move the cursor, so the loop ends on the cursor, not on a page.
 */
export async function readWholeFeed(who: Who, size: number): Promise<Array<{ path: string; version: number; writer: string; from?: string }>> {
  const all: Array<{ path: string; version: number; writer: string; from?: string }> = [];
  let after: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const page = bodyOf(await vaultAs(who).changes(after, size));
    all.push(...page.changes);
    expect(typeof page.next, "every page names the cursor to carry on from").toBe("string");
    if (page.next === after) return all;
    after = page.next;
  }
  throw new Error("the feed never ran out");
}
