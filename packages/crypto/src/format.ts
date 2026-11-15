// How long the things Nexus writes are, and the two numbers that begin them. Nothing here is secret or runs any
// encryption: it is the layout of docs/FORMAT.md as numbers, in a file with no imports of its own beyond constants.ts,
// so a part of Nexus that only looks at the first bytes of a blob (the server, which never opens one) can take the
// numbers from here, as `@nexus/crypto/format`, without taking libsodium.

import { FORMAT_VERSION, KEY_BYTES, KID_BYTES, Kind, MIN_PADDED_RECORD_BYTES, NONCE_BYTES, SALT_BYTES, TAG_BYTES } from "./constants.js";

export { FORMAT_VERSION, Kind };

/** The bytes of a note blob before its ciphertext: version (1), kid (4) and nonce (24). */
export const NOTE_HEADER_BYTES = 1 + KID_BYTES + NONCE_BYTES;

/** The shortest note blob this library writes: the header, a record padded to its floor, and the tag (docs/FORMAT.md section 6). */
export const MIN_WRITTEN_NOTE_BLOB_BYTES = NOTE_HEADER_BYTES + MIN_PADDED_RECORD_BYTES + TAG_BYTES;

/** version, kind, nonce, then the vault key and its tag. */
export const RECOVERY_WRAP_BYTES = 2 + NONCE_BYTES + KEY_BYTES + TAG_BYTES;

/** version, kind, memory (KiB), iterations, parallelism, salt: the part that is read before the key is derived. */
export const PASSWORD_HEADER_BYTES = 2 + 4 + 4 + 4 + SALT_BYTES;

/** The password wrap: the header, nonce, then the vault key and its tag. */
export const PASSWORD_WRAP_BYTES = PASSWORD_HEADER_BYTES + NONCE_BYTES + KEY_BYTES + TAG_BYTES;
