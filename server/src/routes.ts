// Nexus's route table, and the one place a request becomes an answer.
//
//   THE STORE (any identity). A note is an encrypted blob under an id the device chose; the server reads none of it.
//   POST /save      { id, base, kid, blob }            200 saved, 409 the note is at another version (with `current`),
//                                                      400 with a `reason` if the blob does not begin as an encrypted note does (header.ts)
//   GET  /note      ?id=I[&version=N]                  200 the note's blob, 404 no such note or version
//   GET  /history   ?id=I                              200 the versions, oldest first, without blobs
//   GET  /list      (no parameters)                    200 the live notes: id, latest version, time, kid, hash
//   GET  /changes   [?after=CURSOR][&limit=N]          200 the versions after the cursor, oldest first, and `next`: a page ends at N versions or at the
//                                                      size cap on its blobs, whichever is first (store.ts `changes`), so it can be short
//   GET  /heads     [?after=CURSOR][&limit=N]          200 the newest version of every note (a delete without its blob), in the order of those versions, and `next`: paged
//                                                      as /changes is, and its last `next` is a place /changes can carry on from (store.ts `heads`)
//   POST /delete    { id, base }                       200 deleted, 404 no such note, 409 the note is at another version
//   GET  /wraps                                        200 { vaultId, wraps }: the vault id the wraps were made with (null before the first wrap) and the
//                                                      vault key's wraps (Recovery, password), each with its kid
//
//   MANAGING (the owner only; any other identity is 403)
//   POST /wrap           { kid, kind, wrap, vaultId }  200 kept (replaces the wrap of that kind for that kid), 400 with a `reason` if it does not begin as that wrap does,
//                                                      409 if the server already holds a vault with another vault id (the first wrap sets it, and it never changes)
//   POST /wrap/delete    { kid, kind }                 200 removed, 404 no such wrap
//   POST /identity       { name, kind }                200 the identity, 400 a bad name or kind, 409 name taken
//   GET  /tokens                                       200 the tokens that work (never the token), newest first
//   POST /token/revoke   { id }                        200 revoked, 404 no such token
//
//   DEVICE APPROVAL (a device asks, the owner allows it, the device is handed a token once)
//   POST /device/start   { identity, label[, deviceKey] }  no credential: 200 { code, link, secret, expiresAt }. `deviceKey` is the
//                                                      device's public key (base64, 32 bytes) for a sealed approval to be made to
//   POST /device/poll    { secret }                    no credential: 200 pending, or approved with the token once and, if the owner's
//                                                      device left one, the sealed approval and its device's public key (`approval`,
//                                                      `approverKey`, base64, else null), deleted as they are handed over
//   GET  /device/pending ?code=C                       owner only: what is being asked, for the approval page, with its `deviceKey`
//   GET  /device/waiting [?code=C]                     owner only: the sign-ins still waiting, { signins: [ { label, code } ] }, oldest first, nothing secret in it; with `code`,
//                                                      only the sign-in that code is, however a person typed it (small letters, spaces, no dash)
//   POST /device/approve { code[, approval, approverKey] } owner only: the sealed approval and the approving device's public key go
//                                                      together, and only to a sign-in that sent a `deviceKey`
//   POST /device/deny    { code }                      owner only
//
// WHO IS CALLING. The owner's session (the host's sign-in plug, ports.ts) is the identity named by the `owner`
// setting: on Cloudflare, a cookie or, for the approval page, a header, each holding the owner secret and each taken over https or at a loopback address only (plugs/cloudflare/signin.ts). A header `Authorization: Bearer <token>` is the identity the token was made for. Both missing, a token Nexus does not know, a revoked one, and a header that is
// not a Bearer one are all 401, before any route runs. Only the two device routes a device itself calls (start and
// poll) need no credential: a device has none yet.
//
// Every route lives under /nexus/api (addresses.ts). A note is named by its id, which rides in the body or the query string. Every answer is JSON, a
// refusal is `{ error: "<plain words>" }` (a stale save adds `current`), and nothing is cached.
//
// Nothing here names a Cloudflare type: the Worker (plugs/cloudflare/worker.ts) hands each request to `runNexus`
// with a NexusHost built from plugs. Nothing a note holds reaches here, and no log line written here names one.

