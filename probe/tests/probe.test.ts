import { scryptSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { argon2id } from "@noble/hashes/argon2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
  ARGON2_EXPECTED_HEX,
  CHECK,
  KDF_PASSWORD,
  KDF_SALT,
  SCRYPT_EXPECTED_HEX,
  XCHACHA_KAT,
} from "../src/constants";
import type { CheckResult, ProbeReport, ProgressEvent } from "../src/probe";
import { formatReport } from "../src/report";
import { TEST_HOST, buildToScratch, loadBundle } from "./load-bundle";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const byId = (report: ProbeReport, id: string): CheckResult => {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check named ${id}`);
  return found;
};

let built: string;
beforeAll(async () => {
  built = await buildToScratch();
}, 60_000);

describe("the expected answers are right (computed here, not taken on trust)", () => {
  // Typed out here from RFC 9106 section 5.3, not imported from src/constants.
  const RFC_TAG = "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659";

  it("noble's Argon2id gives the RFC 9106 tag, and that is the tag the probe checks", () => {
    const out = argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
      t: 3,
      m: 32,
      p: 4,
      key: new Uint8Array(8).fill(3),
      personalization: new Uint8Array(12).fill(4),
      dkLen: 32,
    });
    expect(hex(out)).toBe(RFC_TAG);
  });

  it("noble's Argon2id gives the digest the probe expects from libsodium", () => {
    const out = argon2id(new TextEncoder().encode(KDF_PASSWORD), Uint8Array.from(KDF_SALT), {
      t: 3,
      m: 64 * 1024,
      p: 1,
      dkLen: 32,
    });
    expect(hex(out)).toBe(ARGON2_EXPECTED_HEX);
  });

  it("OpenSSL's scrypt gives the digest the probe expects from the fallback", () => {
    const out = scryptSync(KDF_PASSWORD, Buffer.from(KDF_SALT), 32, {
      N: 2 ** 17,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
    expect(out.toString("hex")).toBe(SCRYPT_EXPECTED_HEX);
  });

  it("noble's XChaCha20-Poly1305 gives the vector the probe expects from libsodium", () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => XCHACHA_KAT.keyFirstByte + i);
    const nonce = Uint8Array.from({ length: 24 }, (_, i) => XCHACHA_KAT.nonceFirstByte + i);
    const out = xchacha20poly1305(key, nonce, Buffer.from(XCHACHA_KAT.associatedDataHex, "hex")).encrypt(
      new TextEncoder().encode(XCHACHA_KAT.plaintext),
    );
    expect(hex(out)).toBe(XCHACHA_KAT.expectedHex);
  });
});

describe("the probe, run from the built main.js", () => {
  let report: ProbeReport;
  const events: ProgressEvent[] = [];

  beforeAll(async () => {
    const { runProbe, requested } = loadBundle(built);
    expect(requested).toEqual(["obsidian"]);
    report = await runProbe({ host: TEST_HOST, onProgress: (e) => void events.push(e) });
  }, 120_000);

  it("lists every check, in order, each with a status and a time in milliseconds", () => {
    expect(report.checks.map((c) => c.id)).toEqual(Object.values(CHECK).map((c) => c.id));
    for (const check of report.checks) {
      expect(["pass", "fail", "skipped"], check.id).toContain(check.status);
      expect(typeof check.ms, check.id).toBe("number");
      expect(Number.isFinite(check.ms), check.id).toBe(true);
      expect(check.detail.length, check.id).toBeGreaterThan(0);
      if (check.status !== "skipped") expect(check.ms, check.id).toBeGreaterThan(0);
    }
  });

  it("passes every check that runs here, and skips only the two fallbacks", () => {
    const failed = report.checks.filter((c) => c.status === "fail");
    expect(failed, JSON.stringify(failed)).toEqual([]);
    const skipped = report.checks.filter((c) => c.status === "skipped").map((c) => c.id);
    expect(skipped).toEqual([CHECK.scrypt.id, CHECK.argon2Js.id]);
  });

  it("Argon2id equals the RFC 9106 vector and libsodium's equals the expected key", () => {
    expect(byId(report, CHECK.argon2Rfc.id)).toMatchObject({ status: "pass" });
    expect(byId(report, CHECK.argon2Rfc.id).detail).toContain("RFC 9106");
    const sodium = byId(report, CHECK.argon2Sodium.id);
    expect(sodium.status).toBe("pass");
    expect(sodium.detail).toContain("64 MiB, 3 passes, 1 lane");
  });

  it("says how long libsodium took to be ready, since it starts loading before the probe runs", () => {
    const load = byId(report, CHECK.sodiumLoad.id);
    expect(load.status).toBe("pass");
    expect(load.detail).toMatch(/was ready \d+(\.\d)? ms after the plugin file was loaded/);
  });

  it("says where it ran", () => {
    expect(report.environment.obsidianVersion).toBe("test");
    expect(report.environment.userAgent).toBe("node-test");
    expect(report.environment.platform).toEqual({ isDesktop: true });
  });

  it("reports progress before and after every check, and ends with nothing running", () => {
    const running = events.map((e) => e.current?.id ?? null);
    expect(running.slice(0, Object.values(CHECK).length - 2)).toContain(CHECK.argon2Sodium.id);
    expect(running[running.length - 1]).toBeNull();
    // The check is announced before it has a result.
    const atSodium = events.find((e) => e.current?.id === CHECK.argon2Sodium.id);
    expect(atSodium?.report.checks.map((c) => c.id)).not.toContain(CHECK.argon2Sodium.id);
  });

  it("prints as plain text that names every check with its time", () => {
    const text = formatReport(report, { label: "unit test" });
    expect(text).toContain("Note: unit test");
    for (const { title } of Object.values(CHECK)) expect(text).toContain(title);
    expect(text).toMatch(/PASS\s+\d+\.\d ms\s+Argon2id 64 MiB/);
    expect(text).toContain("Result: ");
  });
});

describe("the probe with WebAssembly taken away (Lockdown Mode)", () => {
  let report: ProbeReport;

  beforeAll(async () => {
    const { runProbe } = loadBundle(built, { withoutWebAssembly: true });
    report = await runProbe({ host: TEST_HOST });
  }, 240_000);

  it("reports WebAssembly and libsodium as failed, not as a crash", () => {
    expect(byId(report, CHECK.webassembly.id).status).toBe("fail");
    expect(byId(report, CHECK.sodiumLoad.id).status).toBe("fail");
    expect(byId(report, CHECK.xchacha.id).status).toBe("fail");
    expect(byId(report, CHECK.sealedBox.id).status).toBe("fail");
    expect(byId(report, CHECK.argon2Sodium.id).status).toBe("fail");
  });

  it("runs the scrypt fallback and the JavaScript Argon2id, and both give the right key", () => {
    expect(byId(report, CHECK.scrypt.id).status).toBe("pass");
    expect(byId(report, CHECK.argon2Js.id).status).toBe("pass");
    expect(byId(report, CHECK.argon2Rfc.id).status).toBe("pass");
  });

  it("still lists every check", () => {
    expect(report.checks.map((c) => c.id)).toEqual(Object.values(CHECK).map((c) => c.id));
  });
});
