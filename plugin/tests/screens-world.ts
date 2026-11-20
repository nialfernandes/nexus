// What the screen tests share: a stand-in for the setup controller that shows whatever state it is told to and writes down every event the
// screens send it (the screens only draw a state and send events, so that is the whole of what can be asked of them), and the person's
// hands: typing into a code box, pasting into one, and tapping a button, all as the events a browser sends.
//
// The stand-in is only for the tests of the screens themselves. The tests that put the screens over the real controller and the real
// server code are screens-worked-example.test.ts.

import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import path from "node:path";
import { expect } from "vitest";
import { SetupScreens, type ScreenDeps } from "../src/screens/setup-screens";
import type { SetupState, VaultSetup } from "../src/vault-setup";

/**
 * A page for a test that has to run in Node (the ones that use the real server code, which needs `node:sqlite`): the globals a screen
 * and the helpers below use are taken from a happy-dom window, and put back by what this answers. The tests that need no Node module have
 * the same page from vitest itself (`@vitest-environment happy-dom`).
 */
export function installDom(): () => void {
  const window = new Window({ url: "http://localhost/" });
  const names = ["document", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "Event", "KeyboardEvent", "MouseEvent"] as const;
  const globals = globalThis as unknown as Record<string, unknown>;
  const before = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of names) Object.defineProperty(globalThis, name, { value: (window as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  return () => {
    for (const [name, descriptor] of before) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globals[name];
    }
    void window.happyDOM.close();
  };
}

/** Every event name the screens may send the controller. */
const EVENTS = [
  "begin", "startFirstRun", "typeBack", "backToKey", "finishSetup", "tryAgain", "typeRecoveryKey", "typePassword", "askAnotherDevice",
  "typeMatchingCode", "refuseCode", "startApprovingDevice", "chooseDevice", "backToDevices", "approveDevice", "startApprovingAgent", "approveAgent", "done", "cancel", "lock",
] as const;
type EventName = (typeof EVENTS)[number];

/** The setup controller as far as a screen can see it. */
export class FakeSetup {
  state: SetupState;
  /** Every event the screens sent, in order, with what it was sent with. */
  readonly calls: Array<[EventName, ...unknown[]]> = [];
  readonly #listeners = new Set<() => void>();

  constructor(state: SetupState) {
    this.state = state;
    for (const name of EVENTS) {
      (this as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        this.calls.push([name, ...args]);
        return name === "typeBack" || name === "backToKey" || name === "done" || name === "cancel" || name === "chooseDevice" || name === "backToDevices" || name === "lock" || name === "refuseCode" ? undefined : Promise.resolve();
      };
    }
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** The controller moves to `state`: the screens are told. */
  show(state: SetupState): void {
    this.state = state;
    for (const listener of [...this.#listeners]) listener();
  }

  /** The events sent with this name, each as its arguments. */
  sent(name: EventName): unknown[][] {
    return this.calls.filter(([called]) => called === name).map(([, ...args]) => args);
  }
}

export interface OpenScreens {
  screens: SetupScreens;
  setup: FakeSetup;
  /** The element the screens are drawn into. */
  root: HTMLElement;
  /** What was put on the clipboard. */
  copied: string[];
  /** The timers the screens asked for: run one with `ticks[i]()`. */
  timers: Array<{ ms: number; run: () => void; stopped: boolean }>;
  closed: () => number;
  /** What opening the screens sent the controller, before the person did anything. */
  opening: Array<[string, ...unknown[]]>;
}

/** Opens the screens over a stand-in controller that is at `state`. */
export async function openScreens(state: SetupState, entry: "unlock" | "approve" = "unlock"): Promise<OpenScreens> {
  const setup = new FakeSetup(state);
  const copied: string[] = [];
  const timers: OpenScreens["timers"] = [];
  let closes = 0;
  const deps: ScreenDeps = {
    setup: setup as unknown as VaultSetup,
    copy: async (words) => void copied.push(words),
    later: (ms, run) => {
      const timer = { ms, run, stopped: false };
      timers.push(timer);
      return () => void (timer.stopped = true);
    },
    close: () => void closes++,
  };
  const screens = new SetupScreens(deps);
  document.body.append(screens.element);
  await screens.start(entry);
  const opening = setup.calls.splice(0); // what opening it sent is not what the person did
  return { screens, setup, root: screens.element, copied, timers, closed: () => closes, opening };
}

// ── the person's hands ───────────────────────────────────────────────────────────

/** The input of box `index` in the field `id`. */
export function box(root: HTMLElement, id: string, index: number): HTMLInputElement {
  const found = root.querySelector<HTMLInputElement>(`[data-key="${id}:${index}"]`);
  if (!found) throw new Error(`there is no box ${index} in the field ${id}; the screen has ${[...root.querySelectorAll("[data-key]")].map((e) => e.getAttribute("data-key")).join(", ")}`);
  return found;
}

/** Every box of the field `id`, in order. */
export const boxes = (root: HTMLElement, id: string): HTMLInputElement[] => [...root.querySelectorAll<HTMLInputElement>(`input[data-key^="${id}:"]`)];

/** The characters in the boxes of the field `id`, box after box. */
export const typed = (root: HTMLElement, id: string): string => boxes(root, id).map((input) => input.value).join("");

/** Types `characters` into the field `id` one at a time, each into the box that has the caret: the first box, then wherever the screen sent it. */
export function typeInto(root: HTMLElement, id: string, characters: string, from = 0): void {
  let index = from;
  for (const character of characters) {
    const input = box(root, id, index);
    input.value += character; // typed at the end of what the box holds, as a keyboard does
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const focused = document.activeElement?.getAttribute("data-key") ?? `${id}:${index}`;
    index = Number(focused.split(":")[1]);
  }
}

/** The box's field now says `value`, as it does after the person deletes a character or types over one. */
export function setBox(root: HTMLElement, id: string, index: number, value: string): void {
  const input = box(root, id, index);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Pastes `words` into box `index` of the field `id`. */
export function pasteInto(root: HTMLElement, id: string, index: number, words: string): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => words } });
  box(root, id, index).dispatchEvent(event);
}

/** Presses Backspace in box `index` of the field `id`. */
export function backspaceIn(root: HTMLElement, id: string, index: number): void {
  box(root, id, index).dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
}

/** The button or link with this key. */
export function control(root: HTMLElement, key: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>("[data-key]")].find((candidate) => candidate.getAttribute("data-key") === key);
  if (!found) throw new Error(`the screen has no control called ${key}; it has ${[...root.querySelectorAll("[data-key]")].map((e) => e.getAttribute("data-key")).join(", ")}`);
  return found;
}

