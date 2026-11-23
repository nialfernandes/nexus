// A FAKE OF NEXUS for the Nexus page (public/nexus/nexus.js): the routes the page calls, answering in the shapes and words the page is
// built against. The page's two tests (nexus-page.test.ts, run against a stand-in for the page; e2e/nexus.spec.ts, in a real browser)
// both ask this one fake, so what they check the page against is written once.
//
// WHAT IS REAL AND WHAT IS NOT. The routes of the device approval and `identity` and `token/revoke` exist in routes.ts, and
// nexus-page.test.ts holds this fake's answers to those routes' own (same keys, same kinds of value, same words). `GET identities` and
// `POST identity/remove` are being added to routes.ts by another slice: their answers here are the brief's own,
//   GET  identities        200 { identities: [ { name, kind, owner, createdAt, devices: [ { id, label, createdAt, lastUsedAt } ] } ] }
//   POST identity/remove   200 { result: "removed", name, revoked }
// and nothing holds them to the real route until it lands.
//
// The fake keeps its world in memory and changes it as the real routes would: approving a waiting sign-in gives its identity a device,
// adding an identity lists it, removing one takes its devices with it. Every call it is asked is recorded in `calls`.
//
// Apart from the approval page's own answers (approve-answers.ts, which imports nothing either), this file imports nothing, so a
// browser test runner can read it as well.

import { APPROVED, DENIED, GONE, GONE_EXPIRED, NOT_FOUND, PENDING } from "./approve-answers";

/** The owner secret the fake takes when the browser holds no cookie. */
export const FAKE_OWNER_SECRET = "a".repeat(64);
export const FAKE_OWNER_SECRET_HEADER = "x-nexus-owner-secret";

/** Where the Nexus page is opened, the address its calls go under, and the routes the fake answers (after that address). */
export const NEXUS_PAGE = "/nexus/";
export const API = "/nexus/api/";

/** What Nexus says when nobody it knows is asking, and what it says for a name that is wrong, taken, or not one of its identities. */
export const NOT_SIGNED_IN = { error: "Nexus needs the owner's sign-in or a token Nexus made." };
export const BAD_NAME = { error: "An identity's name is lower case letters, digits and hyphens, such as lab-m or scribe." };
export const taken = (name: string) => ({ error: `There is already an identity called ${name}.` });
export const NO_IDENTITY = { error: "There is no identity with that name." };
export const NO_TOKEN = { error: "There is no token with that id." };

export interface FakeDevice { id: string; label: string; createdAt: number; lastUsedAt: number | null }
export interface FakeIdentity { name: string; kind: "person" | "agent" | "app"; owner: boolean; createdAt: number; devices: FakeDevice[] }
export interface FakeWaiting { code: string; label: string; identity: string; deviceKey: string | null; deviceCode: string | null; expiresAt: number }

/** What a call was: the route after the API's address (a query string included), the method, and the JSON body sent. */
export interface FakeCall { method: string; route: string; body: unknown; secret: string | null }

/** An answer: the status and the JSON. */
export interface FakeAnswer { status: number; json: unknown }

/**
 * Times in the worked example. Sat 12 Sep 2026 12:00 in Sydney (UTC+10 until the clocks go forward in October) is 02:00 UTC; the
 * browser spec opens the page in that time zone, so it reads "Sat 12 Sep · 12:00".
 */
export const SAT_NOON = Date.UTC(2026, 8, 12, 2, 0, 0);
export const HOUR = 60 * 60 * 1000;

/** The names of the worked example: the owner and its MacBook, one agent with one device, and an iPhone asking to sign in as the owner. */
export const WORKED = {
  owner: "nial",
  agent: "scribe",
  newAgent: "lab-m",
  ownerDevice: { id: "tok-macbook", label: "MacBook", createdAt: SAT_NOON, lastUsedAt: SAT_NOON + 21 * HOUR + 30 * 60 * 1000 },
  agentDevice: { id: "tok-scribe-box", label: "scribe-box", createdAt: SAT_NOON + 44 * HOUR + 5 * 60 * 1000, lastUsedAt: null },
  waiting: { code: PENDING.code, label: "iPhone", identity: "nial", deviceKey: PENDING.deviceKey, deviceCode: PENDING.deviceCode },
} as const;

export interface FakeOptions {
  /** True when the browser holds the owner's cookie: no secret is asked for. False (the default) when it must send the owner secret. */
  knownOwner?: boolean;
  /** The sign-ins waiting. The worked example's iPhone when left out. */
  waiting?: Array<Omit<FakeWaiting, "expiresAt"> & { expiresAt?: number }>;
  /** Who is connected. The worked example's owner and agent when left out. */
  identities?: FakeIdentity[];
}

