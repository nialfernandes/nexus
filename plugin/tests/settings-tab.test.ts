// The settings tab, run for real over a stand-in for Obsidian's own classes (fake-obsidian.ts). A new install asks for the
// server address and the user name, and offers no sign-in until both are there; typing them in is saved and signs the
// vault out and starts the sync over (a different address, or a different user, may be allowed to see different notes);
// an empty field clears one; an address that is no address is refused and not kept. The plugin the tab sits in is a small
// stand-in that keeps what it is told to save, because the real one (main.ts) can only be loaded inside Obsidian.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "./fake-obsidian";

vi.mock("obsidian", () => import("./fake-obsidian"));

const { NexusSettingTab } = await import("../src/settings");
const { NOT_SET_UP, joinState } = await import("../src/state");

import type { PluginData } from "../src/types";
import type { FakeText, Setting } from "./fake-obsidian";

/** The part of the plugin that the tab reads and calls. */
function fakePlugin(state: PluginData) {
  const saved: PluginData[] = [];
  const plugin = {
    state,
    saved,
    statusShown: 0,
    engine: { status: () => (state.address === "" || state.user === "" ? NOT_SET_UP : "Signed out. Open the Nexus settings and sign in."), sync: async () => undefined },
    http: async () => {
      throw new Error("the tab must not call Nexus while it is being set up");
    },
    deviceName: () => "Test iPhone",
    signInLabel: () => "Test iPhone",
    save: async () => {
      saved.push(structuredClone(state));
    },
    showStatus() {
      plugin.statusShown++;
    },
  };
  return plugin;
}

function openTab(state: PluginData) {
  const plugin = fakePlugin(state);
  const tab = new NexusSettingTab({} as never, plugin as never);
  tab.display();
  const settings = (): Setting[] => (tab as unknown as { containerEl: { settings: Setting[] } }).containerEl.settings;
  const named = (name: string): Setting => {
    const found = settings().find((setting) => setting.name === name);
    if (!found) throw new Error(`the tab has no setting called ${name}: it has ${settings().map((s) => s.name).join(", ")}`);
    return found;
  };
  const field = (name: string): FakeText => named(name).texts[0]!;
  return { plugin, tab, settings, named, field };
}

const ADDRESS = "https://nexus.example.com/apps/nexus/api";

beforeEach(() => {
  Notice.clear();
});

describe("the settings tab of a fresh install", () => {
  it("asks for the server address and the user name, both empty, with an example address shown greyed", () => {
    const { named, field, settings } = openTab(joinState(null, null));
    expect(settings().map((setting) => setting.name)).toEqual(["Status", "Nexus address", "User name", "Account", "Device name"]);
    expect(named("Status").desc).toBe(NOT_SET_UP);
    expect(field("Nexus address").value).toBe("");
    expect(field("Nexus address").placeholder).toBe(ADDRESS);
    expect(field("User name").value).toBe("");
  });

  it("offers no sign-in, and says what to do first", () => {
    const { named } = openTab(joinState(null, null));
    expect(named("Account").buttons, "no Sign in button").toEqual([]);
    expect(named("Account").desc).toMatch(/address and your user name/i);
  });

  it("offers no sign-in with only one of the two entered", async () => {
    const { named, field } = openTab(joinState(null, null));
    await field("Nexus address").typeAndLeave(ADDRESS);
    expect(named("Account").buttons).toEqual([]);
  });

  it("offers the sign-in once both are entered, saves them, and sends nothing to Nexus", async () => {
    const state = joinState(null, null);
    const { plugin, named, field } = openTab(state);

    await field("Nexus address").typeAndLeave(`  ${ADDRESS}/  `);
    await field("User name").typeAndLeave("  demo ");

    expect(plugin.state.address, "trimmed, with no slash at the end").toBe(ADDRESS);
    expect(plugin.state.user).toBe("demo");
    expect(plugin.saved.at(-1)).toMatchObject({ address: ADDRESS, user: "demo", token: null });
    expect(named("Account").buttons.map((button) => button.text)).toEqual(["Sign in"]);
    expect(named("Account").desc).toContain("demo");
    expect(field("Nexus address").value, "the tab shows the address as it was kept").toBe(ADDRESS);
    expect(field("User name").value).toBe("demo");
  });
});

describe("changing what was entered", () => {
  const signedIn = (): PluginData => ({
    ...joinState({ address: ADDRESS, user: "demo" }, null, () => "id"),
    token: "nx_TOKEN",
    cursor: "7",
    versions: { "Ideas/a.md": 2 },
    hashes: { "Ideas/a.md": "h" },
    pendingDeletes: ["gone.md"],
    pendingPulls: ["locked.md"],
  });

  it("a different user signs the vault out and starts the sync over", async () => {
    const { plugin, field } = openTab(signedIn());
    await field("User name").typeAndLeave("other");
    expect(plugin.state).toMatchObject({ user: "other", token: null, cursor: null, versions: {}, hashes: {}, pendingDeletes: [], pendingPulls: [] });
    expect(plugin.state.address, "the address is kept").toBe(ADDRESS);
    expect(Notice.messages).toEqual(["Nexus user changed. Sign in again."]);
  });

  it("a different address signs the vault out and starts the sync over", async () => {
    const { plugin, field } = openTab(signedIn());
    await field("Nexus address").typeAndLeave("https://other.example.com/api");
    expect(plugin.state).toMatchObject({ address: "https://other.example.com/api", user: "demo", token: null, cursor: null, versions: {} });
    expect(Notice.messages).toEqual(["Nexus address changed. Sign in again."]);
  });

  it("the same address or user typed again changes nothing and is not saved", async () => {
    const { plugin, field } = openTab(signedIn());
    await field("Nexus address").typeAndLeave(`${ADDRESS}/`);
    await field("User name").typeAndLeave(" demo ");
    expect(plugin.saved).toEqual([]);
    expect(plugin.state.token).toBe("nx_TOKEN");
    expect(Notice.messages).toEqual([]);
  });

  it("an empty field clears the address or the user name, and the vault is not set up again until both are back", async () => {
    const { plugin, named, field } = openTab(signedIn());
    await field("Nexus address").typeAndLeave("");
    expect(plugin.state).toMatchObject({ address: "", user: "demo", token: null });
    expect(named("Account").buttons).toEqual([]);
    expect(Notice.messages).toEqual(["Nexus address cleared."]);
  });

  it("an address that is not a web address is refused, said so, shown as it was, and not kept", async () => {
    const { plugin, field } = openTab(signedIn());
    await field("Nexus address").typeAndLeave("nexus.example.com");
    expect(plugin.state.address).toBe(ADDRESS);
    expect(plugin.state.token, "still signed in").toBe("nx_TOKEN");
    expect(plugin.saved).toEqual([]);
    expect(field("Nexus address").value).toBe(ADDRESS);
    expect(Notice.messages).toEqual(["The Nexus address has to start with http:// or https://"]);
  });

  it("shows the Sync now button only for a plugin that is set up and signed in", () => {
    expect(openTab(signedIn()).named("Status").buttons.map((button) => button.text)).toEqual(["Sync now"]);
    expect(openTab(joinState(null, null)).named("Status").buttons).toEqual([]);
    expect(openTab({ ...signedIn(), user: "" }).named("Status").buttons, "a token without a user name is not enough").toEqual([]);
  });
});