/** Taps the control with this key. */
export function tap(root: HTMLElement, key: string): void {
  control(root, key).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

/** Types `words` into a text input with this key, as the person types in a password box. */
export function typeText(root: HTMLElement, key: string, words: string): void {
  const input = control(root, key) as HTMLInputElement;
  input.value = words;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Presses a key in the control with this key. */
export function press(root: HTMLElement, key: string, name: string): void {
  control(root, key).dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

// ── what is on the screen ────────────────────────────────────────────────────────

/** The words on the screen, in the order they are read: each piece of text on its own, and the value of each input that holds one. */
export function words(root: HTMLElement): string[] {
  const found: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const piece = (node.textContent ?? "").trim();
      if (piece !== "") found.push(piece);
      return;
    }
    if (node instanceof HTMLInputElement && node.type !== "password" && node.value !== "") found.push(node.value);
    for (const child of [...node.childNodes]) walk(child);
  };
  walk(root);
  return found;
}

/** The button labels on the screen, in order. */
export const buttons = (root: HTMLElement): string[] => [...root.querySelectorAll("button.nx-pill")].map((button) => (button.textContent ?? "").trim());

/** True when this button is dim: it ignores taps. */
export const isDim = (root: HTMLElement, key: string): boolean => control(root, key).getAttribute("aria-disabled") === "true";

/** The stylesheet the screens are drawn with, as the build copies it. */
export const STYLES = readFileSync(path.join(process.cwd(), "styles.css"), "utf8");

/** Fails with the screen's words when `step` is not what the screen says it is for: the title and the line under it. */
export function expectSlab(root: HTMLElement, title: string, line: string): void {
  expect(root.querySelector(".nx-slab__title")?.textContent).toBe(title);
  expect(root.querySelector(".nx-slab__line")?.textContent).toBe(line);
}