/** The worked example's people: the owner (a person) with a MacBook, and the agent with one device that has never been used. */
export function workedIdentities(): FakeIdentity[] {
  return [
    { name: WORKED.owner, kind: "person", owner: true, createdAt: SAT_NOON - 24 * HOUR, devices: [{ ...WORKED.ownerDevice }] },
    { name: WORKED.agent, kind: "agent", owner: false, createdAt: SAT_NOON + 40 * HOUR, devices: [{ ...WORKED.agentDevice }] },
  ];
}

export class FakeNexus {
  identities: FakeIdentity[];
  waiting: FakeWaiting[];
  readonly calls: FakeCall[] = [];
  /** Codes that ran out and codes that were used already: a call about one is refused as Nexus refuses it. */
  readonly ranOut = new Set<string>();
  readonly used = new Set<string>();
  /** The owner secret Nexus takes from a browser that holds no cookie. A test changes it to make Nexus refuse the one the page holds. */
  ownerSecret = FAKE_OWNER_SECRET;
  /** The next id a device is given. */
  private nextDevice = 1;
  private readonly knownOwner: boolean;

  constructor(options: FakeOptions = {}) {
    this.knownOwner = options.knownOwner ?? false;
    this.identities = options.identities ?? workedIdentities();
    this.waiting = (options.waiting ?? [WORKED.waiting]).map((w) => ({ expiresAt: PENDING.expiresAt, ...w }));
  }

  /** The calls to one route (a query string counts as part of it). */
  callsTo(route: string, method?: string): FakeCall[] {
    return this.calls.filter((c) => c.route === route && (method === undefined || c.method === method));
  }

  /** Answers one call: the method, the route after the API's address (with its query), the JSON body (or null), and the secret header (or null). */
  answer(method: string, route: string, body: unknown, secret: string | null): FakeAnswer {
    this.calls.push({ method, route, body, secret });
    if (!this.knownOwner && secret !== this.ownerSecret) return { status: 401, json: NOT_SIGNED_IN };

    const [name, query = ""] = route.split("?");
    const code = new URLSearchParams(query).get("code");
    const sent = (body ?? {}) as Record<string, unknown>;
    const same = (m: string, n: string) => method === m && name === n;

    if (same("GET", "identities")) return { status: 200, json: { identities: this.identities } };
    if (same("GET", "device/waiting")) {
      return { status: 200, json: { signins: this.waiting.map((w) => ({ label: w.label, code: w.code, deviceKey: w.deviceKey })) } };
    }
    if (same("GET", "device/pending")) {
      const finished = this.finished(code);
      if (finished) return finished;
      const found = this.waiting.find((w) => w.code === code);
      return found ? { status: 200, json: { ...found } } : { status: 404, json: NOT_FOUND };
    }
    if (same("POST", "device/approve") || same("POST", "device/deny")) {
      const approving = name === "device/approve";
      const asked = typeof sent.code === "string" ? sent.code : null;
      const finished = this.finished(asked);
      if (finished) return finished;
      const found = this.waiting.find((w) => w.code === asked);
      if (!found) return { status: 404, json: NOT_FOUND };
      this.waiting = this.waiting.filter((w) => w !== found);
      this.used.add(found.code);
      if (approving) {
        const who = this.identities.find((i) => i.name === found.identity);
        who?.devices.push({ id: `tok-new-${this.nextDevice++}`, label: found.label, createdAt: SAT_NOON + 48 * HOUR, lastUsedAt: null });
      }
      return { status: 200, json: { ...(approving ? APPROVED : DENIED), code: found.code, identity: found.identity, label: found.label } };
    }
    if (same("POST", "identity")) {
      const wanted = sent.name;
      if (typeof wanted !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(wanted)) return { status: 400, json: BAD_NAME };
      if (this.identities.some((i) => i.name === wanted)) return { status: 409, json: taken(wanted) };
      this.identities.push({ name: wanted, kind: sent.kind as FakeIdentity["kind"], owner: false, createdAt: SAT_NOON + 48 * HOUR, devices: [] });
      return { status: 200, json: { name: wanted, kind: sent.kind } };
    }
    if (same("POST", "identity/remove")) {
      const found = this.identities.find((i) => i.name === sent.name && !i.owner);
      if (!found) return { status: 404, json: NO_IDENTITY };
      this.identities = this.identities.filter((i) => i !== found);
      return { status: 200, json: { result: "removed", name: found.name, revoked: found.devices.length } };
    }
    if (same("POST", "token/revoke")) {
      for (const who of this.identities) {
        const at = who.devices.findIndex((d) => d.id === sent.id);
        if (at >= 0) {
          who.devices.splice(at, 1);
          return { status: 200, json: { result: "revoked", id: sent.id } };
        }
      }
      return { status: 404, json: NO_TOKEN };
    }
    return { status: 404, json: { error: "Nexus has no such route." } };
  }

  /** The refusal for a code that ran out or was used already, or null when it is neither. */
  private finished(code: string | null): FakeAnswer | null {
    if (code !== null && this.ranOut.has(code)) return { status: 410, json: GONE_EXPIRED };
    if (code !== null && this.used.has(code)) return { status: 410, json: GONE };
    return null;
  }
}
