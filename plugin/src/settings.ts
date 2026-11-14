// The plugin's settings tab: the Nexus address, the user name, this device's name, the status line, and signing in and
// out. It is Obsidian's own settings tab, with Obsidian's own look and theme, so it has no styles of its own. The token
// is never shown here or anywhere else: the tab only says whether the plugin is signed in.
//
// A new install has no address and no user name, and the tab asks for both before it offers to sign in.

import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type NexusPlugin from "./main";
import { signIn } from "./sign-in";
import { isSetUp } from "./state";
import type { PluginData } from "./types";

/** What the address field shows, greyed, while it is empty: the shape of an address, not a real one. */
const ADDRESS_EXAMPLE = "https://nexus.example.com/api";

/** What the person sees while a sign-in waits for them to allow it. */
interface Waiting {
  link: string;
  code: string;
  cancelled: boolean;
}

/** The address as it is kept: trimmed, with no trailing slash. Empty when it does not look like a web address. */
const cleanAddress = (typed: string): string => {
  const address = typed.trim().replace(/\/+$/, "");
  return /^https?:\/\/\S+$/i.test(address) ? address : "";
};

export class NexusSettingTab extends PluginSettingTab {
  private statusLine: Setting | null = null;
  private waiting: Waiting | null = null;

  constructor(app: App, private readonly plugin: NexusPlugin) {
    super(app, plugin);
  }

  /** Shows the engine's status line in the tab, when the tab is open. */
  showStatus(): void {
    this.statusLine?.setDesc(this.plugin.engine.status());
  }

  display(): void {
    const { containerEl } = this;
    const { state } = this.plugin;
    containerEl.empty();

    this.statusLine = new Setting(containerEl).setName("Status").setDesc(this.plugin.engine.status());
    if (isSetUp(state) && state.token !== null) {
      this.statusLine.addButton((button) => button.setButtonText("Sync now").onClick(() => void this.plugin.engine.sync()));
    }

    new Setting(containerEl)
      .setName("Nexus address")
      .setDesc("Where your Nexus server is: the address its routes sit under, with no slash at the end. Changing it signs this vault out, and the next sign-in brings the notes together again.")
      .addText((text) => {
        text.setPlaceholder(ADDRESS_EXAMPLE).setValue(state.address);
        text.inputEl.addEventListener("blur", () => void this.changeAddress(text.getValue(), (shown) => text.setValue(shown)));
      });

    new Setting(containerEl)
      .setName("User name")
      .setDesc("The user this vault signs in to Nexus as. Nexus asks that user to allow this device. Changing it signs this vault out, and the next sign-in brings the notes together again.")
      .addText((text) => {
        text.setPlaceholder("Your user name").setValue(state.user);
        text.inputEl.addEventListener("blur", () => void this.changeUser(text.getValue()));
      });

    this.showAccount(containerEl);

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Used in the name of a clash copy, and shown in Nexus's list of signed-in devices. Left empty it is the kind of device.")
      .addText((text) =>
        text.setPlaceholder(this.plugin.deviceName()).setValue(state.deviceName ?? "").onChange(async (typed) => {
          if (typed.trim() === "") delete state.deviceName;
          else state.deviceName = typed.trim();
          await this.plugin.save();
        }),
      );
  }

  /** The sign in and sign out button, or the link and code while a sign-in waits to be allowed. */
  private showAccount(containerEl: HTMLElement): void {
    const { state } = this.plugin;
    const account = new Setting(containerEl).setName("Account");

    if (this.waiting) {
      const waiting = this.waiting;
      account.setDesc(createFragment((fragment) => {
        fragment.appendText("Allow this device on the page that just opened, if it did not open use ");
        fragment.createEl("a", { text: "this link", href: waiting.link });
        fragment.appendText(". The code is ");
        fragment.createEl("strong", { text: waiting.code });
        fragment.appendText(".");
      }));
      account.addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          waiting.cancelled = true;
          this.waiting = null;
          this.display();
        }),
      );
      return;
    }

    if (state.token !== null) {
      account.setDesc("Signed in.");
      account.addButton((button) =>
        button.setButtonText("Sign out").setWarning().onClick(async () => {
          state.token = null;
          await this.plugin.save();
          new Notice("Signed out of Nexus.");
          this.plugin.showStatus();
          this.display();
        }),
      );
      return;
    }

    if (!isSetUp(state)) {
      account.setDesc("Enter the Nexus address and your user name above first. Nothing is sent to Nexus until both are set.");
      return;
    }

    account.setDesc(`Not signed in. Signing in opens a page on your Nexus server where ${state.user} allows this device.`);
    account.addButton((button) => button.setButtonText("Sign in").setCta().onClick(() => void this.signIn()));
  }

  private async signIn(): Promise<void> {
    if (this.waiting || !isSetUp(this.plugin.state)) return;
    const waiting: Waiting = { link: "", code: "", cancelled: false };
    this.waiting = waiting;
    this.display();
    try {
      const result = await signIn({
        http: this.plugin.http,
        data: this.plugin.state,
        persist: () => this.plugin.save(),
        device: this.plugin.signInLabel(),
        show: (link, code) => {
          waiting.link = link;
          waiting.code = code;
          this.display();
        },
        open: (link) => void window.open(link),
        wait: (ms) =>
          new Promise<void>((resolve, reject) =>
            window.setTimeout(() => (waiting.cancelled ? reject(new Error("The sign-in was cancelled.")) : resolve()), ms),
          ),
      });
      if (result === "signed-in") {
        new Notice("Signed in to Nexus.");
        void this.plugin.engine.sync();
      } else if (result === "denied") {
        new Notice("Nexus sign-in was denied.");
      } else {
        new Notice("The Nexus sign-in ran out. Try again.");
      }
    } catch (error) {
      if (!waiting.cancelled) new Notice(error instanceof Error ? error.message : "The Nexus sign-in did not work.");
    } finally {
      if (this.waiting === waiting) this.waiting = null;
      this.plugin.showStatus();
      this.display();
    }
  }

  /**
   * A new address or a new user starts over: the token and what was stored belong to the old one. A different user may be
   * allowed to see different notes, so the changes cursor and the versions are not carried across either, and the first
   * sync that follows (which deletes nothing) brings the vault and Nexus together again.
   */
  private async startOver(change: (state: PluginData) => void, message: string): Promise<void> {
    const { state } = this.plugin;
    if (this.waiting) {
      this.waiting.cancelled = true;
      this.waiting = null;
    }
    change(state);
    state.token = null;
    state.cursor = null;
    state.versions = {};
    state.hashes = {};
    state.pendingDeletes = [];
    state.pendingPulls = [];
    await this.plugin.save();
    new Notice(message);
    this.plugin.showStatus();
    this.display();
  }

  /** An empty field clears the address; anything else has to look like a web address. */
  private async changeAddress(typed: string, show: (shown: string) => void): Promise<void> {
    const { state } = this.plugin;
    const address = cleanAddress(typed);
    if (address === "" && typed.trim() !== "") {
      new Notice("The Nexus address has to start with http:// or https://");
      show(state.address);
      return;
    }
    if (address === state.address) return;
    await this.startOver((data) => (data.address = address), address === "" ? "Nexus address cleared." : "Nexus address changed. Sign in again.");
  }

  private async changeUser(typed: string): Promise<void> {
    const user = typed.trim();
    if (user === this.plugin.state.user) return;
    await this.startOver((data) => (data.user = user), user === "" ? "Nexus user name cleared." : "Nexus user changed. Sign in again.");
  }
}
