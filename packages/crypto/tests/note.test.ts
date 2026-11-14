import { describe, expect, it } from "vitest";
import { decryptNote, encryptNote, generateVaultKey, NexusCryptoError, padmeLength } from "../src/index.js";
import { MIN_NOTE_BLOB_BYTES, sealNote } from "../src/note.js";
import { loadSodium } from "../src/sodium.js";
import { NONCE, NOTE_BLOB_HEX, NOTE_CONTEXT, RECORD, VAULT_KEY } from "./fixtures.js";
import { flipBit, fromHex, toHex } from "./helpers.js";

/** Runs the promise and returns the error it was refused with; fails if it was not refused. */
async function refusal(promise: Promise<unknown>): Promise<NexusCryptoError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NexusCryptoError);
    return error as NexusCryptoError;
  }
  throw new Error("expected the call to be refused");
}

describe("encryptNote and decryptNote", () => {
  it("round-trips the worked example", async () => {
    const blob = await encryptNote(VAULT_KEY, NOTE_CONTEXT, RECORD);
    expect(await decryptNote(VAULT_KEY, NOTE_CONTEXT, blob)).toEqual(RECORD);
  });

  it("round-trips empty, non-Latin, emoji and lone-surrogate text, and a large note", async () => {
    const records = [
      { path: "a.md", text: "" },
      { path: "日本語/メモ.md", text: "こんにちは\r\n\ttabs and \u0000 nul" },
      { path: "emoji 🌱.md", text: "👨‍👩‍👧 family" },
      { path: "odd.md", text: "lone \ud800 surrogate" },
      { path: "big.md", text: "line of text\n".repeat(100_000) },
    ];
    for (const record of records) {
      const blob = await encryptNote(VAULT_KEY, NOTE_CONTEXT, record);
      expect(await decryptNote(VAULT_KEY, NOTE_CONTEXT, blob)).toEqual(record);
    }
  });

  it("writes version 1, then the kid, then the nonce, then a ciphertext padded to at least 256 bytes", async () => {
    const context = { ...NOTE_CONTEXT, kid: 0x01020304 };
    const blob = await encryptNote(VAULT_KEY, context, RECORD);
    expect(blob[0]).toBe(1);
    expect(toHex(blob.slice(1, 5))).toBe("01020304");
    expect(blob.length).toBe(1 + 4 + 24 + 256 + 16);
  });

  it("pads past 256 bytes to the Padmé length of the record plus its end mark", async () => {
    const record = { path: "long.md", text: "x".repeat(3000) };
    const recordLength = new TextEncoder().encode(JSON.stringify(record)).length;
    const blob = await encryptNote(VAULT_KEY, NOTE_CONTEXT, record);
    expect(blob.length).toBe(1 + 4 + 24 + padmeLength(recordLength + 1) + 16);
    expect(padmeLength(recordLength + 1)).toBeGreaterThan(256);
  });

  it("gives every note up to 255 bytes the same blob size, so a one-line note shows no length", async () => {
    const sizes = new Set<number>();
    for (const n of [0, 1, 5, 40, 100, 200, 255 - 40]) {
      const record = { path: "p.md", text: "x".repeat(n) };
      expect(new TextEncoder().encode(JSON.stringify(record)).length).toBeLessThan(256);
      sizes.add((await encryptNote(VAULT_KEY, NOTE_CONTEXT, record)).length);
    }
    expect([...sizes]).toEqual([1 + 4 + 24 + 256 + 16]);
  });

  it("gives notes of nearby larger sizes the same blob size, which is the point of padding", async () => {
    const sizes = new Set<number>();
    for (let n = 1000; n < 1020; n++) {
      sizes.add((await encryptNote(VAULT_KEY, NOTE_CONTEXT, { path: "p.md", text: "x".repeat(n) })).length);
    }
    expect(sizes.size).toBeLessThanOrEqual(2);
  });

  it("uses a fresh random nonce each time", async () => {
    const a = await encryptNote(VAULT_KEY, NOTE_CONTEXT, RECORD);
    const b = await encryptNote(VAULT_KEY, NOTE_CONTEXT, RECORD);
    expect(toHex(a.slice(5, 29))).not.toBe(toHex(b.slice(5, 29)));
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it("makes vault keys that are 32 random bytes", async () => {
    const a = await generateVaultKey();
    const b = await generateVaultKey();
    expect(a.length).toBe(32);
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it("reads the pinned blob from docs/FORMAT.md", async () => {
    expect(await decryptNote(VAULT_KEY, NOTE_CONTEXT, fromHex(NOTE_BLOB_HEX))).toEqual(RECORD);
    const sodium = await loadSodium();
    expect(toHex(sealNote(sodium, VAULT_KEY, NOTE_CONTEXT, RECORD, NONCE))).toBe(NOTE_BLOB_HEX);
  });
});

describe("decryptNote refuses with a named error and gives back no plaintext", () => {
  const blobPromise = encryptNote(VAULT_KEY, NOTE_CONTEXT, { path: "Secret/plan.md", text: "the plaintext marker" });

  it("when the note id differs by one character", async () => {
    const error = await refusal(decryptNote(VAULT_KEY, { ...NOTE_CONTEXT, noteId: "note-2" }, await blobPromise));
    expect(error.code).toBe("decryption-failed");
    expect(error.message).not.toContain("plaintext marker");
  });

  it("when the vault id differs", async () => {
    const error = await refusal(decryptNote(VAULT_KEY, { ...NOTE_CONTEXT, vaultId: "vault-2" }, await blobPromise));
    expect(error.code).toBe("decryption-failed");
  });

  it("when the blob names a different kid than the context, before any decryption is tried", async () => {
    const error = await refusal(decryptNote(VAULT_KEY, { ...NOTE_CONTEXT, kid: 2 }, await blobPromise));
    expect(error.code).toBe("wrong-kid");
    expect(error.message).toMatch(/kid 1/);
  });

  it("when the header kid is rewritten to match the context: the kid is also in the associated data", async () => {
    const blob = (await blobPromise).slice();
    blob.set([0, 0, 0, 2], 1);
    const error = await refusal(decryptNote(VAULT_KEY, { ...NOTE_CONTEXT, kid: 2 }, blob));
    expect(error.code).toBe("decryption-failed");
  });

  it("when the ids are joined differently but would read the same without lengths", async () => {
    const blob = await encryptNote(VAULT_KEY, { vaultId: "ab", noteId: "c", kid: 1 }, RECORD);
    const error = await refusal(decryptNote(VAULT_KEY, { vaultId: "a", noteId: "bc", kid: 1 }, blob));
    expect(error.code).toBe("decryption-failed");
  });

  it("when the key is wrong", async () => {
    const error = await refusal(decryptNote(await generateVaultKey(), NOTE_CONTEXT, await blobPromise));
    expect(error.code).toBe("decryption-failed");
  });

  it("when any single bit anywhere after the version byte is flipped", async () => {
    const blob = await blobPromise;
    for (let index = 1; index < blob.length; index++) {
      const error = await refusal(decryptNote(VAULT_KEY, NOTE_CONTEXT, flipBit(blob, index, index % 8)));
      // bytes 1 to 4 are the kid, which is compared first
      expect(error.code, `byte ${index}`).toBe(index <= 4 ? "wrong-kid" : "decryption-failed");
    }
  });

  it("when the version byte is changed", async () => {
    const blob = await blobPromise;
    expect((await refusal(decryptNote(VAULT_KEY, NOTE_CONTEXT, flipBit(blob, 0, 0)))).code).toBe("unsupported-version");
    expect((await refusal(decryptNote(VAULT_KEY, NOTE_CONTEXT, flipBit(blob, 0, 1)))).code).toBe("unsupported-version");
  });

  it("when the blob is cut short", async () => {
    const blob = await blobPromise;
    for (const length of [0, 1, 4, 5, 28, 29, MIN_NOTE_BLOB_BYTES - 1]) {
      expect((await refusal(decryptNote(VAULT_KEY, NOTE_CONTEXT, blob.slice(0, length)))).code, `length ${length}`).toBe("truncated");
    }
    for (const length of [MIN_NOTE_BLOB_BYTES, 60, blob.length - 16, blob.length - 1]) {
      expect((await refusal(decryptNote(VAULT_KEY, NOTE_CONTEXT, blob.slice(0, length)))).code, `length ${length}`).toBe("decryption-failed");
    }
  });

  it("when bytes are added to the end", async () => {
    const blob = await blobPromise;
    const longer = new Uint8Array(blob.length + 1);
    longer.set(blob);
    expect((await refusal(decryptNote(VAULT_KEY, NOTE_CONTEXT, longer))).code).toBe("decryption-failed");
  });

  it("when it is given something that is not a blob", async () => {
    const wrongType = [null, "text", [1, 2, 3]] as unknown as Uint8Array[];
    for (const value of wrongType) {
      expect((await refusal(decryptNote(VAULT_KEY, NOTE_CONTEXT, value))).code).toBe("invalid-argument");
    }
  });
});

describe("arguments are checked before any work is done", () => {
  it("rejects keys of the wrong size or type", async () => {
    for (const key of [new Uint8Array(31), new Uint8Array(33), "key", null] as unknown as Uint8Array[]) {
      expect((await refusal(encryptNote(key, NOTE_CONTEXT, RECORD))).code).toBe("invalid-argument");
      expect((await refusal(decryptNote(key, NOTE_CONTEXT, new Uint8Array(100)))).code).toBe("invalid-argument");
    }
  });

  it("rejects empty, over-long or malformed ids and bad kids", async () => {
    const bad = [
      { ...NOTE_CONTEXT, vaultId: "" },
      { ...NOTE_CONTEXT, noteId: "" },
      { ...NOTE_CONTEXT, noteId: "x".repeat(1025) },
      { ...NOTE_CONTEXT, noteId: "half \ud800 pair" },
      { ...NOTE_CONTEXT, kid: -1 },
      { ...NOTE_CONTEXT, kid: 1.5 },
      { ...NOTE_CONTEXT, kid: 2 ** 32 },
      { ...NOTE_CONTEXT, kid: Number.NaN },
    ];
    for (const context of bad) {
      expect((await refusal(encryptNote(VAULT_KEY, context, RECORD))).code, JSON.stringify(context)).toBe("invalid-argument");
    }
  });

  it("accepts the largest kid", async () => {
    const context = { ...NOTE_CONTEXT, kid: 2 ** 32 - 1 };
    const blob = await encryptNote(VAULT_KEY, context, RECORD);
    expect(await decryptNote(VAULT_KEY, context, blob)).toEqual(RECORD);
  });

  it("rejects a record without a string path and text", async () => {
    for (const record of [null, {}, { path: "a" }, { path: 1, text: "" }, { path: "a", text: null }] as never[]) {
      expect((await refusal(encryptNote(VAULT_KEY, NOTE_CONTEXT, record))).code).toBe("invalid-argument");
    }
  });
});
