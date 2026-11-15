// Identities and their tokens.
//
// An identity is a name and a kind (person, agent or app). It has no folder rights: the folders are inside the
// encrypted notes, which the server cannot read, so an identity can use every note or none (caller.ts). The owner is
// the one identity that manages the others.
//
// A token is a long random string. Only its SHA-256 hash is kept, so the database holds nothing that can be used
// as a token. It belongs to one identity, has a label, and is turned away the moment it is revoked. Tokens are made
// by device approval (devices.ts), the only way one is got.

import { onlyFields } from "./fields";
import type { NexusHost, SqlStatement } from "./ports";
import { stmt } from "./ports";
import { Refusal } from "./refusal";
import { deviceWriter, ownerCaller, type Caller } from "./caller";

export const KINDS = ["person", "agent", "app"] as const;
export type Kind = (typeof KINDS)[number];

/** A name is lower case letters, digits and hyphens, starting with a letter or digit, so it reads the same everywhere it is written. */
export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

interface IdentityRow { name: string; kind: Kind }

/**
 * The caller for an identity: the owner (the `owner` setting) if it is that name, otherwise one who may use the notes and
 * nothing more. `writer` is who its saves are kept under (caller.ts): the identity's name unless a token says otherwise.
 */
export function loadCaller(host: NexusHost, name: string, writer: string = name): Caller {
  return name === host.settings.owner ? ownerCaller(name, writer) : { name, owner: false, writer };
}

/** Whether a name is an identity: the owner always is, whether or not its row has been made yet, and any other is a row. */
export async function identityExists(host: NexusHost, name: string): Promise<boolean> {
  if (name === host.settings.owner) return true;
  return (await host.sql.first<IdentityRow>("SELECT name, kind FROM nexus_identities WHERE name = ?", [name])) !== null;
}

/**
 * The statement that makes the row a token or a sign-in points at, for the owner, whose row is not seeded because
 * its name is a setting. It does nothing when the row is there. Any other identity was made by createIdentity, so
 * it already has its row.
 */
export function ownerRow(host: NexusHost, name: string): SqlStatement[] {
  if (name !== host.settings.owner) return [];
  return [stmt("INSERT INTO nexus_identities (name, kind, created_at) VALUES (?, 'person', ?) ON CONFLICT (name) DO NOTHING", name, host.clock.now())];
}

// ── managing (only the owner calls these) ────────────────────────────────────

export interface IdentityAnswer { name: string; kind: Kind }

/** Said to anyone who still sends folder rights: they are gone, and a silent drop would leave an identity wider than meant. */
const RIGHTS_GONE = "Folder rights are gone: a note's folder is inside the encrypted note, which Nexus cannot read, so an identity can use every note or none.";

export async function createIdentity(host: NexusHost, input: Record<string, unknown>): Promise<IdentityAnswer> {
  if ("rights" in input) throw new Refusal(400, RIGHTS_GONE);
  onlyFields(input, ["name", "kind"], "An identity");
  const { name, kind } = input;
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new Refusal(400, "An identity's name is lower case letters, digits and hyphens, such as lab-m or scribe.");
  }
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    throw new Refusal(400, "An identity's kind has to be person, agent or app.");
  }
  const taken = new Refusal(409, `There is already an identity called ${name}.`);
  if (await identityExists(host, name)) throw taken;

  try {
    await host.sql.run("INSERT INTO nexus_identities (name, kind, created_at) VALUES (?, ?, ?)", [name, kind, host.clock.now()]);
  } catch (error) {
    // Someone made the same name between the check and the write: the primary key refused it.
    if (await identityExists(host, name)) throw taken;
    throw error;
  }
  return { name, kind: kind as Kind };
}

// ── tokens ───────────────────────────────────────────────────────────────────

interface TokenRow {
  id: string;
  identity: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

/** The tokens that still work, newest first. Never the token itself, and nothing made from it. */
export async function listTokens(host: NexusHost) {
  const rows = await host.sql.all<TokenRow>(
    "SELECT id, identity, label, created_at, last_used_at FROM nexus_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC, id",
  );
  return rows.map((t) => ({ id: t.id, identity: t.identity, label: t.label, createdAt: t.created_at, lastUsedAt: t.last_used_at }));
}

export async function revokeToken(host: NexusHost, idInput: unknown): Promise<{ result: "revoked"; id: string }> {
  if (typeof idInput !== "string" || idInput === "") throw new Refusal(400, "Revoking a token needs its id.");
  const done = await host.sql.run("UPDATE nexus_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [host.clock.now(), idInput]);
  if (done.changes === 0) throw new Refusal(404, "There is no token with that id.");
  return { result: "revoked", id: idInput };
}

/** The caller a bearer token stands for, stamping the time it was used, or null for a token that is unknown or revoked. */
export async function authenticateToken(host: NexusHost, token: string): Promise<Caller | null> {
  const row = await host.sql.first<{ id: string; identity: string }>(
    "SELECT id, identity FROM nexus_tokens WHERE token_hash = ? AND revoked_at IS NULL",
    [await host.secrets.hash(token)],
  );
  if (!row) return null;
  await host.sql.run("UPDATE nexus_tokens SET last_used_at = ? WHERE id = ?", [host.clock.now(), row.id]);
  return loadCaller(host, row.identity, deviceWriter(row.id));
}
