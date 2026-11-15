// A note id made from a key the caller keeps (docs/FORMAT.md section 7.6): the same key gives the same id in a vault, and the id says
// nothing about the key to anyone who does not hold the vault key.

import { describe, expect, it } from "vitest";
import { generateVaultKey, noteIdFromKey, NexusCryptoError } from "../src/index.js";
import { NOTE_ID_FROM_KEY_TEXT, NOTE_ID_KEY_TEXT, VAULT_KEY } from "./fixtures.js";

describe("noteIdFromKey", () => {
  it("makes the pinned worked example of docs/FORMAT.md", async () => {
    expect(await noteIdFromKey(VAULT_KEY, NOTE_ID_KEY_TEXT)).toBe(NOTE_ID_FROM_KEY_TEXT);
  });

  it("gives the same id for the same key and vault key, every time, and leaves the vault key as it was", async () => {
    const before = VAULT_KEY.slice();
    const ids = await Promise.all([1, 2, 3].map(() => noteIdFromKey(VAULT_KEY, "transcript-9")));
    expect(new Set(ids).size).toBe(1);
    expect(VAULT_KEY).toEqual(before);
  });

  it("gives another id for another key, and for another vault key", async () => {
    const a = await noteIdFromKey(VAULT_KEY, "transcript-9");
    expect(await noteIdFromKey(VAULT_KEY, "transcript-10")).not.toBe(a);
    expect(await noteIdFromKey(VAULT_KEY, "Transcript-9"), "case counts").not.toBe(a);
    expect(await noteIdFromKey(await generateVaultKey(), "transcript-9")).not.toBe(a);
  });

  it("makes 22 characters of url-safe base64 that a note id may be, and none of them is the key or any piece of it", async () => {
    for (const key of ["episode-123", "a", "Agent/First.md", "x".repeat(1024), "épisode 🚀"]) {
      const id = await noteIdFromKey(VAULT_KEY, key);
      expect(id, key).toMatch(/^[A-Za-z0-9_-]{22}$/);
      for (const piece of key.match(/[A-Za-z0-9]{4,}/g) ?? []) expect(id.toLowerCase(), piece).not.toContain(piece.toLowerCase());
    }
  });

  it("refuses a key that is empty, longer than 1024 bytes, not text or not well formed, and a vault key that is not 32 bytes", async () => {
    const refused = async (promise: Promise<unknown>) => expect(await promise.catch((error: unknown) => error)).toMatchObject({ name: "NexusCryptoError", code: "invalid-argument" });
    await refused(noteIdFromKey(VAULT_KEY, ""));
    await refused(noteIdFromKey(VAULT_KEY, "x".repeat(1025)));
    await refused(noteIdFromKey(VAULT_KEY, "é".repeat(513)));
    await refused(noteIdFromKey(VAULT_KEY, "\ud800"));
    await refused(noteIdFromKey(VAULT_KEY, 7 as unknown as string));
    await refused(noteIdFromKey(VAULT_KEY.slice(0, 31), "ok"));
    await refused(noteIdFromKey("not bytes" as unknown as Uint8Array, "ok"));
    expect(NexusCryptoError).toBeTypeOf("function");
  });
});
