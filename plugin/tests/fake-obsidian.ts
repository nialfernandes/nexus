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
  setDesc(desc: string | DocumentFragment): this {
    this.desc = typeof desc === "string" ? desc : "[a link and a code]";
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

export class PluginSettingTab {
  readonly containerEl = new FakeContainer();
  constructor(
    readonly app: unknown,
    readonly plugin: unknown,
  ) {}
}
