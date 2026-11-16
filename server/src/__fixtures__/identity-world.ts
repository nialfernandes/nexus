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
// THE WIRE CONTRACT OF IDENTITIES (all routes are under /nexus/api, JSON in and out, a refusal is
// `{ error: "<plain words>" }`; the store routes of nexus-world.ts keep their shapes)
//
//   WHO IS CALLING. The owner's own session cookie is the identity `owner`. A header `Authorization: Bearer <token>` is
//   the identity the token was made for. No credential, a token that is not known, and a revoked token are all 401,
//   before any route runs. A signed-in person who is not the owner and sends no token is 401 too.
//
//   NO FOLDER RIGHTS. The folders are inside the encrypted notes, which the server cannot read, so an identity that is
//   let in can save, read and delete every note, and an identity that is not let in cannot. What differs is managing:
//   only the owner calls the routes below, and any other identity is 403 on them.
//
//   DEVICE APPROVAL (a device asks, the owner allows it, the device is handed a token)
//   POST device/start   { identity, label[, deviceKey] }   no credential needed
//       200 { code, link, secret, expiresAt }     `code` is short (4 to 16 characters), `link` is
//                                                 `<origin>/nexus/approve?code=<code>`, `secret` is long and
//                                                 only the device knows it, `expiresAt` is unix ms, 10 minutes on
//       404 no such identity    400 a label that is missing or blank, or a `deviceKey` that is not 32 bytes of base64
//                                                 `deviceKey` is the device's X25519 public key, for an approval to be sealed to
//   GET  device/pending ?code=C                   the owner only
//       200 { code, identity, label, expiresAt, deviceKey }  what the approval page shows (`deviceKey` is null when none was sent)
//       404 no such code        410 { error, reason } the code has expired (`reason` "expired"), or has been allowed or denied already ("used")
//   POST device/approve { code[, approval, approverKey] }   the owner only
//       `approval` is the sealed vault key (base64) and `approverKey` the approving device's public key (base64, 32 bytes): both or neither,
//       and only for a sign-in that sent a `deviceKey` (else 400). The server keeps them until the device collects them or the code expires.
//       200 { result: "approved", code, identity, label }
//       401 nobody the owner's  403 someone who is signed in as another identity  404 / 410 as above (an answer that lost to another answer is 410 "used")
//   POST device/deny    { code }                  the owner only, answers as approve does with result "denied"
//   POST device/poll    { secret }                no credential needed
//       200 { status: "pending" }                                       not decided yet
//       200 { status: "approved", token, identity, label, approval, approverKey }   the first poll after approval, only once
//                                                 `approval` and `approverKey` are what the approving device left (else null), deleted as they are handed over
//       403 denied   404 no such secret   410 expired, or the token was already handed over
//
//   MANAGING (only the identity `owner`: the owner's session, or a token made for `owner`; any other identity is 403)
//   POST identity    { name, kind }            200 { name, kind }           kind is "person", "agent" or "app"
//                                              400 a bad kind or name, or `rights` (folder rights are gone), 409 the name is taken
//   GET  tokens                                200 { tokens: [ { id, identity, label, createdAt, lastUsedAt } ] }
//                                              `id` is text that means nothing by itself
//                                              `lastUsedAt` is null until the token has been used, then unix ms.
//                                              A token itself, and anything made from it, is never in an answer.
//   POST token/revoke { id }                   200 { result: "revoked", id }, 404 no such token
//   POST wrap        { kid, kind, wrap, vaultId } 200 { result: "saved", kid, kind }   kind is "recovery" or "password"
//   POST wrap/delete { kid, kind }             200 { result: "removed", kid, kind }, 404 no such wrap
//
//   THE IN-WORKER ENTRY. An app inside the same Worker does not use a token. The Cloudflare plug exports
//   `nexusAsApp(env, identity)`; see app-identity.test.ts for what it gives back.

import { expect } from "vitest";
import { VAULT_ID } from "./device-blobs";
import type { NexusEnv } from "../plugs/cloudflare/host";
import worker from "../plugs/cloudflare/worker";
import { API, ORIGIN, appEnv, bodyOf, nexusDb, type Answer, type Sent } from "./nexus-world";

