import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBundle } from "../scripts/build.mjs";
import { NOTE_BLOB_HEX, NOTE_CONTEXT, RECORD, VAULT_KEY } from "./fixtures.js";
import { fromHex } from "./helpers.js";

let directory = "";
let bundlePath = "";
let bundle = "";

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "nexus-crypto-build-"));
  bundlePath = join(directory, "index.js");
  await buildBundle(bundlePath);
  bundle = readFileSync(bundlePath, "utf8");
}, 120_000);

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true });
});

describe("the build", () => {
  it("is a single ES module file", () => {
    expect(readdirSync(directory)).toEqual(["index.js"]);
    expect(statSync(bundlePath).size).toBeGreaterThan(100_000); // libsodium's WebAssembly is inside
    expect(bundle).toMatch(/^export \{/m);
  });

  it("imports nothing: no import statements, no dynamic import, no require", () => {
    expect(bundle).not.toMatch(/^\s*import\b[^\n]*["'][^"']+["']/m);
    expect(bundle).not.toMatch(/^\s*export\b[^\n]*\bfrom\s*["']/m);
    expect(bundle).not.toMatch(/\bimport\s*\(/);
    expect(bundle).not.toMatch(/\brequire\s*\(/);
  });

  it("names no Node module", () => {
    expect(bundle).not.toMatch(/node:/);
    const builtins =
      "fs|path|os|crypto|util|buffer|stream|events|url|module|http|https|net|tls|dns|zlib|assert|vm|readline|worker_threads|child_process|process";
    expect(bundle).not.toMatch(new RegExp(`["'](${builtins})["']`));
  });

  it("does not use WebCrypto's SubtleCrypto", () => {
    expect(bundle).not.toMatch(/\bsubtle\b/i);
  });

  it("exports the public functions and works when loaded from the built file", async () => {
    const built = await import(/* @vite-ignore */ pathToFileURL(bundlePath).href);
    expect(Object.keys(built).sort()).toEqual(
      [
        "ERROR_CODES", "FORMAT_VERSION", "NexusCryptoError", "PASSWORD_KDF", "PASSWORD_KDF_LIMITS", "RECOVERY_ALPHABET",
        "createPasswordWrap", "decryptNote", "encryptNote", "formatRecoveryKey", "generateDeviceKeyPair",
        "generateRecoveryKey", "generateVaultKey", "openApproval", "openPasswordWrap", "padmeLength",
        "parseRecoveryKey", "sealApproval", "unwrapVaultKeyWithRecoveryKey", "wrapVaultKeyWithRecoveryKey",
      ].sort(),
    );
    // The pinned blob (made from the source) opens with the built file.
    expect(await built.decryptNote(VAULT_KEY, NOTE_CONTEXT, fromHex(NOTE_BLOB_HEX))).toEqual(RECORD);
    const blob = await built.encryptNote(VAULT_KEY, NOTE_CONTEXT, RECORD);
    expect(await built.decryptNote(VAULT_KEY, NOTE_CONTEXT, blob)).toEqual(RECORD);
    await expect(built.decryptNote(VAULT_KEY, { ...NOTE_CONTEXT, noteId: "note-2" }, blob)).rejects.toMatchObject({
      name: "NexusCryptoError",
      code: "decryption-failed",
    });
  });
});
