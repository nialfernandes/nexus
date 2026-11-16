// The screens of setting up, adding a device and unlocking: a drawing of the setup controller's state (vault-setup.ts), and nothing more.
// What is on screen is the controller's `state`; what the person does is one call to one of its events. This file has no key, no code
// and no check of its own: when the last box of a code is full it asks the controller to check it, and the controller says right or wrong.
// What it does keep is only what a drawing needs that the controller does not: which step of the key screens is showing, the tick, what
// is typed in the boxes so far, and whether the red is showing.
//
// Everything a device sent (the name it signed in with) is shown as text, never as markup (dom.ts).

import { passwordsAgree, type SetupState, type VaultSetup } from "../vault-setup";
import { CodeEntry, codeCharacters, type Edit } from "./code-entry";
import { el } from "./dom";
import {
  actions, boxKey, card, clockCircle, codeField, crossCircle, doneCircle, faultLine, groupRows, keyField, label, link, note, pill, readCode, screen,
  small, text, tickMark,
} from "./parts";

/** What a screen is opened for. */
export type Entry = "unlock" | "approve";

export interface ScreenDeps {
  setup: VaultSetup;
  /** Puts text on the clipboard. */
  copy: (text: string) => Promise<void>;
  /** Runs `run` after `ms`; answers what stops it. */
  later: (ms: number, run: () => void) => () => void;
  /** Closes the screen. */
  close: () => void;
}

/** How long the Copy key button says Copied. */
export const COPIED_FOR_MS = 2_000;
/** How long a device code works, as the screens say it. */
const CODE_MINUTES = 10;

/** A Recovery Key is written in this many groups. */
const KEY_GROUPS = 14;
const GROUP_SIZE = 4;
const CODE_BOXES = 10;
const SIGN_IN_BOXES = 8;

