// The plugin's own entry (src/main.ts), run over a stand-in for Obsidian's `Plugin` class: it gives the engine the key holder, which
// starts locked; the status line follows the holder; a new address or a new user lets go of the key (it was another vault's); and
// unloading the plugin drops the key, overwritten with zeros. No network: the stand-in's `requestUrl` fails the test if it is called.

import { beforeEach, describe, expect, it, vi } from "vitest";

const requested: string[] = [];

vi.mock("obsidian", async () => {
  const fake = await import("./fake-obsidian");
  class Plugin {
    stored: unknown = null;
    constructor(readonly app: unknown, readonly manifest: unknown) {}
    async loadData(): Promise<unknown> {
      return this.stored;
    }
    async saveData(data: unknown): Promise<void> {
      this.stored = data;
    }
    addSettingTab(): void {}
    addStatusBarItem(): never {
      throw new Error("the stand-in is a phone: no status bar");
    }
    addCommand(): void {}
    registerEvent(): void {}
    registerDomEvent(): void {}
  }
  return {
    ...fake,
    Plugin,
    TFile: class TFile {},
    Platform: { isDesktop: false, isIosApp: true, isTablet: false },
    requestUrl: (request: { url: string }) => {
      requested.push(request.url);
      throw new Error("the plugin asked Nexus for something in a test that has no network");
    },
  };
});

const { default: NexusPlugin } = await import("../src/main");

const KEY = (): { vaultKey: Uint8Array; vaultId: string; kid: number } => ({ vaultKey: new Uint8Array(32).fill(0x5a), vaultId: "a-vault", kid: 1 });

async function loadedPlugin() {
  const local = new Map<string, unknown>();
  const app = {
    loadLocalStorage: (key: string) => local.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => void local.set(key, value),
    workspace: { onLayoutReady: () => undefined },
    vault: {},
    fileManager: {},
  };
  const plugin = new NexusPlugin(app as never, {} as never);
  const standIn = plugin as unknown as { stored: unknown };
  standIn.stored = { address: "https://nexus.example.com/nexus/api", user: "someone" };
  await plugin.onload();
  plugin.state.token = "nx_a_token_this_device_holds";
  return { plugin, local, stored: () => standIn.stored };
}

beforeEach(() => {
  requested.length = 0;
});

describe("the plugin's entry", () => {
  it("gives the engine the key holder: the status line says locked until a key is put there, and follows the holder", async () => {
    const { plugin } = await loadedPlugin();
    expect(plugin.keyHolder.keys()).toBeNull();
    expect(plugin.setup.state).toEqual({ step: "locked" });
    expect(plugin.engine.status()).toMatch(/locked/i);

    plugin.keyHolder.unlock(KEY());
    expect(plugin.engine.status(), "the engine reads the key from the holder").not.toMatch(/locked/i);
    expect(plugin.setup.state, "and the setup says so").toEqual({ step: "unlocked" });

    plugin.setup.lock();
    expect(plugin.engine.status()).toMatch(/locked/i);
    expect(plugin.keyHolder.keys()).toBeNull();
  });

  it("drops the key when the plugin unloads: overwritten with zeros, and the setup is locked", async () => {
    const { plugin } = await loadedPlugin();
    const keys = KEY();
    plugin.keyHolder.unlock(keys);
    plugin.onunload();
    expect(plugin.keyHolder.keys()).toBeNull();
    expect(keys.vaultKey.every((byte) => byte === 0)).toBe(true);
    expect(plugin.setup.state).toEqual({ step: "locked" });
    expect(requested, "and nothing was asked of Nexus").toEqual([]);
  });

  it("lets go of the key when the address or the user name changes, because the key belonged to the other vault; saving the same ones keeps it", async () => {
    const { plugin } = await loadedPlugin();
    const keys = KEY();
    plugin.keyHolder.unlock(keys);

    await plugin.save();
    expect(plugin.keyHolder.keys(), "nothing changed").not.toBeNull();

    plugin.state.user = "somebody else";
    await plugin.save();
    expect(plugin.keyHolder.keys(), "another user: locked").toBeNull();
    expect(keys.vaultKey.every((byte) => byte === 0)).toBe(true);

    const again = KEY();
    plugin.keyHolder.unlock(again);
    plugin.state.address = "https://other.example.com/nexus/api";
    await plugin.save();
    expect(plugin.keyHolder.keys(), "another address: locked").toBeNull();
    expect(again.vaultKey.every((byte) => byte === 0)).toBe(true);
  });

  it("never writes the key where the plugin saves its data", async () => {
    const { plugin, local, stored } = await loadedPlugin();
    plugin.keyHolder.unlock(KEY());
    plugin.state.deviceName = "My phone";
    await plugin.save();
    const written = JSON.stringify([stored(), [...local.entries()]]);
    expect(written).not.toContain("a-vault");
    expect(written).not.toContain(Buffer.from(KEY().vaultKey).toString("base64"));
    expect(written).not.toContain("vaultKey");
  });
});