import { routeName } from "./addresses";
import * as devices from "./devices";
import * as identities from "./identities";
import { base64Length } from "./bytes";
import { MAX_BLOB_BYTES } from "./fields";
import { operations } from "./operations";
import type { Answered } from "./operations";
import type { NexusHost } from "./ports";
import { Refusal } from "./refusal";
import type { Caller } from "./caller";

/** A request body is turned away unread above this: a blob at its limit, written as base64, and the rest of the JSON. */
const MAX_BODY_BYTES = base64Length(MAX_BLOB_BYTES) + 4096;

/** What a route that needs no sign-in is handed as its caller: no name. None of them reads it. */
const NOBODY: Caller = { name: "", owner: false, writer: "" };

/** Who may call a route: anyone (the device's own two), any identity, or only the owner. */
type Who = "anyone" | "identity" | "owner";

interface Call {
  host: NexusHost;
  /** Who is calling. On a route anyone may call this is NOBODY, and the route never reads it. */
  caller: Caller;
  url: URL;
  /** The JSON body of a POST. Read only by the routes that take one. */
  body: () => Promise<Record<string, unknown>>;
}

interface Route {
  method: "GET" | "POST";
  name: string;
  who: Who;
  run: (call: Call) => Promise<Answered>;
}

const ok = (json: unknown): Answered => ({ status: 200, json });
const param = (call: Call, name: string): string | undefined => call.url.searchParams.get(name) ?? undefined;
/** A number carried in the query string; text that is no number stays NaN so it is refused as a bad number. */
const numberParam = (call: Call, name: string): number | undefined => {
  const text = param(call, name);
  return text === undefined ? undefined : /^\d+$/.test(text) ? Number(text) : Number.NaN;
};

const ROUTES: readonly Route[] = [
  { method: "POST", name: "save", who: "identity", run: async (c) => operations.save(c.host, c.caller, await c.body()) },
  { method: "GET", name: "note", who: "identity", run: (c) => operations.note(c.host, c.caller, param(c, "id"), numberParam(c, "version")) },
  { method: "GET", name: "history", who: "identity", run: (c) => operations.history(c.host, c.caller, param(c, "id")) },
  { method: "GET", name: "list", who: "identity", run: (c) => operations.list(c.host, c.caller) },
  { method: "GET", name: "changes", who: "identity", run: (c) => operations.changes(c.host, c.caller, param(c, "after"), param(c, "limit")) },
  { method: "GET", name: "heads", who: "identity", run: (c) => operations.heads(c.host, c.caller, param(c, "after"), param(c, "limit")) },
  { method: "POST", name: "delete", who: "identity", run: async (c) => operations.remove(c.host, c.caller, await c.body()) },
  { method: "GET", name: "wraps", who: "identity", run: (c) => operations.wraps(c.host) },

  // Managing: only the owner.
  { method: "POST", name: "wrap", who: "owner", run: async (c) => operations.setWrap(c.host, c.caller, await c.body()) },
  { method: "POST", name: "wrap/delete", who: "owner", run: async (c) => operations.removeWrap(c.host, await c.body()) },
  { method: "POST", name: "identity", who: "owner", run: async (c) => ok(await identities.createIdentity(c.host, await c.body())) },
  { method: "GET", name: "tokens", who: "owner", run: async (c) => ok({ tokens: await identities.listTokens(c.host) }) },
  { method: "POST", name: "token/revoke", who: "owner", run: async (c) => ok(await identities.revokeToken(c.host, (await c.body()).id)) },

  // Device approval.
  { method: "POST", name: "device/start", who: "anyone", run: async (c) => ok(await devices.start(c.host, c.url.origin, await c.body())) },
  { method: "POST", name: "device/poll", who: "anyone", run: async (c) => ok(await devices.poll(c.host, (await c.body()).secret)) },
  { method: "GET", name: "device/pending", who: "owner", run: async (c) => ok(await devices.pending(c.host, param(c, "code"))) },
  { method: "GET", name: "device/waiting", who: "owner", run: async (c) => ok(await devices.waiting(c.host, param(c, "code"))) },
  { method: "POST", name: "device/approve", who: "owner", run: async (c) => ok(await devices.approve(c.host, await c.body())) },
  { method: "POST", name: "device/deny", who: "owner", run: async (c) => ok(await devices.deny(c.host, (await c.body()).code)) },
];

