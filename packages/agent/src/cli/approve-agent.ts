// `nexus-agent approve-agent`: gives one agent the vault key. The person pastes the agent's public key and types the Recovery Key
// at a hidden prompt (never an argument, never shown). The command fetches the Recovery wrap and the vault id from Nexus, opens the
// vault key with the Recovery Key, seals it to the agent's public key, and PRINTS the sealed approval for the person to save beside
// the agent's private key.
//
// Nexus never sees the approval, so it cannot swap one: the person carries it from this terminal to the agent's secrets themselves
// (docs/THREAT-MODEL.md, "An agent's approval"). That is why this needs no matching code, as a device approval does.

import {
  deviceKeyCode, normaliseRecoveryText, NexusCryptoError, parseRecoveryKey, sealApproval, unwrapVaultKeyWithRecoveryKey,
} from "@nexus/crypto";
import { decodeBase64, encodeBase64 } from "../base64";
import { Nexus, refusal } from "../nexus";
import { Stop, type Io } from "./io";
import { ENV, LABEL } from "./labels";
import { Prompter } from "./prompt";
import { need } from "./settings";

/** An X25519 public key is this many bytes. */
const PUBLIC_KEY_BYTES = 32;

export async function approveAgent(io: Io): Promise<number> {
  const settings = need(io, [ENV.address, ENV.token]);
  const nexus = new Nexus(settings[ENV.address], settings[ENV.token], io.fetch);

  const held = await nexus.get("wraps");
  if (held.status !== 200) throw new Stop(refusal(held, "tell what it holds").message);
  if (typeof held.json.vaultId !== "string") {
    throw new Stop("This server holds no vault id, so there is nothing to approve an agent for. Set the vault up first (nexus-agent create-vault).");
  }
  const vaultId: string = held.json.vaultId;
  const wraps = (Array.isArray(held.json.wraps) ? held.json.wraps : []) as Array<{ kid: number; kind: string; wrap: string }>;
  const newest = wraps.filter((w) => w.kind === "recovery").sort((a, b) => b.kid - a.kid)[0];
  if (newest === undefined) throw new Stop("This server holds no Recovery wrap, so the vault key cannot be opened. Set the vault up first (nexus-agent create-vault).");
  const wrap = decodeBase64(newest.wrap);
  if (wrap === null) throw new Stop("The Recovery wrap Nexus holds is not base64, so it cannot be opened.");

  const prompter = new Prompter(io.stdin, io.stderr);
  try {
    const typedPublic = await prompter.line("The agent's public key (the PUBLIC KEY line of `nexus-agent keygen`): ");
    const publicKey = typedPublic === null ? null : decodeBase64(typedPublic.trim());
    if (publicKey === null || publicKey.length !== PUBLIC_KEY_BYTES) {
      throw new Stop("That is not an agent's public key: it is 32 bytes written as base64, the PUBLIC KEY line of `nexus-agent keygen`. Nothing was made.");
    }
    io.stderr.write(`Public key code: ${await deviceKeyCode(publicKey)} (it matches the PUBLIC KEY CODE keygen printed, if you pasted the right key)\n`);

    const typedKey = await prompter.line("Recovery Key (typing is hidden): ", { hidden: true });
    if (typedKey === null || normaliseRecoveryText(typedKey) === "") throw new Stop("No Recovery Key was given. Nothing was made.");
    let recoveryKey: Uint8Array;
    try {
      recoveryKey = await parseRecoveryKey(typedKey);
    } catch (error) {
      if (!(error instanceof NexusCryptoError)) throw error;
      throw new Stop("That is not a whole Recovery Key: a character is missing or mistyped. Nothing was made.");
    }

    let vaultKey: Uint8Array;
    try {
      vaultKey = await unwrapVaultKeyWithRecoveryKey(recoveryKey, wrap, { vaultId, kid: newest.kid });
    } catch (error) {
      if (!(error instanceof NexusCryptoError)) throw error;
      throw new Stop("That Recovery Key does not open this vault's Recovery wrap, so it is not this vault's Recovery Key. Nothing was made.");
    } finally {
      recoveryKey.fill(0);
    }
    try {
      const approval = await sealApproval(publicKey, vaultKey, { vaultId, kid: newest.kid });
      io.stdout.write(`${LABEL.approval}: ${encodeBase64(approval)}\n`);
    } finally {
      vaultKey.fill(0);
    }
    io.stderr.write(`Approved for the key above. Save the approval beside the agent's private key (it is the ${ENV.approval} the agent reads). Nexus never sees it.\n`);
    return 0;
  } finally {
    prompter.close();
  }
}
