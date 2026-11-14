// A new install has no server address and no user name, and there is no default for either. Until both are entered the
// plugin asks for them (in its status line, and in the sign-in's refusal) and sends nothing to anyone: no sync, no push,
// no rename, no delete, no sign-in. Once both are set it goes on as it always did. The data a new install starts with is
// made by the plugin's own joinState, the way main.ts makes it, never written out by hand. Against the in-memory Nexus.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_SET_UP, joinState } from "../src/state";
import { bodyOf, deviceRoutes, emptyNexus, forbidFetch, loadSignIn, makeDevice, nexusTexts, openWorld, type World } from "./world";

let world: World;

beforeAll(async () => {
  world = await openWorld();
});

beforeEach(async () => {
  await emptyNexus();
  forbidFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What a fresh install holds: nothing in the data file and nothing in local storage. */
const freshInstall = () => joinState(null, null);

const FILES = { "Ideas/a.md": "one\n", "Daily/b.md": "two\n" };

describe("a fresh install with no settings", () => {
  it("starts with no address and no user name", () => {
    const fresh = freshInstall();
    expect(fresh.address).toBe("");
    expect(fresh.user).toBe("");
    expect(fresh.token).toBeNull();
  });

  it("asks for the server address and the user name in its status line", async () => {
    const device = await makeDevice(world, { files: FILES, from: freshInstall() });
    expect(device.engine.status()).toBe(NOT_SET_UP);
    expect(device.engine.status()).toMatch(/server address/i);
    expect(device.engine.status()).toMatch(/user name/i);
  });

  it("syncs nothing, and sends nothing, whatever the vault does", async () => {
    const device = await makeDevice(world, { files: FILES, from: freshInstall() });
    device.vault.type("Ideas/a.md", "one, edited\n");
    const before = device.vault.texts();

    await device.engine.sync();
    await device.engine.cameToFront();
    await device.engine.push("Ideas/a.md");
    await device.engine.renamed("Ideas/a.md", "Ideas/c.md");
    await device.engine.deleted("Daily/b.md");

    expect(device.log.requests(), "no call to any server").toEqual([]);
    expect(await nexusTexts(world), "and Nexus holds nothing").toEqual({});
    expect(device.engine.status()).toBe(NOT_SET_UP);
    expect(device.vault.texts(), "the vault is as the person left it").toEqual(before);
  });

  it("refuses to sign in, in the same words, and sends nothing", async () => {
    const { signIn } = await loadSignIn();
    const device = await makeDevice(world, { from: freshInstall() });
    const shown: string[] = [];

    await expect(
      signIn({
        http: device.deps.http,
        data: device.deps.data,
        persist: async () => undefined,
        device: "Test iPhone",
        show: (link) => shown.push(link),
        open: (link) => shown.push(link),
        wait: async () => undefined,
      }),
    ).rejects.toThrow(NOT_SET_UP);

    expect(device.log.requests()).toEqual([]);
    expect(shown).toEqual([]);
  });
});

describe("a plugin that has only one of the two", () => {
  it.each([
    { name: "the address but no user name", address: "https://example.test/nexus/api", user: "" },
    { name: "the user name but no address", address: "", user: "demo" },
    { name: "an address and a user name of only spaces", address: "   ", user: "  " },
  ])("with $name sends nothing, even when it still holds a token", async ({ address, user }) => {
    const device = await makeDevice(world, { files: FILES, address, user });

    await device.engine.sync();
    await device.engine.push("Ideas/a.md");
    await device.engine.deleted("Daily/b.md");

    expect(device.log.requests()).toEqual([]);
    expect(device.engine.status()).toBe(NOT_SET_UP);
    expect(device.deps.data.token, "the token it holds is left alone, not sent and not forgotten").toBe(world.token);
  });
});

describe("once both are set", () => {
  it("the notes that waited go up on the next sync, and the status line stops asking", async () => {
    const device = await makeDevice(world, { files: FILES, address: "", user: "" });
    await device.engine.sync();
    expect(device.log.requests()).toEqual([]);

    // The settings tab writes into the plugin's live data, one field at a time, as the person types them.
    device.deps.data.address = world.address;
    await device.engine.sync();
    expect(device.log.requests(), "the address alone is not enough").toEqual([]);

    device.deps.data.user = world.user;
    await device.engine.sync();

    expect(await nexusTexts(world)).toEqual(FILES);
    expect(device.engine.status()).toMatch(/last synced/i);
    expect(device.log.requests().every((seen) => seen.authorization === `Bearer ${world.token}`)).toBe(true);
  });

  it("a plugin that is set up but not signed in says it is signed out, as before", async () => {
    const device = await makeDevice(world, { files: FILES, token: null });
    await device.engine.sync();
    expect(device.engine.status()).toMatch(/signed out/i);
    expect(device.log.requests()).toEqual([]);
  });

  it("signs in as the user that was entered", async () => {
    const { signIn } = await loadSignIn();
    const device = await makeDevice(world, { token: null });
    const plugin = { shown: [] as string[] };

    const result = await signIn({
      http: device.deps.http,
      data: device.deps.data,
      persist: async () => undefined,
      device: "Test iPhone",
      show: (link) => plugin.shown.push(link),
      open: () => undefined,
      wait: async () => {
        const code = new URL(plugin.shown[0]!).searchParams.get("code")!;
        bodyOf(await deviceRoutes({ cookie: world.ownerCookie }).approve(code));
      },
    });

    expect(result).toBe("signed-in");
    expect(device.log.to("POST device/start")[0]?.body).toEqual({ identity: world.user, label: "Test iPhone" });
  });
});
