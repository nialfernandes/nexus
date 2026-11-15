// The vault key's wraps: the vault key locked under the Recovery Key (the Recovery wrap) and, if the person chose one,
// under a password (the password wrap). Each is bytes made on a device (docs/FORMAT.md section 7), kept as base64 with
// the number of the vault key (`kid`) it holds. The server cannot open a wrap: it reads only its first two bytes and
// its length (header.ts), and keeps it, so a new device that has the Recovery Key or the password can fetch the wrap and
// unlock the vault key.
//
// THE VAULT ID. A wrap opens only with the vault id it was made with (docs/FORMAT.md section 7), and a device or an agent that
// holds only the Recovery Key has no other place to learn it. So the server keeps the id beside the wraps: the owner sends it with
// every wrap, the first one sets it, and after that a wrap made for another id is refused (409). The id is not secret. It is kept
// when every wrap is removed, because it names the vault the notes belong to, not the wraps.
//
// Anyone signed in may read the wraps and the vault id. Only the owner may write or remove a wrap, so a token handed to an agent
// cannot replace a wrap.

import { bytesOf, kidOf, MAX_WRAP_BYTES, onlyFields, vaultIdOf } from "./fields";
import { checkWrap } from "./header";
import type { NexusHost } from "./ports";
import { stmt } from "./ports";
import { Refusal } from "./refusal";
import type { Caller } from "./caller";

/** The two kinds of wrap, named as docs/FORMAT.md names them. */
export const WRAP_KINDS = ["recovery", "password"] as const;
export type WrapKind = (typeof WRAP_KINDS)[number];

export interface WrapRow {
  kid: number;
  kind: WrapKind;
  wrap: string;
  writer: string;
  saved_at: number;
}

function kindOf(value: unknown): WrapKind {
  if (typeof value !== "string" || !(WRAP_KINDS as readonly string[]).includes(value)) {
    throw new Refusal(400, `The wrap's kind has to be one of: ${WRAP_KINDS.join(", ")}.`);
  }
  return value as WrapKind;
}

/** The vault id the wraps were made with, or null before the first wrap was kept. */
export async function vaultId(host: NexusHost): Promise<string | null> {
  return (await host.sql.first<{ vault_id: string }>("SELECT vault_id FROM nexus_vault WHERE id = 1"))?.vault_id ?? null;
}

/**
 * Keeps a wrap, replacing the one of the same kind for the same vault key, and the vault id it was made with. The first wrap sets
 * the vault id; a wrap sent with another id is refused and nothing is kept. Everything is checked before anything is written, so a
 * wrap that is refused for its shape never leaves a vault id behind. The wrap is written only if the vault row holds its id, in
 * the same batch that makes the row, so two first wraps with different ids sent at the same moment cannot both be kept.
 */
export async function setWrap(host: NexusHost, caller: Caller, input: Record<string, unknown>): Promise<{ result: "saved"; kid: number; kind: WrapKind }> {
  onlyFields(input, ["kid", "kind", "wrap", "vaultId"], "A wrap");
  const kid = kidOf(input.kid);
  const kind = kindOf(input.kind);
  const id = vaultIdOf(input.vaultId);
  const { text, bytes } = bytesOf(input.wrap, "wrap", MAX_WRAP_BYTES);
  checkWrap(bytes, kind);
  const refused = new Refusal(409, "This server already holds a vault with another vault id. A wrap can only be kept for that one: read the vault id with the wraps.");
  if (((await vaultId(host)) ?? id) !== id) throw refused;
  const now = host.clock.now();
  const [, kept] = await host.sql.batch([
    stmt("INSERT INTO nexus_vault (id, vault_id, writer, saved_at) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO NOTHING", id, caller.writer, now),
    stmt(
      `INSERT INTO nexus_wraps (kid, kind, wrap, writer, saved_at)
       SELECT ?, ?, ?, ?, ? FROM nexus_vault WHERE vault_id = ?
       ON CONFLICT (kid, kind) DO UPDATE SET wrap = excluded.wrap, writer = excluded.writer, saved_at = excluded.saved_at`,
      kid, kind, text, caller.writer, now, id,
    ),
  ]);
  if (kept?.changes !== 1) throw refused;
  return { result: "saved", kid, kind };
}

export async function removeWrap(host: NexusHost, input: Record<string, unknown>): Promise<{ result: "removed"; kid: number; kind: WrapKind }> {
  onlyFields(input, ["kid", "kind"], "A wrap's removal");
  const kid = kidOf(input.kid);
  const kind = kindOf(input.kind);
  const done = await host.sql.run("DELETE FROM nexus_wraps WHERE kid = ? AND kind = ?", [kid, kind]);
  if (done.changes === 0) throw new Refusal(404, "There is no such wrap.");
  return { result: "removed", kid, kind };
}

/** Every wrap, by key number and then kind. */
export async function listWraps(host: NexusHost): Promise<WrapRow[]> {
  return host.sql.all<WrapRow>("SELECT * FROM nexus_wraps ORDER BY kid, kind");
}

