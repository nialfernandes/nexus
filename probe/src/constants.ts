import manifest from "../manifest.json";

export const PROBE_VERSION: string = manifest.version;

// ---- What the checks use -------------------------------------------------

/** The size of the note that is encrypted and decrypted: 100 KiB. */
export const NOTE_BYTES = 100 * 1024;

/** The longest the libsodium load may take before it counts as failed. */
export const SODIUM_LOAD_LIMIT_MS = 30_000;

/**
 * Argon2id as the research chose it for the optional password step:
 * 64 MiB of memory, 3 passes, 1 lane, a 32-byte result.
 */
export const ARGON2_MEMORY_KIB = 64 * 1024;
export const ARGON2_PASSES = 3;
export const ARGON2_LANES = 1;
export const ARGON2_OUTPUT_BYTES = 32;

/** Past this the research treats Argon2id as too slow and falls back to scrypt. */
export const ARGON2_TOO_SLOW_MS = 60_000;

/** The fallback the research names: scrypt with N = 2^17, r = 8, p = 1. */
export const SCRYPT_COST_N = 2 ** 17;
export const SCRYPT_BLOCK_R = 8;
export const SCRYPT_PARALLEL_P = 1;
export const SCRYPT_OUTPUT_BYTES = 32;

// ---- Fixed inputs and the answers they must give -------------------------

/** Password and salt for the Argon2id and scrypt checks. */
export const KDF_PASSWORD = "correct horse battery staple";
export const KDF_SALT: readonly number[] = Array.from({ length: 16 }, (_, i) => i);

/**
 * What Argon2id (64 MiB, 3 passes, 1 lane) gives for the password and salt
 * above. Two independent implementations produced this: the reference C code
 * (npm package "argon2") and the pure-JavaScript @noble/hashes. The tests
 * recompute it with @noble/hashes every run.
 */
export const ARGON2_EXPECTED_HEX =
  "0d1a3c6523c8f06e4e0af9c515aa5b5448cfebd6838f2d52c3d8b6ef8ddc3c2e";

/**
 * What scrypt (N = 2^17, r = 8, p = 1) gives for the same password and salt,
 * as computed by OpenSSL through Node's crypto.scryptSync. The tests
 * recompute it the same way every run.
 */
export const SCRYPT_EXPECTED_HEX =
  "1b2946da71f41179e83b99dc33842d15741b87c4121c8c7f3781c1df864fb58b";

/**
 * The Argon2id test vector from RFC 9106, section 5.3. It uses 4 lanes, a
 * secret and associated data, so libsodium's Argon2id (always 1 lane, no
 * secret) cannot take it; the JavaScript implementation can.
 */
export const RFC9106 = {
  password: 0x01, // 32 bytes of 0x01
  passwordBytes: 32,
  salt: 0x02, // 16 bytes of 0x02
  saltBytes: 16,
  secret: 0x03, // 8 bytes of 0x03
  secretBytes: 8,
  associatedData: 0x04, // 12 bytes of 0x04
  associatedDataBytes: 12,
  memoryKib: 32,
  passes: 3,
  lanes: 4,
  outputBytes: 32,
  expectedHex: "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
} as const;

/**
 * The XChaCha20-Poly1305 test vector from draft-irtf-cfrg-xchacha, appendix
 * A.3.1: key bytes 0x80..0x9f, nonce bytes 0x40..0x57. The ciphertext is
 * followed by the 16-byte tag. libsodium and @noble/ciphers both give it.
 */
export const XCHACHA_KAT = {
  plaintext:
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
  associatedDataHex: "50515253c0c1c2c3c4c5c6c7",
  keyFirstByte: 0x80,
  nonceFirstByte: 0x40,
  expectedHex:
    "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49",
} as const;

/** SHA-256 of the three bytes "abc", used to see crypto.subtle really works. */
export const SHA256_ABC_HEX =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/** The smallest valid WebAssembly module: the magic number and version 1. */
export const EMPTY_WASM_MODULE: readonly number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

// ---- Names of the checks, in the order they run --------------------------

export const CHECK = {
  webassembly: { id: "webassembly", title: "WebAssembly is available and runs" },
  cryptoSubtle: { id: "crypto-subtle", title: "crypto.subtle is available and works" },
  randomValues: { id: "random-values", title: "crypto.getRandomValues is available" },
  sodiumLoad: { id: "libsodium-load", title: "libsodium.js loads" },
  xchacha: { id: "xchacha20poly1305", title: "XChaCha20-Poly1305 encrypts and decrypts a 100 KiB note" },
  xchachaKat: { id: "xchacha20poly1305-vector", title: "XChaCha20-Poly1305 matches the published test vector" },
  xchachaTamper: { id: "xchacha20poly1305-tamper", title: "XChaCha20-Poly1305 refuses a changed ciphertext" },
  sealedBox: { id: "sealed-box", title: "Sealed box to a fresh X25519 key opens again" },
  argon2Rfc: { id: "argon2id-rfc9106", title: "Argon2id matches the RFC 9106 vector (JavaScript implementation)" },
  argon2Sodium: { id: "argon2id-libsodium", title: "Argon2id 64 MiB, 3 passes, 1 lane (libsodium) gives the expected key" },
  scrypt: { id: "scrypt-fallback", title: "scrypt N=2^17, r=8, p=1 fallback gives the expected key" },
  argon2Js: { id: "argon2id-javascript", title: "Argon2id 64 MiB, 3 passes, 1 lane (JavaScript, no WebAssembly) gives the expected key" },
} as const;

export type CheckId = (typeof CHECK)[keyof typeof CHECK]["id"];