/** The Worker's own bindings, as the tests run it: what an app inside the Worker is handed. */
export const workerEnv = (): NexusEnv => appEnv();

/**
 * Who is calling: the owner's session cookie, a bearer token, an Authorization header written out whole, nobody, or a
 * token that is only made when it is first used (`tokenFor`), so a test that needs one fails in its own body and a
 * file does not fail whole before any test has run.
 */
export type Who = { cookie: string } | { bearer: string } | { authorization: string } | { lazy: () => Promise<Who> } | null;

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
export function vaultAs(who: Who, env?: NexusEnv) {
  const get = (route: string, params: Record<string, string | number | undefined>) =>
    sendAs("GET", `${API}/${route}${query(params)}`, who, undefined, env);
  const post = (route: string, body: unknown) => sendAs("POST", `${API}/${route}`, who, body, env);
  return {
    save: (note: Sent, base: number, kid = 1) => post("save", { id: note.id, base, kid, blob: note.blob }),
    note: (id: string, version?: number) => get("note", { id, version }),
    history: (id: string) => get("history", { id }),
    list: () => get("list", {}),
    changes: (after?: string | number, limit?: number) => get("changes", { after, limit }),
    heads: (after?: string | number, limit?: number) => get("heads", { after, limit }),
    remove: (id: string, base: number) => post("delete", { id, base }),
    wraps: () => get("wraps", {}),
  };
}

/** The routes only `owner` may call, as `who`. */
export function manage(who: Who, env?: NexusEnv) {
  const post = (route: string, body: unknown) => sendAs("POST", `${API}/${route}`, who, body, env);
  return {
    createIdentity: (name: string, kind: string) => post("identity", { name, kind }),
    tokens: () => sendAs("GET", `${API}/tokens`, who, undefined, env),
    revoke: (id: string) => post("token/revoke", { id }),
    setWrap: (kid: number, kind: string, wrap: string, vaultId: string = VAULT_ID) => post("wrap", { kid, kind, wrap, vaultId }),
    removeWrap: (kid: number, kind: string) => post("wrap/delete", { kid, kind }),
  };
}

/** The device's calls, and the owner's answers to them. `who` is whoever makes the call. */
export function device(who: Who = null, env?: NexusEnv) {
  const post = (route: string, body: unknown) => sendAs("POST", `${API}/device/${route}`, who, body, env);
  return {
    start: (identity: string, label: string, deviceKey?: string) => post("start", { identity, label, ...(deviceKey === undefined ? {} : { deviceKey }) }),
    pending: (code: string) => sendAs("GET", `${API}/device/pending${query({ code })}`, who, undefined, env),
    /** `sealed` is the sealed approval and the approving device's public key, both base64, sent with the allow. */
    approve: (code: string, sealed?: { approval?: unknown; approverKey?: unknown }) => post("approve", { code, ...sealed }),
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

/**
 * The writer a token's saves are kept under, `device:<the token's id>`: the id is read from the owner's list of tokens,
 * by the label the token was made with (a test gives each token a label of its own).
 */
export async function writerOf(ownerCookie: string, label: string): Promise<string> {
  const tokens = bodyOf(await manage({ cookie: ownerCookie }).tokens()).tokens as Array<{ id: string; label: string }>;
  const found = tokens.filter((t) => t.label === label);
  expect(found, `one token labelled ${label}`).toHaveLength(1);
  return `device:${found[0]!.id}`;
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

/** The ids of the notes in a list answer, in the order given. */
export const listedIds = (answer: Answer): string[] => bodyOf(answer).notes.map((n: { id: string }) => n.id);

/** Every change a feed holds for `who`, read `size` at a time by following the cursor until it stops moving. */
export async function readWholeFeed(who: Who, size: number): Promise<Array<{ id: string; version: number; writer: string; kind: string }>> {
  const all: Array<{ id: string; version: number; writer: string; kind: string }> = [];
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
