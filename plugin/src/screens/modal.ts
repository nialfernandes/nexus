// The modal Obsidian shows the screens in: on a phone it fills Obsidian's mobile modal, and in desktop Obsidian it is the same layout in a
// centred modal about 560 px wide, with the teal band as the modal's top (styles.css). The modal only holds the screens: it hands them the
// setup controller, the clipboard and the clock, and closes when they say they are done. Closing it by any other way (the close mark,
// Escape, a tap outside) leaves what was going on: the screens throw it away.

import { Modal, type App } from "obsidian";
import type { VaultSetup } from "../vault-setup";
import { SetupScreens, type Entry } from "./setup-screens";

export class NexusSetupModal extends Modal {
  #screens: SetupScreens | null = null;

  constructor(
    app: App,
    private readonly setup: VaultSetup,
    private readonly entry: Entry,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("nexus-modal");
    this.contentEl.empty();
    const screens = new SetupScreens({
      setup: this.setup,
      copy: (words) => navigator.clipboard.writeText(words),
      later: (ms, run) => {
        const timer = window.setTimeout(run, ms);
        return () => window.clearTimeout(timer);
      },
      close: () => this.close(),
    });
    this.#screens = screens;
    this.contentEl.append(screens.element);
    void screens.start(this.entry);
  }

  onClose(): void {
    this.#screens?.dispose();
    this.#screens = null;
    this.contentEl.empty();
  }
}
