// The vault key's wraps: the vault key locked under the Recovery Key (the Recovery wrap) and, if the person chose one,
// under a password (the password wrap). Each is opaque bytes made on a device (docs/FORMAT.md section 7), kept as
// base64 with the number of the vault key (`kid`) it holds. The server cannot open a wrap: it only keeps them, so a
// new device that has the Recovery Key or the password can fetch the wrap and unlock the vault key.
//
// Anyone signed in may read the wraps. Only the owner may write or remove one, so a token handed to an agent cannot
// replace a wrap.

import { bytesOf, kidOf, MAX_WRAP_BYTES, onlyFields } from "./fields";
import type { NexusHost } from "./ports";
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

/** Keeps a wrap, replacing the one of the same kind for the same vault key. */
export async function setWrap(host: NexusHost, caller: Caller, input: Record<string, unknown>): Promise<{ result: "saved"; kid: number; kind: WrapKind }> {
  onlyFields(input, ["kid", "kind", "wrap"], "A wrap");
  const kid = kidOf(input.kid);
  const kind = kindOf(input.kind);
  const { text } = bytesOf(input.wrap, "wrap", MAX_WRAP_BYTES);
  await host.sql.run(
    `INSERT INTO nexus_wraps (kid, kind, wrap, writer, saved_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (kid, kind) DO UPDATE SET wrap = excluded.wrap, writer = excluded.writer, saved_at = excluded.saved_at`,
    [kid, kind, text, caller.name, host.clock.now()],
  );
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

