// The probe itself: every check the plugin runs on a device, with no Obsidian
// code in it, so the same function runs in Obsidian and under Node in the tests.
//
// Nothing here may import from Node or Electron: the same main.js runs on phones.
import sodium from "libsodium-wrappers-sumo";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import {
  ARGON2_EXPECTED_HEX,
  ARGON2_LANES,
  ARGON2_MEMORY_KIB,
  ARGON2_OUTPUT_BYTES,
  ARGON2_PASSES,
  ARGON2_TOO_SLOW_MS,
  CHECK,
  EMPTY_WASM_MODULE,
  KDF_PASSWORD,
  KDF_SALT,
  NOTE_BYTES,
  PROBE_VERSION,
  RFC9106,
  SCRYPT_BLOCK_R,
  SCRYPT_COST_N,
  SCRYPT_EXPECTED_HEX,
  SCRYPT_OUTPUT_BYTES,
  SCRYPT_PARALLEL_P,
  SHA256_ABC_HEX,
  SODIUM_LOAD_LIMIT_MS,
  XCHACHA_KAT,
} from "./constants";

// libsodium starts loading the moment it is imported, before the probe runs, so
// note how long it took to be ready, counted from here. If it cannot load (no
// WebAssembly), the rejection may come before the load check is running and
// would be reported as an unhandled rejection: this also marks it handled. The
// load check still awaits the same promise and sees the failure.
const moduleStartMs = now();
let sodiumReadyAfterMs: number | null = null;
sodium.ready.then(
  () => {
    sodiumReadyAfterMs = now() - moduleStartMs;
  },
  () => undefined,
);

export type CheckStatus = "pass" | "fail" | "skipped";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** How long the check took, in milliseconds (0 for a skipped check). */
  ms: number;
  /** What was measured, or why it failed or was skipped. */
  detail: string;
}

/** What the host application (Obsidian) says about itself. */
export interface HostInfo {
  obsidianVersion: string | null;
  /** The Obsidian Platform flags, by name. */
  platform: Record<string, boolean>;
}

export interface EnvironmentInfo extends HostInfo {
  userAgent: string;
  isSecureContext: boolean | null;
  hardwareConcurrency: number | null;
  /** Rough device memory in GiB where the browser says (not on iOS). */
  deviceMemoryGiB: number | null;
}

export interface ProbeReport {
  probeVersion: string;
  startedAt: string;
  environment: EnvironmentInfo;
  /** The checks finished so far, in the order they ran. */
  checks: CheckResult[];
  /** Milliseconds from the start of the first check to the end of the last. */
  totalMs: number;
}

export interface StepRef {
  id: string;
  title: string;
}

/** Sent before each check starts and after each one ends. */
export interface ProgressEvent {
  report: ProbeReport;
  /** The check now running, or null once the whole probe has finished. */
  current: StepRef | null;
}

export interface RunProbeOptions {
  host?: HostInfo;
  /** Awaited, so a caller can save progress before a heavy check starts. */
  onProgress?: (event: ProgressEvent) => void | Promise<void>;
}

