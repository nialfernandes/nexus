// The real Nexus server, for the plugin's tests: the server package's own routes, rules and store (server/src, as they are
// in this repository), over an in-memory SQLite database (node:sqlite) made from the server's own migrations.
//
// WHAT IS THE SERVER'S AND WHAT IS NOT
//   - The server's own code answers every request: the route table and the sign-in check (server/src/routes.ts), the store,
//     the tokens and the device approval behind it, the owner's cookie check and the settings reader of the Cloudflare plug,
//     and the tables from server/migrations. Nothing of the server is written out again here. The server holds blobs only: it
//     reads no note, merges nothing and searches nothing, so none of that is here either.
//   - One small thing is not the server's: the Worker's own front door (server/src/plugs/cloudflare/worker.ts) is left out,
//     because it names Cloudflare types that the plugin's type check does not have; it only hands a request under the API's
//     base to `runNexus`, which is what `RealNexus.fetch` does.
//   - The database is the SQL port (server/src/ports.ts `SqlDb`) over node:sqlite, which the shared test package
//     (@nexus/test-sqlite, packages/test-sqlite) provides. The server's own tests build the same database from the same
//     package, wearing the shape of D1: a batch is one transaction, a row is a plain object, a count is a number.
//
// The plugin is pinned to the server as it is in this repository. When the server changes what it holds or answers, the
// plugin's tests have to move along with it, in the slice that moves the plugin. The server holds blobs only: a note is an
// id, a version, a key number and bytes the server cannot read, so these routes take and give exactly that, and the tests
// that need the text of a note open the blob themselves (world.ts).
//
// WHO IS CALLING. The owner's session is the cookie the server's sign-in reads (`nexus_owner=<secret>`). `Authorization:
// Bearer <token>` is the identity the token was made for. The identities are the owner (named by the NEXUS_OWNER setting)
// and `agents`, another writer, made the way an operator makes them: the owner calls POST identity through the real route.
// An identity has no folder rights any more (the folders are inside the encrypted notes), so the two can use every note.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sqlOver } from "@nexus/test-sqlite";
import { APPROVE_PATH as SERVER_APPROVE_PATH, NEXUS_BASE } from "../../server/src/addresses";
import type { NexusHost } from "../../server/src/ports";
import { runNexus } from "../../server/src/routes";
import { workerSecrets } from "../../server/src/plugs/cloudflare/secrets";
import { settingsFromEnv } from "../../server/src/plugs/cloudflare/settings";
import { OWNER_COOKIE, ownerSignIn } from "../../server/src/plugs/cloudflare/signin";

export const OWNER = "owner";
export const AGENTS = "agents";
/** Where the server "lives": the address a plugin under test is given is ORIGIN + API. */
export const ORIGIN = "https://nexus.example.test";
export const API = NEXUS_BASE;
/** Where the server's approval page is: the link a device is handed opens it. */
export const APPROVE_PATH = SERVER_APPROVE_PATH;

const MIGRATIONS = join(import.meta.dirname, "../../server/migrations");

// ── the answers a test reads ─────────────────────────────────────────────────

export interface Answer {
  status: number;
  /** The parsed JSON, or null when the answer was not JSON. */
  body: any;
  text: string;
}

export type Who = { cookie: string } | { bearer: string } | { authorization: string } | null;

const hex = (count: number): string => randomBytes(count).toString("hex");

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) q.set(key, String(value));
  const text = q.toString();
  return text ? `?${text}` : "";
}

export class RealNexus {
  /** The owner's session, as the cookie a browser signed in as the owner would send. */
  readonly ownerCookie: string;

  private readonly db = new DatabaseSync(":memory:");
  private readonly host: NexusHost;

  private constructor(secret: string) {
    this.ownerCookie = `${OWNER_COOKIE}=${secret}`;
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
      this.db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    }
    const env = { NEXUS_OWNER: OWNER, NEXUS_OWNER_SECRET: secret };
    const settings = settingsFromEnv(env);
    this.host = { sql: sqlOver(this.db), clock: { now: () => Date.now() }, secrets: workerSecrets, signIn: ownerSignIn(env, settings), settings };
  }

  /** A server with its tables made and the identity `agents` made the way an operator makes it. */
  static async open(): Promise<RealNexus> {
    const nexus = new RealNexus(hex(32));
    const made = await nexus.send("POST", `${API}/identity`, { cookie: nexus.ownerCookie }, { name: AGENTS, kind: "agent" });
    if (made.status !== 200) throw new Error(`The server would not make the identity ${AGENTS}: ${made.text}`);
    return nexus;
  }

  /** The text of every row of every table in the server's database, so a test can look for text that must not be there (the same look the server's own no-plaintext test takes). */
  everythingStored(): string {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    return tables
      .map(({ name }) => `${name}: ${JSON.stringify(this.db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all(), (_, value) => (typeof value === "bigint" ? Number(value) : value))}`)
      .join("\n");
  }

  /** No notes and no versions, so a test starts from a feed that begins at its own first change. Identities and tokens stay. */
  emptyNotes(): void {
    this.db.exec("DELETE FROM nexus_versions");
    this.db.exec("DELETE FROM nexus_notes");
  }

  /** Answers one request to the API: the server's own `runNexus`. */
  fetch(request: Request): Promise<Response> {
    return runNexus(request, this.host);
  }

  // ── the calls a test makes, as a given caller ──────────────────────────────

  /** One request as `who`. */
  async send(method: string, path: string, who: Who, body?: unknown): Promise<Answer> {
    const headers: Record<string, string> = {};
    if (who && "cookie" in who) headers.cookie = who.cookie;
    if (who && "bearer" in who) headers.authorization = `Bearer ${who.bearer}`;
    if (who && "authorization" in who) headers.authorization = who.authorization;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetch(
      new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }),
    );
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed, text };
  }

  /** The store's routes, called as `who`. A note is named by its id and sent as a blob (base64) under a key number. */
  vault(who: Who) {
    const get = (route: string, params: Record<string, string | number | undefined>) => this.send("GET", `${API}/${route}${query(params)}`, who);
    const post = (route: string, body: unknown) => this.send("POST", `${API}/${route}`, who, body);
    return {
      save: (id: string, blob: string, options: { base?: number; kid?: number } = {}) => post("save", { id, base: options.base ?? 0, kid: options.kid ?? 1, blob }),
      note: (id: string, version?: number) => get("note", { id, version }),
      history: (id: string) => get("history", { id }),
      list: () => get("list", {}),
      changes: (after?: string | number, limit?: number) => get("changes", { after, limit }),
      remove: (id: string, base: number) => post("delete", { id, base }),
      wraps: () => get("wraps", {}),
    };
  }

  /** The routes only the owner may call. */
  manage(who: Who) {
    return {
      tokens: () => this.send("GET", `${API}/tokens`, who),
      revoke: (id: string) => this.send("POST", `${API}/token/revoke`, who, { id }),
    };
  }

  /** The device's calls, and the owner's answers to them. `who` is whoever makes the call. */
  device(who: Who = null) {
    const post = (route: string, body: unknown) => this.send("POST", `${API}/device/${route}`, who, body);
    return {
      start: (identity: string, label: string) => post("start", { identity, label }),
      pending: (code: string) => this.send("GET", `${API}/device/pending${query({ code })}`, who),
      approve: (code: string) => post("approve", { code }),
      deny: (code: string) => post("deny", { code }),
      poll: (secret: string) => post("poll", { secret }),
    };
  }
}
