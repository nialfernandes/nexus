import type { VaultContext } from "./associated-data.js";
import {
  concatBytes,
  fromUtf8,
  lengthPrefixed,
  readU32be,
  requireBytes,
  requireId,
  requireKid,
  u32be,
  utf8,
} from "./bytes.js";
import { APPROVAL_CODE_LABEL, APPROVAL_CODE_SYMBOLS, FORMAT_VERSION, KEY_BYTES, Kind, MAX_ID_BYTES, RECOVERY_ALPHABET } from "./constants.js";
import { NexusCryptoError } from "./errors.js";
import { normalise, symbolsFromBits } from "./recovery-key.js";
import { loadSodium } from "./sodium.js";

/** A device's or agent's own X25519 keys. The private half never leaves it. */
export interface DeviceKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** What a device learns when it opens an approval. */
export interface OpenedApproval {
  vaultKey: Uint8Array;
  kid: number;
  /** The vault the key is for, as the approving device wrote it into the approval. */
  vaultId: string;
}

/** A fresh X25519 key pair, for a device or an agent that is to be sent the vault key. */
export async function generateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const sodium = await loadSodium();
  const pair = sodium.crypto_box_keypair();
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/**
 * Seals the vault key to one device's public key, so only that device can open
 * it. What is sealed is: version, kind, kid, the vault id (with its length) and
 * the key. A sealed box does not say who made it: an approval alone is not
 * authenticated, and must be checked by the matching code the device approval
 * flow shows on both screens (section 7.3 of docs/FORMAT.md).
 */
export async function sealApproval(
  devicePublicKey: Uint8Array,
  vaultKey: Uint8Array,
  context: VaultContext,
): Promise<Uint8Array> {
  const sodium = await loadSodium();
  requireBytes(devicePublicKey, sodium.crypto_box_PUBLICKEYBYTES, "devicePublicKey");
  requireBytes(vaultKey, KEY_BYTES, "vaultKey");
  const payload = concatBytes(
    Uint8Array.of(FORMAT_VERSION, Kind.approval),
    u32be(requireKid(context.kid)),
    lengthPrefixed(requireId(context.vaultId, "vaultId")),
    vaultKey,
  );
  try {
    return sodium.crypto_box_seal(payload, devicePublicKey);
  } finally {
    sodium.memzero(payload);
  }
}

/**
 * Opens an approval with the device's key pair. A device that already knows
 * its vault passes `expected.vaultId`, and an approval for another vault throws
 * "wrong-vault". A new device that does not know its vault yet passes nothing
 * and is told the vault by the approval. Opening only reads the approval: it
 * does not say who sealed it. Whoever opens one must not use what it holds
 * until the person has checked its matching code (`approvalCode`).
 */
export async function openApproval(
  keyPair: DeviceKeyPair,
  sealed: Uint8Array,
  expected?: { vaultId: string },
): Promise<OpenedApproval> {
  const sodium = await loadSodium();
  requireBytes(keyPair?.publicKey, sodium.crypto_box_PUBLICKEYBYTES, "publicKey");
  requireBytes(keyPair?.privateKey, sodium.crypto_box_SECRETKEYBYTES, "privateKey");
  const expectedVaultId = expected === undefined ? undefined : requireId(expected.vaultId, "vaultId");
  if (!(sealed instanceof Uint8Array)) {
    throw new NexusCryptoError("invalid-argument", "sealed must be a Uint8Array");
  }
  if (sealed.length < sodium.crypto_box_SEALBYTES) {
    throw new NexusCryptoError("truncated", "approval is shorter than a sealed box");
  }
  let payload: Uint8Array;
  try {
    payload = sodium.crypto_box_seal_open(sealed, keyPair.publicKey, keyPair.privateKey);
  } catch {
    throw new NexusCryptoError("unwrap-failed", "could not open the approval: it is not for this key, or it was changed");
  }
  try {
    return parseApproval(payload, expectedVaultId);
  } finally {
    sodium.memzero(payload);
  }
}

