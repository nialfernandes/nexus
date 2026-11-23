// @vitest-environment happy-dom
//
// Boards 31 and 31a, the owner giving an agent that joined the key, drawn over a stand-in for the setup controller (screens-world.ts) at
// the state those boards are for: the words on the screen in the order they are read, the boxes and which of them are red, the buttons,
// and what typing, pasting and tapping send the controller. This is each board compared with its drawing, element by element; the
// drawing is not in this repository, so what it says is written out here. The agent's name and every code are made up for the test.
//
// Board 31: slab "give the key", the line "<name> has joined.", a card with "Type <name>'s code here to give it the key.", AGENT CODE in
// ten boxes grouped 4, 4, 2 (44 px high, radius 8, the box being typed in outlined in teal with an ink caret), "This makes sure the key goes
// to <name> and no one else." and the quiet Cancel pill at the right. There is no Give button: the tenth character, or the whole code
// pasted, is checked. Board 31a: every box red (fill #FDECEE, 2 px outline #D1293D), "That code does not match.", and a red box headed
// "<name> does not get the key" that says what it could mean and what to do. Nothing is handed over; typing again is allowed with no
// counter and no lock-out, so after a second wrong try the same screen stays.
//
// Set PICTURES_DIR to a folder and the test also writes each board out there as a page (the screen and styles.css), for looking at.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SetupState } from "../src/vault-setup";
import { STYLES, boxes, buttons, control, openScreens, pasteInto, tap, typeInto, words } from "./screens-world";

const LEDGER = { label: "ledger", signInCode: "QWER-TY23", name: "ledger", agent: true } as const;
const asking = (problem: Extract<SetupState, { step: "approve-device" }>["problem"], message: string | null = null): SetupState => ({
  step: "approve-device", message, problem, devices: [LEDGER], device: LEDGER,
});
const CODE = "AB12CD34EF";
/** Writes the screen out as a page for looking at, when PICTURES_DIR is set. */
function picture(name: string, root: HTMLElement): void {
  const folder = process.env.PICTURES_DIR;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `${name}.html`), `<!doctype html><meta charset="utf-8"><style>body{margin:0}${STYLES}</style><div class="nexus-screen" style="width:375px">${root.innerHTML}</div>`);
}
const wrongBoxes = (root: HTMLElement): number => root.querySelectorAll(".nx-box--wrong").length;
const shape = (root: HTMLElement): number[] => [...root.querySelectorAll(".nx-code__group")].map((group) => group.querySelectorAll(".nx-box").length);

describe("board 31: give the key", () => {
  it("names the agent that joined, asks for its agent code in ten empty boxes grouped 4, 4, 2, says why, and has Cancel only", async () => {
    const { root } = await openScreens(asking(null), "approve");
    picture("board-31", root);
    expect(words(root)).toEqual([
      "nexus",
      "give the key",
      "ledger has joined.",
      "Type ledger's code here to give it the key.",
      "Agent code",
      "This makes sure the key goes to ledger and no one else.",
      "Cancel",
    ]);
    expect(root.querySelector(".nx-slab__title")?.textContent).toBe("give the key");
    expect(boxes(root, "device")).toHaveLength(10);
    expect(shape(root)).toEqual([4, 4, 2]);
    expect(boxes(root, "device").every((input) => input.value === ""), "all empty").toBe(true);
    expect(wrongBoxes(root), "nothing is red").toBe(0);
    expect(buttons(root), "no Give button").toEqual(["Cancel"]);
    expect(control(root, "cancel").className).toContain("nx-pill--quiet");
    expect(root.querySelector(".nx-note"), "no red box until a code is wrong").toBeNull();
    expect(root.querySelector(".nx-label")?.textContent, "the box's name, drawn in capitals by the style").toBe("Agent code");
  });

  it("puts the caret in the first box, and moves it on as each character is typed", async () => {
    const { root } = await openScreens(asking(null), "approve");
    expect(document.activeElement?.getAttribute("data-key")).toBe("device:0");
    typeInto(root, "device", "AB");
    expect(document.activeElement?.getAttribute("data-key")).toBe("device:2");
  });

  it("checks the code as soon as the tenth character is typed, with capitals or small letters, and not before", async () => {
    const { root, setup } = await openScreens(asking(null), "approve");
    typeInto(root, "device", CODE.slice(0, 9).toLowerCase());
    expect(setup.sent("approveDevice"), "nine characters are not a code yet").toEqual([]);
    typeInto(root, "device", CODE[9]!.toLowerCase(), 9);
    expect(setup.sent("approveDevice"), "the tenth sends the code, as capitals").toEqual([[CODE]]);
  });

  it("checks a whole code pasted into any box, with spaces and hyphens ignored", async () => {
    const { root, setup } = await openScreens(asking(null), "approve");
    pasteInto(root, "device", 4, "ab12 cd34-ef");
    expect(setup.sent("approveDevice")).toEqual([[CODE]]);
  });

  it("closes without giving anything when Cancel is tapped", async () => {
    const { root, setup } = await openScreens(asking(null), "approve");
    tap(root, "cancel");
    expect(setup.sent("cancel")).toEqual([[]]);
    expect(setup.sent("approveDevice")).toEqual([]);
  });

  it("shows the agent's name as text, never as markup", async () => {
    const odd = { label: "x", signInCode: "AAAA-BBBB", name: "<img src=x onerror=alert(1)>", agent: true } as const;
    const { root } = await openScreens({ step: "approve-device", message: null, problem: null, devices: [odd], device: odd }, "approve");
    expect(root.querySelector("img")).toBeNull();
    expect(words(root)).toContain("<img src=x onerror=alert(1)> has joined.");
  });

  it("is not drawn for a device: the same state without `agent` is still the approve device screen", async () => {
    const phone = { label: "Obsidian on a phone", signInCode: "ABCD-EFGH" };
    const { root } = await openScreens({ step: "approve-device", message: null, problem: null, devices: [phone], device: phone }, "approve");
    expect(root.querySelector(".nx-slab__title")?.textContent).toBe("approve device");
    expect(words(root)).not.toContain("give the key");
  });
});