/** The words on the screens. */
export const WORDS = {
  start: {
    title: "set up nexus",
    line: "Step 1 of 4.",
    promise: "Your notes are scrambled on this device before they leave it. The Nexus server only ever holds scrambled text.",
    auditHead: "Not yet audited",
    audit: "No outside security expert has checked this encryption yet. Fine for notes. Keep another copy of anything you cannot lose.",
    next: "Next you get a Recovery Key. It is the only way back in if you lose every signed-in device. Nexus cannot reset it.",
  },
  key: {
    title: "recovery key",
    line: "Step 2 of 4.",
    once: "This is the only time it is shown. Save it now in your password manager, or write it on paper.",
    cannot: "Nexus cannot show it again or reset it. Lose it and every signed-in device, and your notes cannot be opened.",
    saved: "I saved my Recovery Key somewhere safe",
    copy: "Copy key",
    copied: "Copied",
  },
  check: {
    title: "check key",
    line: "Step 3 of 4.",
    ask: "Type three groups of it back from where you saved it. This shows it was written down right.",
    how: "Groups are blocks of four, counted from the left, top row first. Capitals or small letters both work.",
    one: (group: number) => `Group ${group} does not match. Look at your saved key and retype it.`,
    several: (groups: number[]) => `Groups ${groups.slice(0, -1).join(", ")} and ${groups.at(-1)} do not match. Look at your saved key and retype them.`,
    group: (group: number) => `Group ${group}`,
  },
  password: {
    title: "password",
    line: "Step 4 of 4.",
    optional: "Optional. Your Recovery Key already opens your notes. A password only saves typing it.",
    switchName: "Unlock with a password",
    off: "Off is safer. Off by default.",
    on: "On. Off is safer.",
    readFirst: "Read this first",
    pickLong: "Pick a long one",
    warning: "A password you can remember is much easier to guess than a Recovery Key. Anyone with a copy of your encrypted notes can try guesses on it without limit.",
    password: "Password",
    again: "Type it again",
    sameAsAbove: "Same password",
    finish: "Finish setup",
  },
  done: {
    title: "all set",
    line: "Nexus is set up.",
    text: "Your notes are scrambled on this device before they are sent. The first sync starts when you close this.",
    recoveryKey: "Recovery Key",
    savedByYou: "Saved by you",
    password: "Password",
    on: "On",
    off: "Off",
    audit: "Audit",
    notYetAudited: "Not yet audited",
  },
  waiting: {
    title: "new device",
    line: "Waiting for approval.",
    text: "On a device that is already signed in, open Nexus settings and choose Approve a device. It will ask for this code.",
    signInCode: "Sign-in code",
    deviceCode: "Device code",
    status: `Waiting. The code works for ${CODE_MINUTES} minutes.`,
  },
  approve: {
    title: "approve device",
    signInLine: "Type the sign-in code first.",
    signInText: "The new device shows a sign-in code and a device code. Type the sign-in code first.",
    text: "Type the code the new device is showing. This stops Nexus's server slipping in a device of its own.",
    nothingSent: "Nothing is sent to the new device until the code is right.",
    wrongCode: "That is not the code on the new device, so nothing was sent. Read it again from its screen. If it keeps failing, cancel and start again on the new device.",
  },
  approved: {
    title: "approved",
    line: "Now go to the new device.",
    text: "It will ask you to type this matching code before it opens your notes.",
    matching: "Matching code",
    warning: "If the new device does not accept it, do not use that device. Approve it again from here.",
  },
  matching: {
    title: "matching code",
    line: "Your other device approved this one.",
    text: "It is showing a matching code. Type it here to open your notes.",
    why: "This makes sure the key you were sent is the one your other device sealed.",
    wrong: "That code does not match.",
    stays: "This device stays locked",
    staysText: "A wrong code can mean a typing slip, or that the key was swapped on its way. Try once more. If it still fails, cancel and approve this device again from your other device.",
  },
  unlocked: {
    title: "unlocked",
    line: "Your notes are opening.",
    text: "This device is unlocked. The first sync starts when you close this.",
  },
  locked: {
    title: "locked",
    line: "Signed in, no key yet.",
    text: "This device is signed in to Nexus but does not have your key. Type your Recovery Key, or approve this device from another one.",
    recoveryKey: "Recovery key",
    password: "Use my password instead",
    wrong: "That Recovery Key is not right. The last group checks the rest, so look at it first, then read the others again.",
    typePassword: "Type the password you set up for this vault.",
    enter: "Press Enter to unlock.",
    recoveryInstead: "Use my Recovery Key instead",
  },
  ranOut: {
    title: "wait ran out",
    line: "No approval in 10 minutes.",
    text: "Nobody approved this device in time, or the answer got lost. An approval works once, so start again.",
    small: "You get a new device code. Or skip the other device and unlock with your Recovery Key.",
    recoveryKey: "Use Recovery Key",
    again: "Start again",
  },
  notAllowed: {
    title: "not allowed",
    line: "This device cannot approve.",
    text: "Nexus says the account this device is signed in as cannot approve new devices. Only the owner's devices can.",
    small: "Nothing was sent to the new device. Approve it from one of the owner's own devices instead.",
    close: "Close",
  },
  // Not drawn: the steps that have no screen of their own, in the same look.
  working: { title: "working", line: "One moment.", looking: "Asking Nexus what it holds.", signIn: "Asking Nexus to sign this device in.", saving: "Keeping your wraps on Nexus.", opening: "Opening your notes.", approving: "Approving the device." },
  signedOut: {
    title: "sign in",
    line: "Not signed in yet.",
    text: "Sign in to Nexus from the Nexus settings first, then open this again. Or ask another device that is signed in to approve this one.",
    ask: "Ask another device",
  },
  stopped: { title: "stopped", line: "Nothing was kept.", again: "Try again" },
  saveFailed: { title: "not saved", line: "Nothing is unlocked yet.", again: "Try again" },
  cancel: "Cancel",
  back: "Back",
  continue: "Continue",
  done_: "Done",
  close: "Close",
} as const;

/** The ids of the code fields, which tell their boxes apart. */
const FIELD = { typeBack: "type-back", signIn: "sign-in", device: "device", matching: "matching", key: "recovery-key" } as const;
/** The ids of the other things the caret is put back in after a screen draws itself anew. */
const KEY = { password: "password", again: "again", unlockPassword: "unlock-password" } as const;

type Phase = "start" | "key" | "check";

