/** The format version written into every blob and wrap, and into the associated data. */
export const FORMAT_VERSION = 1;

export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;
export const SALT_BYTES = 16;

/**
 * What a piece of encrypted data is. It is the second byte of every wrap, the
 * second byte of the associated data, and the second byte of a sealed approval,
 * so data made for one purpose cannot be passed off as another.
 */
export const Kind = {
  note: 1,
  recoveryWrap: 2,
  passwordWrap: 3,
  approval: 4,
} as const;

/** The label HKDF is given for the key that wraps the vault key under the Recovery Key. */
export const RECOVERY_KDF_LABEL = "nexus v1 recovery";

/** Mixed into the hash that makes the Recovery Key's check characters. */
export const RECOVERY_CHECK_LABEL = "nexus v1 recovery check";

/** Argon2id settings a password wrap is written with. Memory is in KiB. */
export const PASSWORD_KDF = {
  memoryKiB: 65_536,
  iterations: 3,
  parallelism: 1,
} as const;

/**
 * What a password wrap may name when it is read. The wrap travels through the
 * server, so a hostile server could ask for a huge amount of memory; these
 * limits stop that. The floor is the written settings: nothing weaker is read.
 */
export const PASSWORD_KDF_LIMITS = {
  memoryKiB: { min: 65_536, max: 262_144 },
  iterations: { min: 3, max: 12 },
  parallelism: { min: 1, max: 1 },
} as const;

/** Longest vault id, note id or other id, in UTF-8 bytes. */
export const MAX_ID_BYTES = 1024;

/** Largest note record (path and text as JSON) that will be encrypted, in bytes. */
export const MAX_RECORD_BYTES = 1 << 28;

/** The largest kid: it is stored as an unsigned 32-bit number. */
export const MAX_KID = 0xffff_ffff;

/** The 32 symbols a Recovery Key is written in: digits and capitals without I, L, O and U. */
export const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
