// The key steps of setting a vault up, written once for everything that sets one up: the `nexus-agent` command (create-vault and
// approve-agent, src/cli/) and the Nexus plugin's setup controller (plugin/src/vault-setup.ts), which takes this file as
// `@nexus/agent/setup`. Neither makes a key or opens a wrap in a way of its own: they call these.
//
// Nothing here talks to Nexus, asks a person anything or prints anything. Each step takes what it needs and answers with plain data, so
// the caller does the asking and the sending and says what happened in its own words. It runs in Node, in a Worker and in a phone's
// app, like the rest of the library, and (like the rest) never writes a key anywhere: a key it was handed or made is the caller's to
// overwrite when done, and every step that makes a copy of one overwrites its own copy.
//
// This file is not part of the single-file library an agent imports (index.ts does not export it).

import {
  createPasswordWrap, deviceKeyCode, formatRecoveryKey, generateRecoveryKey, generateVaultKey, normaliseRecoveryText, NexusCryptoError,
  openPasswordWrap, parseRecoveryKey, sealApproval, unwrapVaultKeyWithRecoveryKey, wrapVaultKeyWithRecoveryKey,
} from "@nexus/crypto";
import { decodeBase64, encodeBase64, encodeBase64Url } from "./base64";

/** The number of the first vault key. */
export const FIRST_KID = 1;
/** How many times the check characters may be typed before a setup gives up. */
export const TYPE_BACK_TRIES = 3;
/** What is said when the check characters typed back are not the last group of the Recovery Key. */
export const TYPE_BACK_WRONG = "Those are not the last four characters of the key. Nothing was sent.";
/** A Recovery Key is written in this many groups of four characters. */
export const RECOVERY_KEY_GROUPS = 14;
/** How many of those groups the plugin asks to be typed back. */
export const TYPE_BACK_GROUPS = 3;
/** An X25519 public key is this many bytes. */
export const PUBLIC_KEY_BYTES = 32;

/** What the vault key, the vault id and the Recovery Key are, while a vault is being made. All of it is in memory only. */
export interface NewVault {
  vaultKey: Uint8Array;
  recoveryKey: Uint8Array;
  /** Names the vault. Not secret. */
  vaultId: string;
  kid: number;
  /** The Recovery Key as a person writes it down: 14 groups of 4 characters joined by hyphens. */
  recoveryKeyText: string;
  /** The last group of four characters of the Recovery Key: what the person types back to show the key was written down. */
  checkGroup: string;
}

/** Makes the vault key, the vault id and the Recovery Key for a vault that does not exist yet. Nothing is sent or kept. */
export async function makeNewVault(): Promise<NewVault> {
  const vaultKey = await generateVaultKey();
  const recoveryKey = await generateRecoveryKey();
  const vaultId = encodeBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const recoveryKeyText = await formatRecoveryKey(recoveryKey);
  return {
    vaultKey,
    recoveryKey,
    vaultId,
    kid: FIRST_KID,
    recoveryKeyText,
    checkGroup: recoveryKeyText.slice(recoveryKeyText.lastIndexOf("-") + 1),
  };
}

/** Overwrites the two keys of a vault that was made and is not going to be used. */
export function forgetNewVault(vault: Pick<NewVault, "vaultKey" | "recoveryKey">): void {
  vault.vaultKey.fill(0);
  vault.recoveryKey.fill(0);
}

/** True when `typed` is the check characters: capitals or small letters, hyphens and spaces do not matter, and O reads as 0, I and L as 1. */
export const isTypedBack = (typed: string, checkGroup: string): boolean => normaliseRecoveryText(typed) === normaliseRecoveryText(checkGroup);

/**
 * Which groups the person is asked to type back: `TYPE_BACK_GROUPS` of the key's groups, by number from 1, in the order they are written.
 * Chosen at random by the random bytes in `random` (one byte is used for each draw, so any bytes will do), and never the same group twice.
 */