const once = (box: Edit): number => box.focus;

export class SetupScreens {
  /** The element the screens are drawn into: its one child is the screen. */
  readonly element: HTMLElement = el("div", { class: "nexus-screen" });
  readonly #deps: ScreenDeps;
  readonly #stop: () => void;

  // What the key screens keep.
  #phase: Phase = "start";
  #saved = false;
  #copied = false;
  #stopCopied: (() => void) | null = null;
  readonly #typeBack = new CodeEntry(Array(3 * GROUP_SIZE).fill(1));
  /** The rows (0 to 2) of the three groups that are drawn red. */
  #wrongRows = new Set<number>();
  // The password step.
  #passwordOn = false;
  #password = "";
  #again = "";
  // Approving a device.
  readonly #signIn = new CodeEntry(Array(SIGN_IN_BOXES).fill(1));
  readonly #deviceCode = new CodeEntry(Array(CODE_BOXES).fill(1));
  // A new device typing the matching code.
  readonly #matching = new CodeEntry(Array(CODE_BOXES).fill(1));
  // Unlocking with the Recovery Key, or the password.
  readonly #recoveryKey = new CodeEntry(Array(KEY_GROUPS).fill(GROUP_SIZE));
  #wrongKeyBoxes = new Set<number>();
  #usePassword = false;
  #unlockPassword = "";

  /** The step the controller was at the last time it was at one that is not "working", to tell a step that goes on from a new one. */
  #lastStable: SetupState["step"] | null = null;
  #active = false;
  #keepOpen = false;
  #pendingFocus: string | null = null;

  constructor(deps: ScreenDeps) {
    this.#deps = deps;
    this.#stop = deps.setup.onChange(() => this.#changed());
  }

  /** Starts what the screen was opened for, and draws it. */
  async start(entry: Entry): Promise<void> {
    this.#active = true;
    this.#lastStable = null;
    if (entry === "approve") this.#deps.setup.startApprovingDevice();
    else await this.#deps.setup.begin();
    this.#changed();
  }

  /** The screen is closed: nothing that was going on goes on, and what the screen kept is forgotten. */
  dispose(): void {
    this.#stop();
    this.#stopCopied?.();
    this.#deps.setup.cancel();
    this.#typeBack.clear();
    this.#signIn.clear();
    this.#deviceCode.clear();
    this.#matching.clear();
    this.#recoveryKey.clear();
    this.#password = this.#again = this.#unlockPassword = "";
    this.element.replaceChildren();
  }

  // ── what changed ──────────────────────────────────────────────────────────────

  /** The controller moved to another state (or the screen was just opened). */
  #changed(): void {
    const state = this.#deps.setup.state;
    if (state.step === "locked" || state.step === "unlocked") {
      // Nothing is going on any more: the screen has done what it was opened for.
      this.#lastStable = null;
      if (this.#active && !this.#keepOpen) this.#deps.close();
      return;
    }
    if (state.step !== "working") this.#enter(state);
    this.#render();
  }

