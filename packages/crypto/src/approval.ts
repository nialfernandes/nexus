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
} from "./bytes.js";
import { FORMAT_VERSION, KEY_BYTES, Kind, MAX_ID_BYTES } from "./constants.js";
import { NexusCryptoError } from "./errors.js";
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
 * Opens an approval with the device's key pair. `vaultId` is the vault the
 * device expects; an approval for another vault throws "wrong-vault".
 */
export async function openApproval(
  keyPair: DeviceKeyPair,
  sealed: Uint8Array,
  expected: { vaultId: string },
): Promise<OpenedApproval> {
  const sodium = await loadSodium();
  requireBytes(keyPair?.publicKey, sodium.crypto_box_PUBLICKEYBYTES, "publicKey");
  requireBytes(keyPair?.privateKey, sodium.crypto_box_SECRETKEYBYTES, "privateKey");
  const expectedVaultId = requireId(expected?.vaultId, "vaultId");
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

function parseApproval(payload: Uint8Array, expectedVaultId: string): OpenedApproval {
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
  if (vaultId !== expectedVaultId) {
    throw new NexusCryptoError("wrong-vault", "the approval is for a different vault");
  }
  return { vaultKey: payload.slice(fixed + idLength), kid };
}
