// What belongs to this device and what belongs to the vault. The plugin's data file sits inside the vault, so anything
// else that syncs the vault between devices (iCloud) syncs it too. Only the Nexus address and the user name, which are the
// same everywhere, may live there. Neither has a default. The token, the device's id and name, the cursor and what is known of
// every note (its id, version and fingerprint) belong to one device and are kept in Obsidian's per-device local storage. These are plain functions, so they are called directly.

import { describe, expect, it } from "vitest";
import { STATE_KEY, isSetUp, joinState, newDeviceId, newNoteId, sharedHasMore, signInLabel, splitState } from "../src/state";
import type { PluginData } from "../src/types";

const KEPT: PluginData = {
  address: "https://example.test/nexus/api",
  user: "demo",
  token: "nx_MARKER-TOKEN",
  cursor: "42",
  notes: { "Ideas/a.md": { id: "MARKER-NOTE-ID", version: 3, hash: "5-0123456789abcdef", savedPath: "Ideas/a.md" } },
  pendingDeletes: [{ id: "MARKER-GONE-ID", version: 2 }],
  pendingPulls: ["MARKER-LOCKED-ID"],
  deviceName: "Test Mac",
  deviceId: "MARKER-DEVICE-ID",
};

describe("what goes in the plugin's data file", () => {
  it("is the Nexus address and the user name and nothing else: no token, no device, no versions, no cursor", () => {
    const { shared } = splitState(KEPT);
    expect(shared).toEqual({ address: KEPT.address, user: KEPT.user });
    const written = JSON.stringify(shared);
    for (const marker of ["MARKER-TOKEN", "MARKER-DEVICE-ID", "MARKER-NOTE-ID", "Ideas/a.md", "Test Mac", "42", "MARKER-GONE-ID", "MARKER-LOCKED-ID"]) {
      expect(written, `the data file does not hold ${marker}`).not.toContain(marker);
    }
  });

  it("is rewritten with only the address and the user name when an older file holds anything more", () => {
    expect(sharedHasMore({ address: KEPT.address, user: KEPT.user })).toBe(false);
    expect(sharedHasMore({ address: KEPT.address })).toBe(false);
    expect(sharedHasMore(null)).toBe(false);
    expect(sharedHasMore({ address: KEPT.address, token: "nx_x" })).toBe(true);
    expect(sharedHasMore({ versions: {} })).toBe(true);
  });
});

describe("what goes in the device's local storage", () => {
  it("is the token, the device's id and name, the cursor, what is known of each note and what is waiting, under one key", () => {
    expect(STATE_KEY).toBe("nexus-state");
    const { device } = splitState(KEPT);
    expect(device).toEqual({
      token: KEPT.token,
      cursor: "42",
      notes: KEPT.notes,
      pendingDeletes: KEPT.pendingDeletes,
      pendingPulls: KEPT.pendingPulls,
      deviceName: "Test Mac",
      deviceId: "MARKER-DEVICE-ID",
    });
    expect(JSON.stringify(device), "the address and the user name are the vault's, not this device's").not.toContain("example.test");
    expect(JSON.stringify(device)).not.toContain("demo");
  });
});