describe("board 31a: wrong agent code", () => {
  /** A code typed, and the controller saying it is not the agent's. */
  async function wrongOnce() {
    const open = await openScreens(asking(null), "approve");
    typeInto(open.root, "device", "AB12CD34EX");
    open.setup.show(asking("wrong-key-code", "no match"));
    return open;
  }

  it("turns all ten boxes red, keeps what was typed, says That code does not match, and the red box says what it could mean and what to do", async () => {
    const { root } = await wrongOnce();
    picture("board-31a", root);
    expect(wrongBoxes(root)).toBe(10);
    expect(words(root)).toEqual([
      "nexus",
      "give the key",
      "ledger has joined.",
      "That code does not match.",
      "Agent code",
      ..."AB12CD34EX",
      "ledger does not get the key",
      "A wrong code can mean a typing slip, or that this is not the agent you added. Try once more. If it still fails, cancel and add the agent again.",
      "Cancel",
    ]);
    expect(root.querySelector(".nx-note--fault"), "the red box").not.toBeNull();
    expect(root.querySelector(".nx-note__head")?.textContent).toBe("ledger does not get the key");
    expect(words(root), "the reason line of board 31 is replaced").not.toContain("This makes sure the key goes to ledger and no one else.");
    expect(buttons(root)).toEqual(["Cancel"]);
  });

  it("clears the red at the first edit, and a second wrong try shows the same screen again: no counter and no lock-out", async () => {
    const { root, setup } = await wrongOnce();
    typeInto(root, "device", "Y", 9); // typing over the last character
    expect(wrongBoxes(root), "the red goes at the first edit").toBe(0);
    expect(setup.sent("approveDevice")).toEqual([["AB12CD34EX"], ["AB12CD34EY"]]);
    setup.show(asking("wrong-key-code", "no match again"));
    expect(wrongBoxes(root)).toBe(10);
    expect(words(root)).toContain("That code does not match.");
    expect(words(root).join(" "), "no counter").not.toMatch(/\d+ (tries|attempts)|(tries|attempts) (left|remaining)/i);
    expect(buttons(root), "and nothing is locked").toEqual(["Cancel"]);
    expect(boxes(root, "device")).toHaveLength(10);
  });

  it("says Nexus's own words under the boxes, and not board 31a, when Nexus refused for another reason", async () => {
    const { root, setup } = await openScreens(asking(null), "approve");
    typeInto(root, "device", CODE);
    const gone = "That sign-in has run out or was answered already. Start it again on the new device.";
    setup.show(asking("gone", gone));
    expect(root.querySelector(".nx-fault-line")?.textContent).toBe(gone);
    expect(words(root)).not.toContain("That code does not match.");
    expect(root.querySelector(".nx-note--fault"), "the red box is for a wrong code only").toBeNull();
    expect(words(root)).toContain("Type ledger's code here to give it the key.");
  });
});

describe("boards 31 and 31a: the drawing's values, written out", () => {
  const token = (name: string): string => new RegExp(`${name}:\\s*([^;]+);`).exec(STYLES)![1]!.trim();

  it("uses the drawing's teal, ink, ground, red fill, red outline and red heading", () => {
    expect(token("--nx-teal")).toBe("#2FCDB8");
    expect(token("--nx-ink")).toBe("#0F1013");
    expect(token("--nx-ink-soft")).toBe("#3A3A40");
    expect(token("--nx-ground")).toBe("#EEEDEA");
    expect(token("--nx-red-fill")).toBe("#FDECEE");
    expect(token("--nx-red-line")).toBe("#D1293D");
    expect(token("--nx-red-heading")).toBe("#9B1C2E");
    expect(token("--nx-radius-box")).toBe("8px");
    expect(token("--nx-radius-card")).toBe("16px");
    expect(token("--nx-radius-panel")).toBe("10px");
  });

  it("draws a typed box 44 px high with a 1.5 px soft outline, a 2 px teal one with the caret in it, and a red one with a 2 px red outline", () => {
    const rule = (selector: string): string => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(STYLES)![1]!;
    expect(rule(".nx-box")).toMatch(/height:\s*44px/);
    expect(rule(".nx-box--edit")).toMatch(/border:\s*1\.5px solid var\(--nx-ink-14\)/);
    expect(rule(".nx-box--edit:focus-within")).toMatch(/border:\s*2px solid var\(--nx-teal\)/);
    expect(rule(".nx-box--edit:focus-within:has(.nx-box__input:placeholder-shown)::after")).toMatch(/width:\s*2px/);
    expect(rule(".nx-box--edit:focus-within:has(.nx-box__input:placeholder-shown)::after")).toMatch(/height:\s*20px/);
    expect(STYLES).toMatch(/\.nx-box--wrong,\s*\.nx-box--wrong:focus-within\s*\{[^}]*background-color:\s*var\(--nx-red-fill\);[^}]*border:\s*2px solid var\(--nx-red-line\)/);
  });
});