/** The name of every route, so a test can hold each one to a rule and notice a route nobody tested. */
export const ROUTE_NAMES: readonly string[] = [...new Set(ROUTES.map((r) => r.name))];

const respond = (status: number, json: unknown): Response =>
  new Response(JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const refuse = (status: number, error: string, details: Readonly<Record<string, unknown>> = {}): Response =>
  respond(status, { error, ...details });

const BEARER = /^Bearer ([\x21-\x7e]+)$/;

/**
 * Who is calling, or null for nobody Nexus lets in. A bearer token wins when the request carries an Authorization
 * header, and then it has to be a token that works: a header that is not Bearer, or a token that is unknown or
 * revoked, is nobody, with no fallback to a cookie. Without the header it is the owner's own session or nobody.
 */
async function identify(request: Request, host: NexusHost): Promise<Caller | null> {
  const header = request.headers.get("authorization");
  if (header !== null) {
    const token = BEARER.exec(header)?.[1];
    return token === undefined ? null : identities.authenticateToken(host, token);
  }
  const session = await host.signIn.identify(request);
  return session === null ? null : identities.loadCaller(host, session.identity);
}

/** Answers one request to /nexus/api/*. Sign-in first (except for the two calls a device makes), then the route; nothing here throws. */
export async function runNexus(request: Request, host: NexusHost): Promise<Response> {
  try {
    const url = new URL(request.url);
    const name = routeName(url.pathname) ?? "";
    const named = ROUTES.filter((r) => r.name === name);

    // A device has no credential yet, so its own two routes are the only ones that skip the sign-in. Anything else,
    // a route that is not there included, meets it first: nobody is told what routes exist.
    let caller: Caller | null = null;
    if (!named.some((r) => r.who === "anyone")) {
      caller = await identify(request, host);
      if (!caller) return refuse(401, "Nexus needs the owner's sign-in or a token Nexus made.");
    }

    const route = named.find((r) => r.method === request.method);
    if (!route) {
      return named.length > 0 ? refuse(405, `${name} does not take ${request.method}.`) : refuse(404, "Nexus has no such route.");
    }
    if (route.who === "owner" && !caller?.owner) return refuse(403, "Only the owner can do that.");

    const body = async (): Promise<Record<string, unknown>> => {
      // A page on another site cannot send JSON as JSON without a CORS preflight, which Nexus never answers, so a
      // body that is not declared JSON is refused. That is a second wall, beside the session cookie being SameSite=Lax,
      // against a page that tries to make the owner's browser allow a device's sign-in or save a note for it.
      if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
        throw new Refusal(400, "The request body has to be sent as application/json.");
      }
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > MAX_BODY_BYTES) throw new Refusal(413, "That request is too big for Nexus.");
      let parsed: unknown;
      try {
        parsed = await request.json();
      } catch {
        throw new Refusal(400, "The request body has to be JSON.");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Refusal(400, "The request body has to be a JSON object.");
      return parsed as Record<string, unknown>;
    };

    const answer = await route.run({ host, caller: caller ?? NOBODY, url, body });
    return respond(answer.status, answer.json);
  } catch (error) {
    if (error instanceof Refusal) return refuse(error.status, error.message, error.details);
    // What is logged is the fault, which holds nothing a caller sent: a request's body, its query and its address are never put in a log line.
    console.error("nexus: a request failed", error);
    return refuse(503, "Nexus could not answer just now.");
  }
}