export function groupsToTypeBack(random: Uint8Array): number[] {
  const left = Array.from({ length: RECOVERY_KEY_GROUPS }, (_, index) => index + 1);
  const chosen: number[] = [];
  for (let draw = 0; draw < TYPE_BACK_GROUPS; draw++) {
    const [group] = left.splice((random[draw] ?? 0) % left.length, 1);
    chosen.push(group!);
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * The groups, by number, that were not typed back right. `typed` is what was typed for `asked` groups one after the other, four
 * characters each (capitals or small letters, hyphens and spaces do not matter, O reads as 0, I and L as 1). A group that is short
 * or missing is wrong. Empty when every asked group matches the written key.
 */
export function wrongGroups(typed: string, recoveryKeyText: string, asked: readonly number[]): number[] {
  const written = recoveryKeyText.split("-");
  const symbols = normaliseRecoveryText(typed);
  return asked.filter((group, position) => normaliseRecoveryText(symbols.slice(position * 4, position * 4 + 4)) !== normaliseRecoveryText(written[group - 1] ?? ""));
}

/** What `POST /wrap` is sent to keep a new vault's Recovery wrap: the vault id goes with it, and the first wrap sets it. */
export interface RecoveryWrapRequest {
  kid: number;
  kind: "recovery";
  /** Base64. */
  wrap: string;
  vaultId: string;
}

/** The vault key locked under the Recovery Key, as the body of `POST /wrap`. */
export async function recoveryWrapRequest(vault: Pick<NewVault, "vaultKey" | "recoveryKey" | "vaultId" | "kid">): Promise<RecoveryWrapRequest> {
  const wrap = await wrapVaultKeyWithRecoveryKey(vault.recoveryKey, vault.vaultKey, { vaultId: vault.vaultId, kid: vault.kid });
  return { kid: vault.kid, kind: "recovery", wrap: encodeBase64(wrap), vaultId: vault.vaultId };
}

/** What `POST /wrap` is sent to keep a password wrap: the same vault id as the Recovery wrap, which is sent first. */
export interface PasswordWrapRequest {
  kid: number;
  kind: "password";
  /** Base64. */
  wrap: string;
  vaultId: string;
}

/** The vault key locked under a password (Argon2id, `PASSWORD_KDF`), as the body of `POST /wrap`. The password is normalised (NFKC) by the encryption package. */
export async function passwordWrapRequest(vault: Pick<NewVault, "vaultKey" | "vaultId" | "kid">, password: string): Promise<PasswordWrapRequest> {
  const wrap = await createPasswordWrap(password, vault.vaultKey, { vaultId: vault.vaultId, kid: vault.kid });
  return { kid: vault.kid, kind: "password", wrap: encodeBase64(wrap), vaultId: vault.vaultId };
}

// ── what Nexus holds ─────────────────────────────────────────────────────────

/** True when what `GET /wraps` answered says the server holds a vault: a wrap, or a vault id. */
export function holdsAVault(held: { wraps?: unknown; vaultId?: unknown }): boolean {
  return (Array.isArray(held.wraps) && held.wraps.length > 0) || typeof held.vaultId === "string";
}

/** The newest wrap of one kind that Nexus holds, and the vault id it was made with. */
export interface WrapHeld {
  vaultId: string;
  kid: number;
  wrap: Uint8Array;
}
/** The newest Recovery wrap Nexus holds, and the vault id it was made with. */
export type RecoveryWrapHeld = WrapHeld;

type WrapsAnswer = { wraps?: unknown; vaultId?: unknown };
type WrapKind = "recovery" | "password";

/** True when what `GET /wraps` answered says the server holds a wrap of `kind`. */
export function holdsAWrap(held: WrapsAnswer, kind: WrapKind): boolean {
  return Array.isArray(held.wraps) && held.wraps.some((w) => (w as { kind?: unknown } | null)?.kind === kind);
}

/** The newest wrap of `kind` in what `GET /wraps` answered, or the reason there is none. */
function newestWrap(held: WrapsAnswer, kind: WrapKind): { ok: true; held: WrapHeld } | { ok: false; reason: "no-vault-id" | "no-wrap" | "bad-wrap" } {
  if (typeof held.vaultId !== "string") return { ok: false, reason: "no-vault-id" };
  const vaultId: string = held.vaultId;
  const wraps = (Array.isArray(held.wraps) ? held.wraps : []) as Array<{ kid: number; kind: string; wrap: string }>;
  const newest = wraps.filter((w) => w.kind === kind).sort((a, b) => b.kid - a.kid)[0];
  if (newest === undefined) return { ok: false, reason: "no-wrap" };
  const wrap = decodeBase64(newest.wrap);
  if (wrap === null) return { ok: false, reason: "bad-wrap" };
  return { ok: true, held: { vaultId, kid: newest.kid, wrap } };
}

/**
 * The newest Recovery wrap in what `GET /wraps` answered, or the reason there is none: the server holds no vault id, it holds no
 * Recovery wrap, or the wrap it holds is not base64.
 */
export function newestRecoveryWrap(held: WrapsAnswer): { ok: true; held: RecoveryWrapHeld } | { ok: false; reason: "no-vault-id" | "no-recovery-wrap" | "bad-wrap" } {
  const found = newestWrap(held, "recovery");
  return found.ok ? found : { ok: false, reason: found.reason === "no-wrap" ? "no-recovery-wrap" : found.reason };
}

/** The newest password wrap in what `GET /wraps` answered, or the reason there is none (as `newestRecoveryWrap`). */
export function newestPasswordWrap(held: WrapsAnswer): { ok: true; held: WrapHeld } | { ok: false; reason: "no-vault-id" | "no-password-wrap" | "bad-wrap" } {
  const found = newestWrap(held, "password");
  return found.ok ? found : { ok: false, reason: found.reason === "no-wrap" ? "no-password-wrap" : found.reason };
}

/** The keys a vault is unlocked with. */
export interface OpenedVault {
  vaultKey: Uint8Array;
  vaultId: string;
  kid: number;
}

/**
 * Opens the Recovery wrap with the Recovery Key as the person typed it. `empty`: nothing was typed. `incomplete`: not a whole Recovery
 * Key (a character is missing or mistyped). `wrong`: a whole Recovery Key that does not open this vault's wrap. The vault key that
 * is answered is the caller's to overwrite; the Recovery Key made here from the text is overwritten before this returns.
 */
export async function openRecoveryWrap(held: RecoveryWrapHeld, typedKey: string): Promise<{ ok: true; keys: OpenedVault } | { ok: false; reason: "empty" | "incomplete" | "wrong" }> {
  if (normaliseRecoveryText(typedKey) === "") return { ok: false, reason: "empty" };
  let recoveryKey: Uint8Array;
  try {
    recoveryKey = await parseRecoveryKey(typedKey);
  } catch (error) {
    if (!(error instanceof NexusCryptoError)) throw error;
    return { ok: false, reason: "incomplete" };
  }
  try {
    const vaultKey = await unwrapVaultKeyWithRecoveryKey(recoveryKey, held.wrap, { vaultId: held.vaultId, kid: held.kid });
    return { ok: true, keys: { vaultKey, vaultId: held.vaultId, kid: held.kid } };
  } catch (error) {
    if (!(error instanceof NexusCryptoError)) throw error;
    return { ok: false, reason: "wrong" };
  } finally {
    recoveryKey.fill(0);
  }
}

/**
 * Opens the password wrap with the password as the person typed it. `empty`: nothing was typed. `wrong`: not this vault's password
 * (the wrap did not open, which is all that can be told). `bad-wrap`: the wrap Nexus holds asks for Argon2id settings this version
 * does not accept, or is not a password wrap. The vault key that is answered is the caller's to overwrite.
 */
export async function openPasswordWrapHeld(held: WrapHeld, typed: string): Promise<{ ok: true; keys: OpenedVault } | { ok: false; reason: "empty" | "wrong" | "bad-wrap" }> {
  if (typed === "") return { ok: false, reason: "empty" };
  try {
    const vaultKey = await openPasswordWrap(typed, held.wrap, { vaultId: held.vaultId, kid: held.kid });
    return { ok: true, keys: { vaultKey, vaultId: held.vaultId, kid: held.kid } };
  } catch (error) {
    if (!(error instanceof NexusCryptoError)) throw error;
    return { ok: false, reason: error.code === "unwrap-failed" ? "wrong" : "bad-wrap" };
  }
}

// ── an agent's approval ──────────────────────────────────────────────────────

/** An agent's public key as a person pasted it (the PUBLIC KEY line of `nexus-agent keygen`): its 32 bytes, or null when it is not that. */
export function readAgentPublicKey(typed: string): Uint8Array | null {
  const bytes = decodeBase64(typed.trim());
  return bytes === null || bytes.length !== PUBLIC_KEY_BYTES ? null : bytes;
}

/** The short code of a public key, to read against the one `nexus-agent keygen` printed. */
export const publicKeyCode = (publicKey: Uint8Array): Promise<string> => deviceKeyCode(publicKey);

/** The vault key sealed to an agent's public key, as base64: what `nexus-agent approve-agent` prints and the agent reads. Nexus never sees it. */
export async function approvalForAgent(publicKey: Uint8Array, keys: OpenedVault): Promise<string> {
  return encodeBase64(await sealApproval(publicKey, keys.vaultKey, { vaultId: keys.vaultId, kid: keys.kid }));
}