function parseApproval(payload: Uint8Array, expectedVaultId: string | undefined): OpenedApproval {
  const fixed = 2 + 4 + 4;
  if (payload.length < fixed) {
    throw new NexusCryptoError("truncated", "approval payload is too short");
  }
  if (payload[0] !== FORMAT_VERSION) {
    throw new NexusCryptoError("unsupported-version", `approval has format version ${payload[0]}`);
  }
  if (payload[1] !== Kind.approval) {
    throw new NexusCryptoError("malformed", "approval has the wrong kind");
  }
  const kid = readU32be(payload, 2);
  const idLength = readU32be(payload, 6);
  if (idLength === 0 || idLength > MAX_ID_BYTES || payload.length !== fixed + idLength + KEY_BYTES) {
    throw new NexusCryptoError("malformed", "approval payload has the wrong length");
  }
  const vaultId = fromUtf8(payload.subarray(fixed, fixed + idLength));
  if (expectedVaultId !== undefined && vaultId !== expectedVaultId) {
    throw new NexusCryptoError("wrong-vault", "the approval is for a different vault");
  }
  return { vaultKey: payload.slice(fixed + idLength), kid, vaultId };
}

/** What the matching code is made from (section 7.4 of docs/FORMAT.md). */
export interface ApprovalCodeInput {
  /** The public key of the device that is being approved: the one the approval was sealed to. */
  newDevicePublicKey: Uint8Array;
  /** The public key of the device that approved it. */
  approverPublicKey: Uint8Array;
  /** The number of the vault key the approval holds. */
  kid: number;
  /** The approval as it was sealed (what `sealApproval` returned), byte for byte. */
  sealed: Uint8Array;
}

/**
 * The matching code a device approval shows on both screens, such as `7K3M9-0B1XT`. It is the first 50 bits of
 * SHA-256 over a label, both device public keys, the kid and SHA-256 of the sealed approval, so an approval that was
 * made or swapped by anyone but the approving device gives the new device another code than the approving device
 * shows. The new device must not use the key in an approval until the person has seen the two codes match.
 */
export async function approvalCode(input: ApprovalCodeInput): Promise<string> {
  const sodium = await loadSodium();
  requireBytes(input?.newDevicePublicKey, sodium.crypto_box_PUBLICKEYBYTES, "newDevicePublicKey");
  requireBytes(input?.approverPublicKey, sodium.crypto_box_PUBLICKEYBYTES, "approverPublicKey");
  requireKid(input?.kid);
  if (!(input.sealed instanceof Uint8Array) || input.sealed.length === 0) {
    throw new NexusCryptoError("invalid-argument", "sealed must be a non-empty Uint8Array");
  }
  const digest = sodium.crypto_hash_sha256(
    concatBytes(utf8(APPROVAL_CODE_LABEL), input.newDevicePublicKey, input.approverPublicKey, u32be(input.kid), sodium.crypto_hash_sha256(input.sealed)),
  );
  const symbols = symbolsFromBits(digest, APPROVAL_CODE_SYMBOLS);
  return `${symbols.slice(0, APPROVAL_CODE_SYMBOLS / 2)}-${symbols.slice(APPROVAL_CODE_SYMBOLS / 2)}`;
}

/**
 * What a person typed from the other device's screen, written the way `approvalCode` writes it, or null when it is
 * not a code. Capitals or small letters, a hyphen, spaces or none do not matter, and O reads as 0, I and L as 1.
 */
export function readApprovalCode(text: string): string | null {
  if (typeof text !== "string") return null;
  const symbols = normalise(text);
  if (symbols.length !== APPROVAL_CODE_SYMBOLS || [...symbols].some((symbol) => !RECOVERY_ALPHABET.includes(symbol))) return null;
  return `${symbols.slice(0, APPROVAL_CODE_SYMBOLS / 2)}-${symbols.slice(APPROVAL_CODE_SYMBOLS / 2)}`;
}
