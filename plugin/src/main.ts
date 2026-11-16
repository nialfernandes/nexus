// The plugin's entry: the one file that talks to Obsidian. It wires Obsidian's own vault, `requestUrl`, `Notice` and
// events to the sync engine's ports, keeps the plugin's data, and shows the status line in the status bar. Only
// Obsidian's own APIs are used (nothing from Node or Electron), so it runs on a phone as well as on a desktop.

import { Notice, Platform, Plugin, TFile, requestUrl, type App } from "obsidian";
import { KeyHolder } from "./key-holder";
import { NexusSetupModal } from "./screens/modal";
import type { Entry } from "./screens/setup-screens";
import { NexusSettingTab } from "./settings";
import { STATE_KEY, joinState, sharedHasMore, signInLabel, splitState } from "./state";
import { createSyncEngine } from "./sync";
import type { Http, PluginData, SyncEngine, VaultPort } from "./types";
import { VaultSetup } from "./vault-setup";

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
  /** Holds the vault key while the vault is unlocked, in memory only: the engine's `unlock` port, and where the setup puts the key. Starts locked. */
  readonly keyHolder = new KeyHolder((unlocked) => this.keyChanged(unlocked));
  /** Sets up, unlocks, approves and locks the vault: the state machine the setup screens (src/screens) drive. */
  setup!: VaultSetup;
  /** Obsidian's `requestUrl`, narrowed to what the engine and the sign-in use. */
  readonly http: Http = (request) => requestUrl(request);

  private statusBar: HTMLElement | null = null;
  private settingTab: NexusSettingTab | null = null;
  private saving: Promise<void> = Promise.resolve();
  /** The address as the data file holds it, so the file is only written when the address changes. */
  private savedAddress = "";
  private lastFront = 0;
  /** The address and user the key held belongs to: a vault is the one a server holds for a user, so a change of either lets go of the key. */
  private keyedFor = "";

  async onload(): Promise<void> {
    // The data file is inside the vault and travels with it between devices, so it holds the address and nothing else.
    // The token, the device's id and name, the cursor and what is known of each note are this device's own: Obsidian's local storage.
    const shared: unknown = await this.loadData();
    this.state = joinState(shared, this.app.loadLocalStorage(STATE_KEY));
    this.savedAddress = this.state.address;
    this.keyedFor = this.serverKey();
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
      // The key holder starts locked, so the plugin syncs nothing and the status line says the vault is locked until the setup unlocks it.
      unlock: this.keyHolder,
      onStatus: () => this.showStatus(),
    });
    this.setup = new VaultSetup({
      http: this.http,
      data: this.state,
      persist: () => this.save(),
      device: () => this.signInLabel(),
      keys: this.keyHolder,
      open: (link) => void window.open(link),
      wait: (ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
    });

    this.settingTab = new NexusSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    if (Platform.isDesktop) this.statusBar = this.addStatusBarItem();
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.engine.sync() });
    this.addCommand({
      id: "set-up-or-unlock",
      name: "Set up or unlock this device",
      checkCallback: (checking) => {
        if (this.keyHolder.isUnlocked) return false;
        if (!checking) this.openSetup("unlock");
        return true;
      },
    });
    this.addCommand({
      id: "approve-device",
      name: "Approve a device",
      checkCallback: (checking) => {
        if (!this.keyHolder.isUnlocked) return false;
        if (!checking) this.openSetup("approve");
        return true;
      },
    });
    this.addCommand({
      id: "lock",
      name: "Lock Nexus",
      checkCallback: (checking) => {
        if (!this.keyHolder.isUnlocked) return false;
        if (!checking) this.setup.lock();
        return true;
      },
    });
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
    // The key is dropped (overwritten) and nothing the setup was doing goes on.
    this.setup?.unload();
    this.keyHolder.lock();
  }

  /** Opens the setup screens: to set up or unlock this device, or to approve another one from it. */
  openSetup(entry: Entry): void {
    new NexusSetupModal(this.app, this.setup, entry).open();
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
    // A new address or a new user is another vault: the key held was this one's, so it is dropped and the vault is locked.
    if (this.serverKey() !== this.keyedFor) {
      this.keyedFor = this.serverKey();
      this.setup?.lock();
    }
    // Signing out (the settings button, or a token Nexus no longer knows) locks the vault too: a signed-out device holds no key.
    if (this.state.token === null && this.keyHolder.isUnlocked) this.setup?.lock();
    if (shared.address !== this.savedAddress) {
      this.savedAddress = shared.address;
      this.saving = this.saving.then(() => this.saveData(shared)).catch((error) => console.error("Nexus plugin: could not save its data:", error));
    }
    return this.saving;
  }

  private serverKey(): string {
    return `${this.state.address}\n${this.state.user}`;
  }

  /** The vault was locked or unlocked: the status line says so, the settings tab shows the key's row anew, and an unlock syncs at once (edits made while it was locked go up). */
  private keyChanged(unlocked: boolean): void {
    this.showStatus();
    this.settingTab?.display();
    if (unlocked) void this.engine.sync();
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
