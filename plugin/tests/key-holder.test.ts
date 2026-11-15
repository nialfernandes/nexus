// The key holder (src/key-holder.ts) is the one place the vault key lives while the vault is unlocked: in memory, handed over for good,
// overwritten with zeros when the vault is locked. It starts locked.

import { describe, expect, it, vi } from "vitest";
import { KeyHolder } from "../src/key-holder";
import type { VaultKeys } from "../src/unlock";

const keysOf = (fill: number, vaultId = "a-vault"): VaultKeys => ({ vaultKey: new Uint8Array(32).fill(fill), vaultId, kid: 1 });

describe("the key holder", () => {
  it("starts locked: it is the engine's port and holds no key", () => {
    const holder = new KeyHolder();
    expect(holder.keys()).toBeNull();
    expect(holder.isUnlocked).toBe(false);
  });

  it("gives the keys back each time it is asked, while unlocked", () => {
    const holder = new KeyHolder();
    const keys = keysOf(7);
    holder.unlock(keys);
    expect(holder.isUnlocked).toBe(true);
    expect(holder.keys()).toMatchObject({ vaultId: "a-vault", kid: 1 });
    expect(Array.from(holder.keys()!.vaultKey)).toEqual(new Array(32).fill(7));
    expect(holder.keys()).toEqual(holder.keys());
  });

  it("drops the key on lock: the bytes it was handed are overwritten with zeros, and it holds nothing", () => {
    const holder = new KeyHolder();
    const keys = keysOf(9);
    holder.unlock(keys);
    holder.lock();
    expect(holder.keys()).toBeNull();
    expect(holder.isUnlocked).toBe(false);
    expect(keys.vaultKey.every((byte) => byte === 0), "zeroed, not just forgotten").toBe(true);
  });

  it("can be locked again, and when nothing is held, without a fault or a second telling", () => {
    const told = vi.fn();
    const holder = new KeyHolder(told);
    holder.lock();
    holder.unlock(keysOf(1));
    holder.lock();
    holder.lock();
    expect(told.mock.calls).toEqual([[true], [false]]);
  });

  it("overwrites a key it already held when another is put in its place, and refuses a key that is not 32 bytes, staying as it was", () => {
    const holder = new KeyHolder();
    const first = keysOf(3);
    holder.unlock(first);
    const second = keysOf(4, "another");
    holder.unlock(second);
    expect(first.vaultKey.every((byte) => byte === 0), "the first key is overwritten").toBe(true);
    expect(holder.keys()).toMatchObject({ vaultId: "another" });

    expect(() => holder.unlock({ vaultKey: new Uint8Array(16), vaultId: "x", kid: 1 })).toThrow(/32 bytes/);
    expect(() => holder.unlock({ vaultKey: "not bytes" as unknown as Uint8Array, vaultId: "x", kid: 1 })).toThrow(/32 bytes/);
    expect(holder.keys()).toMatchObject({ vaultId: "another" });
    expect(second.vaultKey.some((byte) => byte !== 0), "and the key that is held was not touched").toBe(true);
  });

  it("is not harmed by being handed the key it already holds", () => {
    const holder = new KeyHolder();
    const keys = keysOf(5);
    holder.unlock(keys);
    holder.unlock(keys);
    expect(holder.keys()!.vaultKey.every((byte) => byte === 5)).toBe(true);
  });

  it("tells whoever listens when the vault is unlocked and when it is locked, and only then", () => {
    const told: boolean[] = [];
    const holder = new KeyHolder((unlocked) => told.push(unlocked));
    holder.unlock(keysOf(1));
    holder.unlock(keysOf(2));
    expect(told, "a key put in place of a key is not a new unlock").toEqual([true]);
    holder.lock();
    expect(told).toEqual([true, false]);
  });

  it("has no way to write the key anywhere: its source touches no storage, file, network or log", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("../src/key-holder.ts", import.meta.url)), "utf8").replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/localStorage|saveLocalStorage|saveData|writeFile|requestUrl|fetch\(|console\.|JSON\.stringify|document\.|window\./);
  });
});
