// What Nexus's logic needs from the machine it runs on, and nothing else.
//
// Everything beside this file that is not under plugs/ calls ONLY these interfaces: never `env.NEXUS_DB`, never a
// Cloudflare type. A host builds a NexusHost from plugs (plugs/cloudflare today). A host that is not Cloudflare
// writes its own plug: one SqlDb (a Postgres host rewrites the placeholders), a Clock, Secrets, a NexusSignIn and
// the settings, and changes nothing else.
//
// THE SQL CONTRACT. `sql` speaks the common ground of SQLite and Postgres:
//   - `?` placeholders, in order. (A Postgres plug rewrites them to $1, $2, ...)
//   - values are text, whole numbers or null. Booleans are 0 and 1 INTEGERs. Encrypted bytes are kept as base64 text.
//   - no SQLite-only functions or syntax; src/portable.test.ts reads every source and refuses them.
//   - a `batch` is ONE TRANSACTION: every statement is applied or none is. Every write Nexus makes relies on it.
//   - rows come back as plain objects keyed by column name, counts as JS numbers.

export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params: readonly SqlValue[];
}

export interface RunResult {
  /** Rows the statement inserted, updated or deleted. */
  changes: number;
}

export interface SqlDb {
  /** The first row, or null when there is none. */
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult>;
  /** The statements in order, in one transaction. If any fails, none of them took effect. */
  batch(statements: readonly SqlStatement[]): Promise<RunResult[]>;
}

/** A statement for `batch`, written like a call: stmt("DELETE FROM t WHERE id = ?", id). */
export const stmt = (sql: string, ...params: SqlValue[]): SqlStatement => ({ sql, params });

/** The time, as unix milliseconds. A host (and a test) can say what time it is. */
export interface Clock {
  now(): number;
}

/** The things only the machine can give: random bytes, and SHA-256. */
export interface Secrets {
  /** `count` random bytes that cannot be guessed (a token, a code, an id). */
  random(count: number): Uint8Array;
  /** SHA-256 of the text, as 64 lowercase hex characters. Tokens are long and random, so a plain hash is enough. */
  hash(text: string): Promise<string>;
  /** SHA-256 of the bytes, as 64 lowercase hex characters: the fingerprint kept with every encrypted note (hash.ts). */
  hashBytes(bytes: Uint8Array): Promise<string>;
}

/** Who a sign-in says is calling. `identity` is the name of an identity (caller.ts says what a caller is). */
export interface SignedIn {
  identity: string;
}

/**
 * Sign-in with a browser session. Nexus never reads a cookie itself: it asks this. Only the owner's own session is
 * let in, as the identity named by `settings.owner`; a plug that finds anyone else answers null. Everything else
 * that calls Nexus brings a bearer token, which Nexus checks against its own tokens (identities.ts), so no plug is
 * needed for that.
 */
export interface NexusSignIn {
  /** Who is making this request with a session, or null when it is nobody Nexus lets in. */
  identify(request: Request): Promise<SignedIn | null>;
}

/**
 * What the person who runs this Nexus has chosen. Each setting is optional, and left out means none.
 *
 *   owner    The name of the identity that alone may manage identities, tokens and the key wraps and answer a
 *            device's sign-in. None means Nexus has no owner, so no browser session is let in and nobody can
 *            approve a device: Nexus stays closed until an owner is named.
 *   address  The public address of this Nexus (such as https://nexus.example.org), used to build the link a device
 *            is handed to open the approval page. None means the address the request itself arrived on.
 */
export interface NexusSettings {
  owner: string | null;
  address: string | null;
}

export interface NexusHost {
  sql: SqlDb;
  clock: Clock;
  secrets: Secrets;
  signIn: NexusSignIn;
  settings: NexusSettings;
}