  /** A state of the controller arrived: a step that is new starts the entries it uses empty, and a refusal marks what was typed. */
  #enter(state: SetupState): void {
    const before = this.#lastStable;
    const isNew = state.step !== before;
    this.#lastStable = state.step;
    switch (state.step) {
      case "no-vault":
        this.#phase = "start";
        break;
      case "show-key":
        if (isNew) {
          this.#phase = "key";
          this.#wrongRows = new Set();
          if (before === "choose-password") {
            // Back from the password step: the same key, as it was left, and what was typed for the password is forgotten.
            this.#passwordOn = false;
            this.#password = this.#again = "";
          } else {
            this.#saved = false;
            this.#typeBack.clear();
          }
        }
        if (state.wrong.length > 0) {
          this.#wrongRows = new Set(state.wrong.map((group) => state.ask.indexOf(group)));
        }
        break;
      case "approve-device":
        if (isNew) {
          this.#signIn.clear();
          this.#deviceCode.clear();
        }
        if (state.device === null && state.problem !== null && state.problem !== "not-allowed") this.#signIn.wrong = true;
        if (state.problem === "wrong-key-code") this.#deviceCode.wrong = true;
        break;
      case "type-matching-code":
        if (isNew) this.#matching.clear();
        if (state.message !== null) this.#matching.wrong = true;
        break;
      case "has-vault":
        if (isNew) {
          this.#recoveryKey.clear();
          this.#usePassword = false;
          this.#unlockPassword = "";
        }
        this.#wrongKeyBoxes = state.problem === "incomplete" ? new Set([KEY_GROUPS - 1]) : new Set();
        break;
      default:
        break;
    }
  }

  // ── drawing ───────────────────────────────────────────────────────────────────

  /** Draws the screen anew and puts the caret back where it was (or where an edit sent it). */
  #render(): void {
    const focused = this.element.ownerDocument.activeElement;
    const key = this.#pendingFocus ?? (focused instanceof HTMLElement && this.element.contains(focused) ? focused.getAttribute("data-key") : null);
    const selection = focused instanceof HTMLInputElement && this.#pendingFocus === null ? [focused.selectionStart, focused.selectionEnd] : null;
    this.#pendingFocus = null;
    this.element.replaceChildren(this.#screen(this.#deps.setup.state));
    if (key === null) {
      // A screen with a code to type has the caret in its first empty box.
      this.element.querySelector<HTMLInputElement>("input.nx-box__input[value='']")?.focus();
      return;
    }
    const target = [...this.element.querySelectorAll<HTMLElement>("[data-key]")].find((candidate) => candidate.getAttribute("data-key") === key);
    if (!target) return;
    target.focus();
    if (selection && target instanceof HTMLInputElement && selection[0] !== null && selection[1] !== null) target.setSelectionRange(selection[0], selection[1]);
  }

  /** A code field's edit: draw anew with the caret where the edit sent it. The entry is checked when it is whole. */
  #edited(id: string, check: (() => void) | null): (edit: Edit) => void {
    return (edit) => {
      this.#pendingFocus = boxKey(id, once(edit));
      this.#render();
      if (edit.complete && check) check();
    };
  }

  #screen(state: SetupState): HTMLElement {
    switch (state.step) {
      case "no-vault":
        return this.#startScreen();
      case "show-key":
        return this.#phase === "start" ? this.#startScreen() : this.#phase === "key" ? this.#keyScreen(state.recoveryKey) : this.#checkScreen(state);
      case "choose-password":
        return this.#passwordScreen(state.message);
      case "set-up":
        return this.#doneScreen(state);
      case "waiting-for-device":
        return this.#waitingScreen(state);
      case "type-matching-code":
        return this.#matchingScreen(state);
      case "device-unlocked":
        return this.#unlockedScreen();
      case "approve-device":
        return state.problem === "not-allowed" ? this.#notAllowedScreen() : state.device === null ? this.#signInCodeScreen(state.message) : this.#deviceCodeScreen(state);
      case "device-approved":
        return this.#approvedScreen(state);
      case "has-vault":
        return this.#usePassword && state.hasPassword ? this.#passwordUnlockScreen(state) : this.#lockedScreen(state);
      case "stopped":
        return state.reason === "expired" ? this.#ranOutScreen() : this.#stoppedScreen(state.message);
      case "signed-out":
        return this.#signedOutScreen();
      case "save-failed":
        return this.#saveFailedScreen(state.message);
      case "working":
        return this.#workingScreen(state.doing);
      default:
        return this.#notDrawnScreen();
    }
  }

  // ── the screens ───────────────────────────────────────────────────────────────

  #startScreen(): HTMLElement {
    const w = WORDS.start;
    const setup = this.#deps.setup;
    return screen(
      w.title,
      w.line,
      card(
        text(w.promise),
        note(w.auditHead, w.audit),
        small(w.next),
        actions(
          pill(WORDS.cancel, "quiet", () => setup.cancel(), { key: "cancel" }),
          pill(WORDS.continue, "main", () => {
            if (setup.state.step === "no-vault") this.#run(setup.startFirstRun());
            else {
              this.#phase = "key";
              this.#render();
            }
          }, { key: "continue" }),
        ),
      ),
    );
  }

  #keyScreen(recoveryKey: string): HTMLElement {
    const w = WORDS.key;
    const groups = recoveryKey.split("-");
    const rows: HTMLElement[] = [];
    for (let first = 0; first < groups.length; first += 4) {
      const row = groups.slice(first, first + 4).map((group) => el("div", { class: "nx-key-group" }, group));
      while (row.length < 4) row.push(el("div", { class: "nx-key-spacer" }));
      rows.push(el("div", { class: "nx-panel__row" }, ...row));
    }
    return screen(
      w.title,
      w.line,
      card(
        text(w.once),
        el("div", { class: "nx-panel" }, ...rows),
        pill(this.#copied ? w.copied : w.copy, "quiet", () => this.#copyKey(recoveryKey), { start: true, key: "copy" }),
        small(w.cannot),
        el(
          "div",
          { class: "nx-tick-row" },
          el(
            "button",
            {
              type: "button",
              class: "nx-tick",
              role: "checkbox",
              "aria-checked": this.#saved ? "true" : "false",
              "aria-label": w.saved,
              "data-key": "saved",
              on: {
                click: () => {
                  this.#saved = !this.#saved;
                  this.#render();
                },
              },
            },
            this.#saved ? tickMark() : null,
          ),
          el("p", { class: "nx-tick-row__words" }, w.saved),
        ),
        actions(
          pill(WORDS.back, "quiet", () => this.#goTo("start"), { key: "back" }),
          pill(WORDS.continue, "main", () => this.#goTo("check"), { dim: !this.#saved, key: "continue" }),
        ),
      ),
    );
  }

  #checkScreen(state: Extract<SetupState, { step: "show-key" }>): HTMLElement {
    const w = WORDS.check;
    const wrong = [...this.#wrongRows].map((row) => state.ask[row]!).sort((a, b) => a - b);
    return screen(
      w.title,
      w.line,
      card(
        text(w.ask),
        groupRows(
          { id: FIELD.typeBack, name: "Group of the Recovery Key", entry: this.#typeBack, onEdit: (edit, box) => this.#typedBack(edit, box) },
          state.ask.map(w.group),
          this.#wrongRows,
        ),
        wrong.length === 0 ? small(w.how) : faultLine(wrong.length === 1 ? w.one(wrong[0]!) : w.several(wrong)),
        actions(pill(WORDS.back, "quiet", () => this.#goTo("key"), { key: "back" })),
      ),
    );
  }

  /** A box of the three groups was edited: its row loses its red, the caret goes on, and the twelve characters are checked when they are all in. */
  #typedBack(edit: Edit, box: number): void {
    this.#wrongRows.delete(Math.floor(box / GROUP_SIZE));
    this.#edited(FIELD.typeBack, this.#typeBack.complete ? () => this.#deps.setup.typeBack(this.#typeBack.text) : null)(edit);
  }

  #passwordScreen(message: string | null): HTMLElement {
    const w = WORDS.password;
    const ready = !this.#passwordOn || (this.#password !== "" && passwordsAgree(this.#password, this.#again));
    const inputs = this.#passwordOn
      ? [
          el("div", { class: "nx-field" }, label(w.password), this.#passwordInput(KEY.password, "new-password", this.#password, "", (value) => (this.#password = value))),
          el("div", { class: "nx-field" }, label(w.again), this.#passwordInput(KEY.again, "new-password", this.#again, w.sameAsAbove, (value) => (this.#again = value))),
        ]
      : [];
    return screen(
      w.title,
      w.line,
      card(
        text(w.optional),
        el(
          "div",
          { class: "nx-switch-row" },
          el("div", { class: "nx-switch-row__words" }, el("p", { class: "nx-switch-row__name" }, w.switchName), small(this.#passwordOn ? w.on : w.off)),
          el(
            "button",
            {
              type: "button",
              class: "nx-switch",
              role: "switch",
              "aria-checked": this.#passwordOn ? "true" : "false",
              "aria-label": w.switchName,
              "data-key": "switch",
              on: { click: () => this.#switchPassword() },
            },
            el("span", { class: "nx-switch__knob" }),
          ),
        ),
        ...inputs,
        message === null ? null : faultLine(message),
        note(this.#passwordOn ? w.pickLong : w.readFirst, w.warning),
        actions(
          pill(WORDS.back, "quiet", () => this.#deps.setup.backToKey(), { key: "back" }),
          pill(w.finish, "main", () => this.#run(this.#deps.setup.finishSetup(this.#passwordOn ? { password: this.#password, again: this.#again } : null)), { dim: !ready, key: "finish" }),
        ),
      ),
    );
  }

  #passwordInput(key: string, autocomplete: string, value: string, placeholder: string, keep: (value: string) => void): HTMLInputElement {
    return el("input", {
      type: "password",
      class: "nx-input",
      value,
      placeholder: placeholder === "" ? undefined : placeholder,
      autocomplete,
      "aria-label": placeholder === "" ? WORDS.password.password : WORDS.password.again,
      "data-key": key,
      on: {
        input: (event) => {
          keep((event.target as HTMLInputElement).value);
          this.#render();
        },
      },
    });
  }

  #switchPassword(): void {
    this.#passwordOn = !this.#passwordOn;
    // Turning it back off closes the two boxes and forgets what was typed.
    if (!this.#passwordOn) this.#password = this.#again = "";
    else this.#pendingFocus = KEY.password;
    this.#render();
  }

  #doneScreen(state: Extract<SetupState, { step: "set-up" }>): HTMLElement {
    const w = WORDS.done;
    const row = (name: string, value: string) => el("div", { class: "nx-panel__row" }, el("span", { class: "nx-summary-name" }, name), el("span", { class: "nx-summary-value" }, value));
    return screen(
      w.title,
      w.line,
      card(
        doneCircle(),
        text(w.text),
        state.message === null ? null : faultLine(state.message),
        el("div", { class: "nx-panel" }, row(w.recoveryKey, w.savedByYou), row(w.password, state.password ? w.on : w.off), row(w.audit, w.notYetAudited)),
        actions(pill(WORDS.done_, "main", () => this.#deps.setup.done(), { key: "done" })),
      ),
    );
  }

  #waitingScreen(state: Extract<SetupState, { step: "waiting-for-device" }>): HTMLElement {
    const w = WORDS.waiting;
    return screen(
      w.title,
      w.line,
      card(
        text(w.text),
        readCode(w.signInCode, codeCharacters(state.code)),
        readCode(w.deviceCode, codeCharacters(state.keyCode)),
        el("div", { class: "nx-status" }, el("span", { class: "nx-status__dot" }), small(w.status)),
        actions(pill(WORDS.cancel, "quiet", () => this.#cancelThenLook(), { key: "cancel" })),
      ),
    );
  }

  #signInCodeScreen(message: string | null): HTMLElement {
    const w = WORDS.approve;
    return screen(
      w.title,
      w.signInLine,
      card(
        text(w.signInText),
        codeField(
          { id: FIELD.signIn, name: WORDS.waiting.signInCode, entry: this.#signIn, onEdit: (edit) => this.#edited(FIELD.signIn, this.#signIn.complete ? () => this.#run(this.#deps.setup.lookUpDevice(this.#signIn.text)) : null)(edit) },
          WORDS.waiting.signInCode,
        ),
        message !== null && this.#signIn.wrong ? faultLine(message) : small(w.nothingSent),
        actions(pill(WORDS.cancel, "quiet", () => this.#deps.setup.cancel(), { key: "cancel" })),
      ),
    );
  }

  #deviceCodeScreen(state: Extract<SetupState, { step: "approve-device" }>): HTMLElement {
    const w = WORDS.approve;
    const device = state.device!;
    return screen(
      w.title,
      device.label,
      card(
        text(w.text),
        codeField(
          {
            id: FIELD.device,
            name: WORDS.waiting.deviceCode,
            entry: this.#deviceCode,
            onEdit: (edit) => this.#edited(FIELD.device, this.#deviceCode.complete ? () => this.#run(this.#deps.setup.approveDevice(device.signInCode, this.#deviceCode.text)) : null)(edit),
          },
          WORDS.waiting.deviceCode,
        ),
        this.#deviceCode.wrong ? faultLine(state.problem === "wrong-key-code" ? w.wrongCode : (state.message ?? w.wrongCode)) : small(w.nothingSent),
        actions(pill(WORDS.cancel, "quiet", () => this.#deps.setup.cancel(), { key: "cancel" })),
      ),
    );
  }

  #approvedScreen(state: Extract<SetupState, { step: "device-approved" }>): HTMLElement {
    const w = WORDS.approved;
    return screen(
      w.title,
      w.line,
      card(text(w.text), readCode(w.matching, codeCharacters(state.code)), small(w.warning), actions(pill(WORDS.done_, "main", () => this.#deps.setup.done(), { key: "done" }))),
    );
  }

  #matchingScreen(state: Extract<SetupState, { step: "type-matching-code" }>): HTMLElement {
    const w = WORDS.matching;
    const wrong = this.#matching.wrong;
    return screen(
      w.title,
      w.line,
      card(
        text(wrong ? w.wrong : w.text),
        codeField(
          {
            id: FIELD.matching,
            name: w.title,
            entry: this.#matching,
            onEdit: (edit) => this.#edited(FIELD.matching, this.#matching.complete ? () => this.#run(this.#deps.setup.typeMatchingCode(this.#matching.text)) : null)(edit),
          },
          WORDS.approved.matching,
        ),
        wrong ? note(w.stays, w.staysText, true) : small(w.why),
        actions(pill(WORDS.cancel, "quiet", () => this.#cancelThenLook(), { key: "cancel" })),
      ),
    );
    // `state` is not read: the controller's counter of tries is not shown, as drawn.
    void state;
  }

  #unlockedScreen(): HTMLElement {
    const w = WORDS.unlocked;
    return screen(w.title, w.line, card(doneCircle(), text(w.text), actions(pill(WORDS.done_, "main", () => this.#deps.setup.done(), { key: "done" }))));
  }

  #lockedScreen(state: Extract<SetupState, { step: "has-vault" }>): HTMLElement {
    const w = WORDS.locked;
    const refusal = state.problem === null ? null : state.problem === "incomplete" ? w.wrong : state.message;
    return screen(
      w.title,
      w.line,
      card(
        text(w.text),
        keyField(
          {
            id: FIELD.key,
            name: w.recoveryKey,
            entry: this.#recoveryKey,
            onEdit: (edit, box) => {
              this.#wrongKeyBoxes = new Set();
              this.#edited(FIELD.key, this.#recoveryKey.complete ? () => this.#run(this.#deps.setup.typeRecoveryKey(this.#recoveryKey.text)) : null)(edit);
              void box;
            },
          },
          w.recoveryKey,
          this.#wrongKeyBoxes,
        ),
        refusal === null || (state.problem === "incomplete" && this.#wrongKeyBoxes.size === 0) ? null : faultLine(refusal),
        state.hasPassword
          ? link(w.password, () => {
              this.#usePassword = true;
              this.#pendingFocus = KEY.unlockPassword;
              this.#render();
            }, "use-password")
          : null,
        actions(pill(WORDS.cancel, "quiet", () => this.#deps.setup.cancel(), { key: "cancel" })),
      ),
    );
  }

  #passwordUnlockScreen(state: Extract<SetupState, { step: "has-vault" }>): HTMLElement {
    const w = WORDS.locked;
    return screen(
      w.title,
      w.line,
      card(
        text(w.typePassword),
        el(
          "div",
          { class: "nx-field" },
          label(WORDS.password.password),
          el("input", {
            type: "password",
            class: "nx-input",
            value: this.#unlockPassword,
            autocomplete: "current-password",
            "aria-label": WORDS.password.password,
            "data-key": KEY.unlockPassword,
            on: {
              input: (event) => (this.#unlockPassword = (event.target as HTMLInputElement).value),
              keydown: (event) => {
                if ((event as KeyboardEvent).key === "Enter") this.#run(this.#deps.setup.typePassword(this.#unlockPassword));
              },
            },
          }),
        ),
        state.problem === null ? small(w.enter) : faultLine(state.message ?? w.enter),
        link(w.recoveryInstead, () => {
          this.#usePassword = false;
          this.#unlockPassword = "";
          this.#render();
        }, "use-recovery-key"),
        actions(pill(WORDS.cancel, "quiet", () => this.#deps.setup.cancel(), { key: "cancel" })),
      ),
    );
  }

  #ranOutScreen(): HTMLElement {
    const w = WORDS.ranOut;
    return screen(
      w.title,
      w.line,
      card(
        clockCircle(),
        text(w.text),
        small(w.small),
        actions(
          pill(w.recoveryKey, "quiet", () => this.#run(this.#deps.setup.begin()), { key: "recovery-key" }),
          pill(w.again, "main", () => this.#run(this.#deps.setup.askAnotherDevice()), { key: "again" }),
        ),
      ),
    );
  }

  #notAllowedScreen(): HTMLElement {
    const w = WORDS.notAllowed;
    return screen(w.title, w.line, card(crossCircle(), text(w.text), small(w.small), actions(pill(w.close, "main", () => this.#deps.setup.done(), { key: "close" }))));
  }

  // The steps with no drawing of their own.

  #workingScreen(doing: Extract<SetupState, { step: "working" }>["doing"]): HTMLElement {
    const w = WORDS.working;
    const words = doing === "looking" ? w.looking : doing === "starting-sign-in" ? w.signIn : doing === "saving" ? w.saving : doing === "opening" ? w.opening : w.approving;
    return screen(w.title, w.line, card(small(words)));
  }

  #signedOutScreen(): HTMLElement {
    const w = WORDS.signedOut;
    return screen(
      w.title,
      w.line,
      card(
        text(w.text),
        actions(
          pill(WORDS.close, "quiet", () => this.#deps.setup.cancel(), { key: "close" }),
          pill(w.ask, "main", () => this.#run(this.#deps.setup.askAnotherDevice()), { key: "ask" }),
        ),
      ),
    );
  }

  #stoppedScreen(message: string): HTMLElement {
    const w = WORDS.stopped;
    return screen(
      w.title,
      w.line,
      card(
        text(message),
        actions(pill(WORDS.close, "quiet", () => this.#deps.setup.cancel(), { key: "close" }), pill(w.again, "main", () => this.#run(this.#deps.setup.begin()), { key: "again" })),
      ),
    );
  }

  #saveFailedScreen(message: string): HTMLElement {
    const w = WORDS.saveFailed;
    return screen(
      w.title,
      w.line,
      card(text(message), actions(pill(WORDS.cancel, "quiet", () => this.#deps.setup.cancel(), { key: "cancel" }), pill(w.again, "main", () => this.#run(this.#deps.setup.tryAgain()), { key: "again" }))),
    );
  }

  #notDrawnScreen(): HTMLElement {
    return screen(WORDS.stopped.title, WORDS.stopped.line, card(actions(pill(WORDS.close, "main", () => this.#deps.setup.done(), { key: "close" }))));
  }

  // ── what the buttons do ───────────────────────────────────────────────────────

  #goTo(phase: Phase): void {
    this.#phase = phase;
    this.#render();
  }

  /** Copy key: the whole key on the clipboard as one string, a space between groups, and the button says Copied for two seconds. */
  #copyKey(recoveryKey: string): void {
    this.#run(
      this.#deps.copy(recoveryKey.split("-").join(" ")).then(() => {
        this.#copied = true;
        this.#stopCopied?.();
        this.#stopCopied = this.#deps.later(COPIED_FOR_MS, () => {
          this.#copied = false;
          this.#stopCopied = null;
          this.#render();
        });
        this.#render();
      }),
    );
  }

  /** Cancel on a device that was waiting or typing: the wait is over, and the device is looked at again (signed in but locked, or signed out). */
  #cancelThenLook(): void {
    this.#keepOpen = true;
    try {
      this.#deps.setup.cancel();
      this.#run(this.#deps.setup.begin());
    } finally {
      this.#keepOpen = false;
    }
  }

  /** Runs what a button started: a failure is shown in the console and nowhere else, as nothing of it is the person's to act on. */
  #run(work: Promise<void>): void {
    work.catch((error: unknown) => console.error("Nexus plugin: a setup step failed:", error));
  }
}
