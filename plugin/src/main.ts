// The plugin's entry: the one file that talks to Obsidian. It wires Obsidian's own vault, `requestUrl`, `Notice` and
// events to the sync engine's ports, keeps the plugin's data, and shows the status line in the status bar. Only
// Obsidian's own APIs are used (nothing from Node or Electron), so it runs on a phone as well as on a desktop.

import { Notice, Platform, Plugin, TFile, requestUrl, type App } from "obsidian";
import { NexusSettingTab } from "./settings";
import { STATE_KEY, joinState, sharedHasMore, signInLabel, splitState } from "./state";
import { createSyncEngine } from "./sync";
import type { Http, PluginData, SyncEngine, VaultPort } from "./types";
import { NEVER_UNLOCKED } from "./unlock";

/** A second "came to the front" within this long of the last one is the same coming back (the window and the page both say so). */
const FRONT_SETTLE_MS = 2_000;

/** Obsidian's vault as the engine's port. Files are found by path; folders are made on the way. */
function vaultPort(app: App): VaultPort {
  const { vault, fileManager } = app;
  const fileAt = (path: string): TFile => {
    const file = vault.getFileByPath(path);
    if (!file) throw new Error(`${path} is not in the vault.`);
    return file;
  };
  const makeFolders = async (path: string): Promise<void> => {
    let folder = "";
    for (const step of path.split("/").slice(0, -1)) {
      folder = folder === "" ? step : `${folder}/${step}`;
      if (!vault.getFolderByPath(folder)) await vault.createFolder(folder);
    }
  };
  return {
    files: async () => vault.getFiles().map((file) => file.path),
    read: (path) => vault.read(fileAt(path)),
    async write(path, text) {
      const existing = vault.getFileByPath(path);
      if (existing) {
        await vault.modify(existing, text);
        return;
      }
      await makeFolders(path);
      await vault.create(path, text);
    },
    async rename(from, to) {
      const file = fileAt(from);
      await makeFolders(to);
      await vault.rename(file, to);
    },
    // The person's own choice of trash (the vault's .trash folder or the system's) decides where a removed note goes.
    remove: (path) => fileManager.trashFile(fileAt(path)),
  };
}

export default class NexusPlugin extends Plugin {
  /** Everything the plugin keeps. Only the address is saved in the data file; the rest is this device's own (see state.ts). */
  state: PluginData = joinState(null, null);
  engine!: SyncEngine;
  /** Obsidian's `requestUrl`, narrowed to what the engine and the sign-in use. */
  readonly http: Http = (request) => requestUrl(request);

  private statusBar: HTMLElement | null = null;
  private settingTab: NexusSettingTab | null = null;
  private saving: Promise<void> = Promise.resolve();
  /** The address as the data file holds it, so the file is only written when the address changes. */
  private savedAddress = "";
  private lastFront = 0;

  async onload(): Promise<void> {
    // The data file is inside the vault and travels with it between devices, so it holds the address and nothing else.
    // The token, the device's id and name, the cursor and what is known of each note are this device's own: Obsidian's local storage.
    const shared: unknown = await this.loadData();
    this.state = joinState(shared, this.app.loadLocalStorage(STATE_KEY));
    this.savedAddress = this.state.address;
    this.app.saveLocalStorage(STATE_KEY, splitState(this.state).device);
    if (sharedHasMore(shared)) await this.saveData(splitState(this.state).shared); // a token left in the file is taken out of it

    const plugin = this;
    this.engine = createSyncEngine({
      vault: vaultPort(this.app),
      http: this.http,
      data: this.state,
      persist: () => this.save(),
      notify: (message) => void new Notice(message, 15_000),
      get device() {
        return plugin.deviceName();
      },
      now: () => new Date(),
      // The setup screens that make and unlock the vault key are a later piece of work. Until they exist nothing is ever unlocked,
      // so the plugin syncs nothing and the status line says the vault is locked.
      unlock: NEVER_UNLOCKED,
      onStatus: () => this.showStatus(),
    });

    this.settingTab = new NexusSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    if (Platform.isDesktop) this.statusBar = this.addStatusBarItem();
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.engine.sync() });
    this.showStatus();

    // Obsidian reports every existing file as created while it loads the vault. Waiting for the layout to be ready
    // means only real changes reach the engine, and the first sync starts once the vault is all there.
    this.app.workspace.onLayoutReady(() => {
      const { vault } = this.app;
      this.registerEvent(vault.on("create", (file) => file instanceof TFile && this.engine.edited(file.path)));
      this.registerEvent(vault.on("modify", (file) => file instanceof TFile && this.engine.edited(file.path)));
      this.registerEvent(vault.on("rename", (file, oldPath) => file instanceof TFile && void this.engine.renamed(oldPath, file.path)));
      this.registerEvent(vault.on("delete", (file) => file instanceof TFile && void this.engine.deleted(file.path)));
      this.registerDomEvent(document, "visibilitychange", () => document.visibilityState === "visible" && this.cameToFront());
      this.registerDomEvent(window, "focus", () => this.cameToFront());
      this.engine.start();
    });
  }

  onunload(): void {
    this.engine?.stop();
  }

  /** What kind of device this is, from what Obsidian says about the platform. */
  private platformName(): string {
    if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
    if (Platform.isAndroidApp) return Platform.isTablet ? "Android tablet" : "Android phone";
    if (Platform.isMacOS) return "Mac";
    if (Platform.isWin) return "Windows PC";
    if (Platform.isLinux) return "Linux PC";
    return "Obsidian";
  }

  /** The name this device goes by in a clash copy: the one set in the settings, else the platform's name. */
  deviceName(): string {
    return this.state.deviceName?.trim() || this.platformName();
  }

  /** The name a sign-in carries to Nexus: the name set in the settings, else the platform's name and a few characters of the device's id. */
  signInLabel(): string {
    return signInLabel(this.state.deviceName, this.platformName(), this.state.deviceId ?? "");
  }

  /** Saves the plugin's data: this device's part to local storage, and the address to the data file when it changed. Saves queue. */
  save(): Promise<void> {
    const { shared, device } = splitState(this.state);
    this.app.saveLocalStorage(STATE_KEY, device);
    if (shared.address !== this.savedAddress) {
      this.savedAddress = shared.address;
      this.saving = this.saving.then(() => this.saveData(shared)).catch((error) => console.error("Nexus plugin: could not save its data:", error));
    }
    return this.saving;
  }

  /** Called when the status line changed: the status bar and the open settings tab show the new words. */
  showStatus(): void {
    this.statusBar?.setText(`Nexus: ${this.engine.status()}`);
    this.settingTab?.showStatus();
  }

  private cameToFront(): void {
    const now = Date.now();
    if (now - this.lastFront < FRONT_SETTLE_MS) return;
    this.lastFront = now;
    void this.engine.cameToFront();
  }
}