describe("putting the two back together", () => {
  it("gives back what was split", () => {
    const { shared, device } = splitState(KEPT);
    expect(joinState(shared, device)).toEqual(KEPT);
  });

  it("starts a device with nothing stored with no address and no user name, signed out, never synced, with an id of its own", () => {
    const state = joinState(null, null, () => "new-id");
    expect(state).toMatchObject({ address: "", user: "", token: null, cursor: null, notes: {}, deviceId: "new-id" });
    expect(isSetUp(state), "there is no default address and no default user: it has to be set up").toBe(false);
  });

  it("is set up once it holds both an address and a user name, and not before", () => {
    expect(isSetUp({ address: "https://example.test/nexus/api", user: "demo" })).toBe(true);
    expect(isSetUp({ address: "https://example.test/nexus/api", user: "" })).toBe(false);
    expect(isSetUp({ address: "", user: "demo" })).toBe(false);
    expect(isSetUp({ address: "  ", user: " " })).toBe(false);
  });

  it("starts an older data file that holds an address and no user name as not set up", () => {
    const state = joinState({ address: "https://example.test/nexus/api" }, null, () => "id");
    expect(state.address).toBe("https://example.test/nexus/api");
    expect(state.user).toBe("");
    expect(isSetUp(state)).toBe(false);
  });

  it("keeps the id it had, and makes one only once", () => {
    const { shared, device } = splitState(KEPT);
    expect(joinState(shared, device, () => "another").deviceId).toBe("MARKER-DEVICE-ID");
  });

  it("takes nothing but the address and the user name from the data file, so a token left there by something else is not used", () => {
    const state = joinState({ address: "https://example.test/api", user: "demo", token: "nx_LEAKED", cursor: "9", notes: { "x.md": { id: "n", version: 1, hash: "h", savedPath: "x.md" } } }, null, () => "id");
    expect(state.address).toBe("https://example.test/api");
    expect(state.user).toBe("demo");
    expect(state.token).toBeNull();
    expect(state.cursor).toBeNull();
    expect(state.notes).toEqual({});
  });

  it("ignores a local storage entry that is not what the plugin wrote", () => {
    expect(joinState(null, "garbage", () => "id")).toMatchObject({ token: null, notes: {}, deviceId: "id" });
    expect(joinState(null, { token: 5, notes: [1, 2] }, () => "id")).toMatchObject({ token: null, notes: {} });
  });

  it("leaves out a note entry that is not whole, so that note is met again as a new one", () => {
    const device = { notes: { "a.md": KEPT.notes["Ideas/a.md"], "b.md": { id: "x", version: "2", hash: "h", savedPath: "b.md" }, "c.md": { version: 1 } } };
    expect(Object.keys(joinState(null, device, () => "id").notes)).toEqual(["a.md"]);
  });

  it("starts a device that kept its notes by path and version, as the plugin did before notes were encrypted, as one that has never synced", () => {
    const older = { token: "nx_x", cursor: "42", versions: { "Ideas/a.md": 3 }, hashes: { "Ideas/a.md": "h" }, pendingDeletes: ["Ideas/gone.md"], pendingPulls: ["Ideas/locked.md"], deviceId: "kept-id" };
    const state = joinState({ address: KEPT.address, user: KEPT.user }, older, () => "id");
    expect(state.token, "the sign-in is kept").toBe("nx_x");
    expect(state.deviceId, "so is the device's id").toBe("kept-id");
    expect(state.cursor, "the old cursor belongs to a feed of plain text").toBeNull();
    expect(state.notes).toEqual({});
    expect(state.pendingDeletes, "a delete named by path cannot be sent: Nexus names notes by id").toEqual([]);
    expect(state.pendingPulls).toEqual([]);
  });
});

describe("a note's id", () => {
  it("is random, url-safe base64 of 16 bytes, and the kind of id the server accepts", () => {
    const ids = new Set(Array.from({ length: 50 }, newNoteId));
    expect(ids.size, "never the same twice").toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("the id and the name a sign-in carries", () => {
  it("makes a long random id each time", () => {
    const ids = new Set(Array.from({ length: 20 }, newDeviceId));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("labels the sign-in with the name the person typed, else the platform's name and a few characters of the id", () => {
    expect(signInLabel("Test Mac", "Mac", "3fa91c0de7b24455")).toBe("Test Mac");
    expect(signInLabel(undefined, "iPhone", "3fa91c0de7b24455")).toBe("iPhone 3fa9");
    expect(signInLabel("   ", "iPhone", "3fa91c0de7b24455")).toBe("iPhone 3fa9");
  });
});
