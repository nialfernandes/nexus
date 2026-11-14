/**
 * Every reason this package refuses to do something has one of these codes.
 * The codes are part of the format description (docs/FORMAT.md, "Errors"), so
 * another implementation can report the same names.
 */
export const ERROR_CODES = [
  // A key, id, number or other argument is not what the function takes.
  "invalid-argument",
  // The data is shorter than the smallest valid blob or wrap.
  "truncated",
  // The first byte names a format version this code does not know.
  "unsupported-version",
  // The data has the right length but its layout is wrong.
  "malformed",
  // A note blob did not authenticate: wrong key, wrong ids, or damaged bytes.
  // The cipher cannot tell these apart, so neither does this code.
  "decryption-failed",
  // A wrap did not authenticate: wrong Recovery Key, wrong password, wrong
  // ids, or damaged bytes. The same reasoning as "decryption-failed".
  "unwrap-failed",
  // A password wrap names Argon2id settings outside what this version accepts.
  "unsupported-parameters",
  // The written Recovery Key has a wrong length, a character outside the
  // alphabet, or check characters that do not match.
  "bad-recovery-key",
  // A sealed approval opened, but it is for another vault.
  "wrong-vault",
] as const;

export type NexusCryptoErrorCode = (typeof ERROR_CODES)[number];

export class NexusCryptoError extends Error {
  readonly code: NexusCryptoErrorCode;

  constructor(code: NexusCryptoErrorCode, message: string) {
    super(message);
    this.name = "NexusCryptoError";
    this.code = code;
  }
}