/** Time in milliseconds, from a monotonic clock where there is one. */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/** libsodium and WebAssembly sometimes throw plain strings, not Error objects. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Lets the screen repaint (so "running..." shows) before a long check blocks it. */
function yieldToScreen(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function withTimeLimit<T>(work: Promise<T>, limitMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not finish in ${limitMs / 1000} s`)),
      limitMs,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

export function collectEnvironment(host: HostInfo): EnvironmentInfo {
  const nav: Partial<Navigator> & { deviceMemory?: number } =
    typeof navigator !== "undefined" ? navigator : {};
  return {
    ...host,
    userAgent: nav.userAgent ?? "unknown",
    isSecureContext: typeof isSecureContext === "boolean" ? isSecureContext : null,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemoryGiB: nav.deviceMemory ?? null,
  };
}

/** Throws unless the bytes are the expected value, so a wrong answer is a failure. */
function expectDigest(got: Uint8Array, expectedHex: string, name: string): void {
  const gotHex = toHex(got);
  if (gotHex !== expectedHex) {
    throw new Error(`${name} gave ${gotHex} but ${expectedHex} was expected`);
  }
}

/**
 * Runs every check on this device, one after another, and returns what each
 * one found. A check that throws is reported as a failure and the probe goes
 * on, so one broken piece never hides the rest.
 */
export async function runProbe(options: RunProbeOptions = {}): Promise<ProbeReport> {
  const host: HostInfo = options.host ?? { obsidianVersion: null, platform: {} };
  const startedClock = now();
  const report: ProbeReport = {
    probeVersion: PROBE_VERSION,
    startedAt: new Date().toISOString(),
    environment: collectEnvironment(host),
    checks: [],
    totalMs: 0,
  };

  const announce = async (current: StepRef | null): Promise<void> => {
    report.totalMs = roundMs(now() - startedClock);
    await options.onProgress?.({ report: structuredCloneJson(report), current });
  };

  /** Runs one check: times it, turns a throw into a failure, records the result. */
  const check = async (
    step: StepRef,
    work: () => Promise<string> | string,
  ): Promise<CheckResult> => {
    await announce(step);
    await yieldToScreen();
    const began = now();
    let result: CheckResult;
    try {
      const detail = await work();
      result = { ...step, status: "pass", ms: roundMs(now() - began), detail };
    } catch (error) {
      result = { ...step, status: "fail", ms: roundMs(now() - began), detail: describeError(error) };
    }
    report.checks.push(result);
    return result;
  };

  const skip = (step: StepRef, detail: string): CheckResult => {
    const result: CheckResult = { ...step, status: "skipped", ms: 0, detail };
    report.checks.push(result);
    return result;
  };

  // ---- The device itself --------------------------------------------------

  await check(CHECK.webassembly, async () => {
    if (typeof WebAssembly !== "object") throw new Error("the WebAssembly object does not exist");
    const bytes = Uint8Array.from(EMPTY_WASM_MODULE);
    if (!WebAssembly.validate(bytes)) throw new Error("WebAssembly.validate refused an empty module");
    await WebAssembly.instantiate(bytes);
    return "the WebAssembly object exists and an empty module compiled and ran";
  });

  await check(CHECK.cryptoSubtle, async () => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error("crypto.subtle does not exist");
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode("abc"));
    const hex = toHex(new Uint8Array(digest));
    if (hex !== SHA256_ABC_HEX) throw new Error(`SHA-256 of "abc" gave ${hex}`);
    return "crypto.subtle exists and SHA-256 of \"abc\" is right";
  });

  await check(CHECK.randomValues, () => {
    if (typeof globalThis.crypto?.getRandomValues !== "function") {
      throw new Error("crypto.getRandomValues does not exist");
    }
    const sample = globalThis.crypto.getRandomValues(new Uint8Array(32));
    if (sample.every((byte) => byte === 0)) throw new Error("32 random bytes were all zero");
    return "crypto.getRandomValues gives bytes";
  });

  // ---- libsodium ----------------------------------------------------------

  let sodiumLoaded = false;
  const needSodium = (): void => {
    if (!sodiumLoaded) throw new Error("libsodium did not load (see the libsodium.js check)");
  };

  await check(CHECK.sodiumLoad, async () => {
    await withTimeLimit(sodium.ready, SODIUM_LOAD_LIMIT_MS, "libsodium");
    sodiumLoaded = true;
    const version = `libsodium ${sodium.SODIUM_VERSION_STRING ?? "(version not reported)"}`;
    if (sodiumReadyAfterMs === null) return `${version} is ready`;
    return `${version} was ready ${roundMs(sodiumReadyAfterMs)} ms after the plugin file was loaded`;
  });

  await check(CHECK.xchacha, () => {
    needSodium();
    // A fixed pattern, not random bytes: filling 100 KiB from libsodium's random
    // source costs far more than the cipher, and the cipher's speed does not
    // depend on what the bytes are.
    const note = Uint8Array.from({ length: NOTE_BYTES }, (_, i) => (i * 31 + 7) & 0xff);
    const key = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const associated = new TextEncoder().encode("probe:note");
    const encryptStart = now();
    const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(note, associated, null, nonce, key);
    const encryptMs = now() - encryptStart;
    const decryptStart = now();
    const opened = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, sealed, associated, nonce, key);
    const decryptMs = now() - decryptStart;
    if (!bytesEqual(opened, note)) throw new Error("the decrypted note differs from the original");
    return `${note.length} bytes in, ${sealed.length} bytes out; encrypt ${roundMs(encryptMs)} ms, decrypt ${roundMs(decryptMs)} ms`;
  });

  await check(CHECK.xchachaKat, () => {
    needSodium();
    const key = Uint8Array.from({ length: 32 }, (_, i) => XCHACHA_KAT.keyFirstByte + i);
    const nonce = Uint8Array.from({ length: 24 }, (_, i) => XCHACHA_KAT.nonceFirstByte + i);
    const associated = sodium.from_hex(XCHACHA_KAT.associatedDataHex);
    const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      new TextEncoder().encode(XCHACHA_KAT.plaintext),
      associated,
      null,
      nonce,
      key,
    );
    expectDigest(sealed, XCHACHA_KAT.expectedHex, "XChaCha20-Poly1305");
    return "ciphertext and tag equal the draft-irtf-cfrg-xchacha appendix A.3.1 vector";
  });

  await check(CHECK.xchachaTamper, () => {
    needSodium();
    const key = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(filled(64, 7), null, null, nonce, key);
    const changed = sealed.slice();
    changed[0] = (changed[0] ?? 0) ^ 1;
    try {
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, changed, null, nonce, key);
    } catch {
      return "a ciphertext with one bit changed was refused";
    }
    throw new Error("a ciphertext with one bit changed was accepted");
  });

  await check(CHECK.sealedBox, () => {
    needSodium();
    const recipient = sodium.crypto_box_keypair();
    const message = new TextEncoder().encode("sealed to a fresh X25519 key");
    const sealed = sodium.crypto_box_seal(message, recipient.publicKey);
    const opened = sodium.crypto_box_seal_open(sealed, recipient.publicKey, recipient.privateKey);
    if (!bytesEqual(opened, message)) throw new Error("the opened message differs from the original");
    return `${message.length} bytes sealed to ${sealed.length} bytes and opened again`;
  });

  // ---- Argon2id and the scrypt fallback -----------------------------------

  const password = new TextEncoder().encode(KDF_PASSWORD);
  const salt = Uint8Array.from(KDF_SALT);

  await check(CHECK.argon2Rfc, async () => {
    const out = await argon2idAsync(
      filled(RFC9106.passwordBytes, RFC9106.password),
      filled(RFC9106.saltBytes, RFC9106.salt),
      {
        t: RFC9106.passes,
        m: RFC9106.memoryKib,
        p: RFC9106.lanes,
        key: filled(RFC9106.secretBytes, RFC9106.secret),
        personalization: filled(RFC9106.associatedDataBytes, RFC9106.associatedData),
        dkLen: RFC9106.outputBytes,
      },
    );
    expectDigest(out, RFC9106.expectedHex, "Argon2id");
    return "the result equals the RFC 9106 section 5.3 tag";
  });

  let sodiumDigestRight = false;
  const argon2Sodium = await check(CHECK.argon2Sodium, () => {
    needSodium();
    const memoryBytes = ARGON2_MEMORY_KIB * 1024;
    const began = now();
    const out = sodium.crypto_pwhash(
      ARGON2_OUTPUT_BYTES,
      password,
      salt,
      ARGON2_PASSES,
      memoryBytes,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    const elapsed = now() - began;
    expectDigest(out, ARGON2_EXPECTED_HEX, "libsodium Argon2id");
    sodiumDigestRight = true;
    const note = `${ARGON2_MEMORY_KIB / 1024} MiB, ${ARGON2_PASSES} passes, ${ARGON2_LANES} lane`;
    if (elapsed > ARGON2_TOO_SLOW_MS) {
      throw new Error(
        `right answer but too slow: ${roundMs(elapsed)} ms for ${note}; the limit is ${ARGON2_TOO_SLOW_MS} ms`,
      );
    }
    return `${note}: right answer in ${roundMs(elapsed)} ms`;
  });

  if (argon2Sodium.status === "pass") {
    skip(CHECK.scrypt, "not needed: libsodium's Argon2id passed within the time limit");
  } else {
    await check(CHECK.scrypt, async () => {
      const out = await scryptAsync(password, salt, {
        N: SCRYPT_COST_N,
        r: SCRYPT_BLOCK_R,
        p: SCRYPT_PARALLEL_P,
        dkLen: SCRYPT_OUTPUT_BYTES,
      });
      expectDigest(out, SCRYPT_EXPECTED_HEX, "scrypt");
      return `N=${SCRYPT_COST_N}, r=${SCRYPT_BLOCK_R}, p=${SCRYPT_PARALLEL_P}: right answer`;
    });
  }

  // The pure-JavaScript Argon2id answers a different question: if libsodium
  // could not give a right answer (for instance with WebAssembly switched off),
  // is Argon2id still possible without it, and how slow is it?
  if (sodiumDigestRight) {
    skip(CHECK.argon2Js, "not needed: libsodium's Argon2id gave the right answer");
  } else {
    await check(CHECK.argon2Js, async () => {
      const out = await argon2idAsync(password, salt, {
        t: ARGON2_PASSES,
        m: ARGON2_MEMORY_KIB,
        p: ARGON2_LANES,
        dkLen: ARGON2_OUTPUT_BYTES,
      });
      expectDigest(out, ARGON2_EXPECTED_HEX, "JavaScript Argon2id");
      return "right answer";
    });
  }

  await announce(null);
  return report;
}

/** A copy of the report that is plain data, safe to hand to a saver. */
function structuredCloneJson(report: ProbeReport): ProbeReport {
  return JSON.parse(JSON.stringify(report)) as ProbeReport;
}
