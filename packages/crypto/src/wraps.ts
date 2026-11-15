import { aeadOpen, aeadSeal } from "./aead.js";
import { buildAssociatedData, type VaultContext } from "./associated-data.js";
import { concatBytes, hasLoneSurrogate, readU32be, requireBytes, u32be, utf8 } from "./bytes.js";
import {
  FORMAT_VERSION,
  KEY_BYTES,
  Kind,
  NONCE_BYTES,
  PASSWORD_KDF,
  PASSWORD_KDF_LIMITS,
  RECOVERY_KDF_LABEL,
  SALT_BYTES,
  TAG_BYTES,
} from "./constants.js";
import { NexusCryptoError } from "./errors.js";
import { PASSWORD_HEADER_BYTES, PASSWORD_WRAP_BYTES, RECOVERY_WRAP_BYTES } from "./format.js";
import { hkdfSha256 } from "./hkdf.js";
import { loadSodium, type Sodium } from "./sodium.js";

export { PASSWORD_WRAP_BYTES, RECOVERY_WRAP_BYTES };

/** The key that locks the vault key under the Recovery Key: HKDF-SHA-256 with the fixed label. */
export function recoveryWrapKey(sodium: Sodium, recoveryKey: Uint8Array): Uint8Array {
  return hkdfSha256(sodium, recoveryKey, new Uint8Array(0), utf8(RECOVERY_KDF_LABEL), KEY_BYTES);
}

/** Locks the vault key under the Recovery Key. The wrap is safe to keep on the server. */
export async function wrapVaultKeyWithRecoveryKey(
  recoveryKey: Uint8Array,
  vaultKey: Uint8Array,
  context: VaultContext,
): Promise<Uint8Array> {
  const sodium = await loadSodium();
  return sealRecoveryWrap(sodium, recoveryKey, vaultKey, context, sodium.randombytes_buf(NONCE_BYTES));
}

/** Gets the vault key back, or throws "unwrap-failed" when the Recovery Key or ids are not the ones used. */
export async function unwrapVaultKeyWithRecoveryKey(
  recoveryKey: Uint8Array,
  wrap: Uint8Array,
  context: VaultContext,
): Promise<Uint8Array> {
  const sodium = await loadSodium();
  requireBytes(recoveryKey, KEY_BYTES, "recoveryKey");
  const associatedData = buildAssociatedData(Kind.recoveryWrap, context, "");
  checkWrapShape(wrap, Kind.recoveryWrap, RECOVERY_WRAP_BYTES);
  const key = recoveryWrapKey(sodium, recoveryKey);
  try {
    return aeadOpen(sodium, key, wrap.subarray(2, 2 + NONCE_BYTES), associatedData, wrap.subarray(2 + NONCE_BYTES), "unwrap-failed");
  } finally {
    sodium.memzero(key);
  }
}

/** The recovery wrap with the nonce passed in; for tests only, see sealNote. */
export function sealRecoveryWrap(
  sodium: Sodium,
  recoveryKey: Uint8Array,
  vaultKey: Uint8Array,
  context: VaultContext,
  nonce: Uint8Array,
): Uint8Array {
  requireBytes(recoveryKey, KEY_BYTES, "recoveryKey");
  requireBytes(vaultKey, KEY_BYTES, "vaultKey");
  const associatedData = buildAssociatedData(Kind.recoveryWrap, context, "");
  const key = recoveryWrapKey(sodium, recoveryKey);
  try {
    return concatBytes(
      Uint8Array.of(FORMAT_VERSION, Kind.recoveryWrap),
      nonce,
      aeadSeal(sodium, key, nonce, associatedData, vaultKey),
    );
  } finally {
    sodium.memzero(key);
  }
}

