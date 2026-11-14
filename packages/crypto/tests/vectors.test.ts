import { argon2id } from "@noble/hashes/argon2.js";
import { describe, expect, it } from "vitest";
import { aeadOpen, aeadSeal } from "../src/aead.js";
import { PASSWORD_KDF } from "../src/constants.js";
import { hkdfSha256 } from "../src/hkdf.js";
import { padmeLength, padRecord, unpadRecord } from "../src/padme.js";
import { loadSodium } from "../src/sodium.js";
import { derivePasswordKey } from "../src/wraps.js";
import { filled, fromHex, sequence, toHex } from "./helpers.js";

describe("XChaCha20-Poly1305 known answer (IRTF draft xchacha-03, appendix A.3.1) through libsodium", () => {
  const key = fromHex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
  const nonce = fromHex("404142434445464748494a4b4c4d4e4f5051525354555657");
  const aad = fromHex("50515253c0c1c2c3c4c5c6c7");
  const plaintext = new TextEncoder().encode(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
  );
  const ciphertext = fromHex(`
    bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb
    731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452
    2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9
    21f9664c97637da9768812f615c68b13b52e`);
  const tag = fromHex("c0875924c1c7987947deafd8780acf49");

  it("encrypts to the published ciphertext and tag", async () => {
    const sodium = await loadSodium();
    const sealed = aeadSeal(sodium, key, nonce, aad, plaintext);
    expect(toHex(sealed)).toBe(toHex(new Uint8Array([...ciphertext, ...tag])));
  });

  it("decrypts the published ciphertext", async () => {
    const sodium = await loadSodium();
    const opened = aeadOpen(sodium, key, nonce, aad, new Uint8Array([...ciphertext, ...tag]), "decryption-failed");
    expect(new TextDecoder().decode(opened)).toBe(new TextDecoder().decode(plaintext));
  });
});

describe("HKDF-SHA-256 known answers (RFC 5869) through libsodium's HMAC", () => {
  it("test case 1: salt and info given, 42 bytes out", async () => {
    const sodium = await loadSodium();
    const okm = hkdfSha256(sodium, filled(22, 0x0b), sequence(13), fromHex("f0f1f2f3f4f5f6f7f8f9"), 42);
    expect(toHex(okm)).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  });

  it("test case 3: empty salt and info, 42 bytes out", async () => {
    const sodium = await loadSodium();
    const okm = hkdfSha256(sodium, filled(22, 0x0b), new Uint8Array(0), new Uint8Array(0), 42);
    expect(toHex(okm)).toBe("8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8");
  });
});

describe("Argon2id", () => {
  // libsodium's crypto_pwhash only runs one lane and takes no secret or
  // associated data, so it cannot run this vector. noble can: this anchors the
  // second library to the RFC, and the test below anchors libsodium to noble
  // at the settings Nexus uses.
  it("noble reproduces the RFC 9106 section 5.3 tag", () => {
    const tag = argon2id(filled(32, 1), filled(16, 2), {
      t: 3,
      m: 32,
      p: 4,
      dkLen: 32,
      key: filled(8, 3),
      personalization: filled(12, 4),
    });
    expect(toHex(tag)).toBe("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
  });

  it("libsodium and noble agree at 64 MiB, t=3, p=1 for two inputs", async () => {
    const sodium = await loadSodium();
    const inputs = [
      { password: new TextEncoder().encode("correct horse battery staple"), salt: sequence(16) },
      { password: new TextEncoder().encode("pässwörd ✓"), salt: sequence(16, 100) },
    ];
    for (const { password, salt } of inputs) {
      const ours = derivePasswordKey(sodium, password, salt, PASSWORD_KDF);
      const theirs = argon2id(password, salt, {
        t: PASSWORD_KDF.iterations,
        m: PASSWORD_KDF.memoryKiB,
        p: PASSWORD_KDF.parallelism,
        dkLen: 32,
      });
      expect(toHex(ours)).toBe(toHex(theirs));
    }
  });
});

describe("Padmé", () => {
  it("rounds lengths as the Padmé paper does", () => {
    // Computed by hand from the definition: E = floor(log2 L), S = floor(log2 E) + 1,
    // clear the lowest E - S bits (rounding up).
    const cases: Array<[number, number]> = [
      [0, 0], [1, 1], [2, 2], [7, 7], [8, 8], [9, 10], [15, 16], [16, 16], [17, 18],
      [31, 32], [33, 36], [100, 104], [1000, 1024], [1025, 1088], [4096, 4096], [5000, 5120],
    ];
    for (const [length, padded] of cases) expect(padmeLength(length), `padmeLength(${length})`).toBe(padded);
  });

  it("never adds more than 12% once past tiny sizes, and never shrinks", () => {
    for (let length = 16; length < 70_000; length += 7) {
      const padded = padmeLength(length);
      expect(padded).toBeGreaterThanOrEqual(length);
      expect(padded / length).toBeLessThanOrEqual(1.12);
    }
  });

  it("pads a short record to 256 bytes and takes it off again", () => {
    const record = new TextEncoder().encode('{"path":"a.md","text":"hello"}');
    const padded = padRecord(record);
    expect(padded.length).toBe(256);
    expect(padded[record.length]).toBe(0x80);
    expect(Array.from(unpadRecord(padded))).toEqual(Array.from(record));
  });

  it("pads a record at or past the floor to the Padmé length of record plus its end mark", () => {
    for (const length of [254, 255, 256, 257, 1000, 5000]) {
      const record = new Uint8Array(length).fill(0x41);
      const padded = padRecord(record);
      expect(padded.length, `record of ${length}`).toBe(padmeLength(Math.max(length + 1, 256)));
      expect(padded.length).toBeGreaterThanOrEqual(length + 1);
      expect(Array.from(unpadRecord(padded))).toEqual(Array.from(record));
    }
    expect(padRecord(new Uint8Array(254)).length).toBe(256);
    expect(padRecord(new Uint8Array(255)).length).toBe(256);
    expect(padRecord(new Uint8Array(256)).length).toBe(padmeLength(257));
  });

  it("refuses padding that has no end mark", () => {
    expect(() => unpadRecord(new Uint8Array(40))).toThrowError(/end mark/);
    expect(() => unpadRecord(Uint8Array.of(1, 2, 3, 0, 0))).toThrowError(/end mark/);
  });
});
