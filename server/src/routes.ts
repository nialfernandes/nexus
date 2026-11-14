// Nexus's route table, and the one place a request becomes an answer.
//
//   THE STORE (any identity, held to its folder rights)
//   POST /save      { path, text, base?, resolves? }   200 saved or merged, 409 clash (with both texts)
//   GET  /note      ?path=P[&version=N]                200 the note, 404 no such note or version
//   GET  /history   ?path=P                            200 the versions, oldest first
//   GET  /list      [?folder=F]                        200 the live notes under F, or all of them
//   GET  /search    ?q=TEXT                            200 the live notes whose latest text holds TEXT
//   GET  /changes   [?after=CURSOR][&limit=N]          200 every version after the cursor, oldest first, and `next`
//   POST /move      { from, to }                       200 moved, 404 no such note, 409 `to` is a live note
//   POST /delete    { path }                           200 deleted, 404 no such note
//   A read or write outside the caller's rights is 403 naming the path. List, search and changes show only what
//   the caller may read.
//
//   MANAGING (the owner only; any other identity is 403)
//   POST /identity       { name, kind, rights? }       200 the identity, 400 a bad name, kind or rights, 409 name taken
//   POST /rights         { identity, rights }          200 the new list, 404 no such identity, the owner's cannot be set
//   GET  /tokens                                       200 the tokens that work (never the token), newest first
//   POST /token/revoke   { id }                        200 revoked, 404 no such token
//
//   DEVICE APPROVAL (a device asks, the owner allows it, the device is handed a token once)
//   POST /device/start   { identity, label }           no credential: 200 { code, link, secret, expiresAt }
//   POST /device/poll    { secret }                    no credential: 200 pending, or approved with the token once
//   GET  /device/pending ?code=C                       owner only: what is being asked, for the approval page
//   POST /device/approve { code }                      owner only
//   POST /device/deny    { code }                      owner only
//
// WHO IS CALLING. The owner's session (the host's sign-in plug, ports.ts) is the identity named by the `owner`
// setting. A header `Authorization: Bearer <token>` is the identity the token was made for. Both missing, a token Nexus does not know, a revoked one, and a header that is
// not a Bearer one are all 401, before any route runs. Only the two device routes a device itself calls (start and
// poll) need no credential: a device has none yet.
//
// Every route lives under /apps/nexus/api. A note's path rides in the body or the query string, never in the URL
// path: a URL parser folds `../` away before any route sees it. Every answer is JSON, a refusal is
// `{ error: "<plain words>" }`, and nothing is cached.
//
// Nothing here names a Cloudflare type: the Worker (plugs/cloudflare/worker.ts) hands each request to `runNexus`
// with a NexusHost built from plugs.

import * as devices from "./devices";
import * as identities from "./identities";
import { operations } from "./operations";
import type { Answered } from "./operations";
import type { NexusHost } from "./ports";
import { Refusal } from "./refusal";
import type { Caller } from "./rights";
import * as store from "./store";

export const NEXUS_BASE = "/apps/nexus/api";

/** A request body is turned away unread above this: a note's text at its limit, written with six-byte escapes, and the rest. */
const MAX_BODY_BYTES = store.MAX_TEXT_BYTES * 6 + 4096;

/** What a route that needs no sign-in is handed as its caller: no name and no rights. None of them reads it. */
const NOBODY: Caller = { name: "", rights: [], owner: false };

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
  { method: "GET", name: "note", who: "identity", run: (c) => operations.note(c.host, c.caller, param(c, "path"), numberParam(c, "version")) },
  { method: "GET", name: "history", who: "identity", run: (c) => operations.history(c.host, c.caller, param(c, "path")) },
  { method: "GET", name: "list", who: "identity", run: (c) => operations.list(c.host, c.caller, param(c, "folder")) },
  { method: "GET", name: "search", who: "identity", run: (c) => operations.search(c.host, c.caller, param(c, "q")) },
  { method: "GET", name: "changes", who: "identity", run: (c) => operations.changes(c.host, c.caller, param(c, "after"), param(c, "limit")) },
  {
    method: "POST", name: "move", who: "identity",
    run: async (c) => {
      const body = await c.body();
      return operations.move(c.host, c.caller, body.from, body.to);
    },
  },
  { method: "POST", name: "delete", who: "identity", run: async (c) => operations.remove(c.host, c.caller, (await c.body()).path) },

  // Managing: only the owner.
  { method: "POST", name: "identity", who: "owner", run: async (c) => ok(await identities.createIdentity(c.host, await c.body())) },
  { method: "POST", name: "rights", who: "owner", run: async (c) => ok(await identities.setRights(c.host, await c.body())) },
  { method: "GET", name: "tokens", who: "owner", run: async (c) => ok({ tokens: await identities.listTokens(c.host) }) },
  { method: "POST", name: "token/revoke", who: "owner", run: async (c) => ok(await identities.revokeToken(c.host, (await c.body()).id)) },

  // Device approval.
  { method: "POST", name: "device/start", who: "anyone", run: async (c) => ok(await devices.start(c.host, c.url.origin, await c.body())) },
  { method: "POST", name: "device/poll", who: "anyone", run: async (c) => ok(await devices.poll(c.host, (await c.body()).secret)) },
  { method: "GET", name: "device/pending", who: "owner", run: async (c) => ok(await devices.pending(c.host, param(c, "code"))) },
  { method: "POST", name: "device/approve", who: "owner", run: async (c) => ok(await devices.approve(c.host, (await c.body()).code)) },
  { method: "POST", name: "device/deny", who: "owner", run: async (c) => ok(await devices.deny(c.host, (await c.body()).code)) },
];

const respond = (status: number, json: unknown): Response =>
  new Response(JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const refuse = (status: number, error: string): Response => respond(status, { error });

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

/** Answers one request to /apps/nexus/api/*. Sign-in first (except for the two calls a device makes), then the route; nothing here throws. */
export async function runNexus(request: Request, host: NexusHost): Promise<Response> {
  try {
    const url = new URL(request.url);
    const name = url.pathname.startsWith(`${NEXUS_BASE}/`) ? url.pathname.slice(NEXUS_BASE.length + 1) : "";
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
    if (error instanceof Refusal) return refuse(error.status, error.message);
    console.error("nexus: a request failed", error);
    return refuse(503, "Nexus could not answer just now.");
  }
}