/** The Argon2id settings a password wrap carries beside it. */
export interface PasswordKdfParameters {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/** Locks the vault key under a password, with Argon2id at the settings in PASSWORD_KDF. */
export async function createPasswordWrap(
  password: string,
  vaultKey: Uint8Array,
  context: VaultContext,
): Promise<Uint8Array> {
  const sodium = await loadSodium();
  return sealPasswordWrap(
    sodium,
    password,
    vaultKey,
    context,
    PASSWORD_KDF,
    sodium.randombytes_buf(SALT_BYTES),
    sodium.randombytes_buf(NONCE_BYTES),
  );
}

/**
 * Gets the vault key back with the password. The settings are read from the
 * wrap; settings outside PASSWORD_KDF_LIMITS are refused before any work is done.
 */
export async function openPasswordWrap(
  password: string,
  wrap: Uint8Array,
  context: VaultContext,
): Promise<Uint8Array> {
  const sodium = await loadSodium();
  const passwordBytes = passwordToBytes(password);
  const associatedData = buildAssociatedData(Kind.passwordWrap, context, "");
  checkWrapShape(wrap, Kind.passwordWrap, PASSWORD_WRAP_BYTES);
  const parameters = readPasswordParameters(wrap);
  checkPasswordParameters(parameters);
  const salt = wrap.subarray(PASSWORD_HEADER_BYTES - SALT_BYTES, PASSWORD_HEADER_BYTES);
  const key = derivePasswordKey(sodium, passwordBytes, salt, parameters);
  try {
    return aeadOpen(
      sodium,
      key,
      wrap.subarray(PASSWORD_HEADER_BYTES, PASSWORD_HEADER_BYTES + NONCE_BYTES),
      concatBytes(associatedData, wrap.subarray(0, PASSWORD_HEADER_BYTES)),
      wrap.subarray(PASSWORD_HEADER_BYTES + NONCE_BYTES),
      "unwrap-failed",
    );
  } finally {
    sodium.memzero(key);
    sodium.memzero(passwordBytes);
  }
}

/** The password wrap with the settings, salt and nonce passed in; for tests only, see sealNote. */
export function sealPasswordWrap(
  sodium: Sodium,
  password: string,
  vaultKey: Uint8Array,
  context: VaultContext,
  parameters: PasswordKdfParameters,
  salt: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  const passwordBytes = passwordToBytes(password);
  requireBytes(vaultKey, KEY_BYTES, "vaultKey");
  requireBytes(salt, SALT_BYTES, "salt");
  checkPasswordParameters(parameters);
  const associatedData = buildAssociatedData(Kind.passwordWrap, context, "");
  const header = concatBytes(
    Uint8Array.of(FORMAT_VERSION, Kind.passwordWrap),
    u32be(parameters.memoryKiB),
    u32be(parameters.iterations),
    u32be(parameters.parallelism),
    salt,
  );
  const key = derivePasswordKey(sodium, passwordBytes, salt, parameters);
  try {
    return concatBytes(
      header,
      nonce,
      aeadSeal(sodium, key, nonce, concatBytes(associatedData, header), vaultKey),
    );
  } finally {
    sodium.memzero(key);
    sodium.memzero(passwordBytes);
  }
}

/** Argon2id of the password and salt, 32 bytes. libsodium takes the memory in bytes and always uses one lane. */
export function derivePasswordKey(
  sodium: Sodium,
  passwordBytes: Uint8Array,
  salt: Uint8Array,
  parameters: PasswordKdfParameters,
): Uint8Array {
  return sodium.crypto_pwhash(
    KEY_BYTES,
    passwordBytes,
    salt,
    parameters.iterations,
    parameters.memoryKiB * 1024,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** The password as bytes: Unicode NFKC, then UTF-8, so the same typing gives the same key on every device. */
export function passwordToBytes(password: string): Uint8Array {
  if (typeof password !== "string" || password.length === 0 || hasLoneSurrogate(password)) {
    throw new NexusCryptoError("invalid-argument", "password must be a non-empty, well-formed string");
  }
  return utf8(password.normalize("NFKC"));
}

function readPasswordParameters(wrap: Uint8Array): PasswordKdfParameters {
  return {
    memoryKiB: readU32be(wrap, 2),
    iterations: readU32be(wrap, 6),
    parallelism: readU32be(wrap, 10),
  };
}

function checkPasswordParameters(parameters: PasswordKdfParameters): void {
  const { memoryKiB, iterations, parallelism } = PASSWORD_KDF_LIMITS;
  const within = (value: number, range: { min: number; max: number }) =>
    Number.isInteger(value) && value >= range.min && value <= range.max;
  if (
    !within(parameters.memoryKiB, memoryKiB) ||
    !within(parameters.iterations, iterations) ||
    !within(parameters.parallelism, parallelism)
  ) {
    throw new NexusCryptoError(
      "unsupported-parameters",
      "the password wrap asks for Argon2id settings this version does not accept",
    );
  }
}

/** Length, version and kind, in that order, so the error names the first thing that is wrong. */
function checkWrapShape(wrap: Uint8Array, kind: number, expectedLength: number): void {
  if (!(wrap instanceof Uint8Array)) {
    throw new NexusCryptoError("invalid-argument", "wrap must be a Uint8Array");
  }
  if (wrap.length < expectedLength) {
    throw new NexusCryptoError("truncated", `wrap is ${wrap.length} bytes; it should be ${expectedLength}`);
  }
  if (wrap[0] !== FORMAT_VERSION) {
    throw new NexusCryptoError("unsupported-version", `wrap has format version ${wrap[0]}`);
  }
  if (wrap[1] !== kind) {
    throw new NexusCryptoError("malformed", `wrap has kind ${wrap[1]}, expected ${kind}`);
  }
  if (wrap.length > expectedLength) {
    throw new NexusCryptoError("malformed", `wrap is ${wrap.length} bytes; it should be ${expectedLength}`);
  }
}
