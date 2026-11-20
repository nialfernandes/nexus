// The few classes of Obsidian's own that the settings tab uses, written down just far enough to run the tab's real code in
// a test: a settings page is a list of settings, each with a name, a description, buttons and text fields. Nothing here
// draws anything. Obsidian has no real counterpart that can run outside the app, so this is the one stand-in for it, beside
// the in-memory vault (world.ts). It is loaded in place of the `obsidian` package by settings-tab.test.ts.

export class Notice {
  /** Every notice shown since the last `Notice.clear()`, in order. */
  static messages: string[] = [];
  static clear(): void {
    Notice.messages = [];
  }
  constructor(message: string) {
    Notice.messages.push(message);
  }
}

export class FakeButton {
  text = "";
  cta = false;
  warning = false;
  clicked: () => unknown = () => undefined;
  setButtonText(text: string): this {
    this.text = text;
    return this;
  }
  setCta(): this {
    this.cta = true;
    return this;
  }
  setWarning(): this {
    this.warning = true;
    return this;
  }
  onClick(callback: () => unknown): this {
    this.clicked = callback;
    return this;
  }
}

export class FakeText {
  value = "";
  placeholder = "";
  changed: (typed: string) => unknown = () => undefined;
  /** The element the tab listens on (the tab adds a `blur` listener). */
  readonly inputEl = {
    listeners: {} as Record<string, () => unknown>,
    addEventListener(type: string, listener: () => unknown): void {
      this.listeners[type] = listener;
    },
  };
  setPlaceholder(text: string): this {
    this.placeholder = text;
    return this;
  }
  setValue(text: string): this {
    this.value = text;
    return this;
  }
  getValue(): string {
    return this.value;
  }
  onChange(callback: (typed: string) => unknown): this {
    this.changed = callback;
    return this;
  }
  /** The person types `text` into the field and leaves it. */
  async typeAndLeave(text: string): Promise<void> {
    this.value = text;
    await this.inputEl.listeners.blur?.();
  }
}

export class FakeContainer {
  settings: Setting[] = [];
  empty(): void {
    this.settings = [];
  }
}

export class Setting {
  name = "";
  desc = "";
  readonly buttons: FakeButton[] = [];
  readonly texts: FakeText[] = [];
  constructor(container: FakeContainer) {
    container.settings.push(this);
  }
  setName(name: string): this {
    this.name = name;
    return this;
  }
  /** What the setting's description is drawn into, as Obsidian's `descEl`: made when something first needs it, as only a test with a page has one. */
  get descEl(): HTMLElement {
    this.#descEl ??= document.createElement("div");
    return this.#descEl;
  }
  #descEl: HTMLElement | null = null;
  setDesc(desc: string | DocumentFragment | HTMLElement): this {
    if (typeof desc === "string") {
      this.desc = desc;
      this.#descEl?.replaceChildren(desc);
    } else {
      // Words with a link or a code in them: the text of it is `desc`, and the elements are in `descEl`, as in Obsidian.
      this.descEl.replaceChildren(desc);
      this.desc = this.descEl.textContent ?? "";
    }
    return this;
  }
  addButton(callback: (button: FakeButton) => unknown): this {
    const button = new FakeButton();
    callback(button);
    this.buttons.push(button);
    return this;
  }
  addText(callback: (text: FakeText) => unknown): this {
    const text = new FakeText();
    callback(text);
    this.texts.push(text);
    return this;
  }
}

/**
 * Obsidian's modal, as far as the setup screens' modal uses it: an element to put things in (`contentEl`) and one around it (`modalEl`),
 * each with the two helpers Obsidian adds to elements, and `open` and `close` that call `onOpen` and `onClose`. It needs a page, so it
 * is only used by tests that run in a browser-like environment.
 */
export class Modal {
  readonly modalEl: HTMLElement & { addClass: (name: string) => void };
  readonly contentEl: HTMLElement & { empty: () => void };
  isOpen = false;
  constructor(readonly app: unknown) {
    this.modalEl = Object.assign(document.createElement("div"), { addClass: (name: string) => this.modalEl.classList.add(name) });
    this.contentEl = Object.assign(document.createElement("div"), { empty: () => this.contentEl.replaceChildren() });
    this.modalEl.append(this.contentEl);
  }
  open(): void {
    this.isOpen = true;
    document.body.append(this.modalEl);
    this.onOpen();
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.onClose();
    this.modalEl.remove();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class PluginSettingTab {
  readonly containerEl = new FakeContainer();
  constructor(
    readonly app: unknown,
    readonly plugin: unknown,
  ) {}
}
