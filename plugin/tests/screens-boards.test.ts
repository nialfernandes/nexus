// @vitest-environment happy-dom
//
// Every screen of setting up, adding a device and unlocking, drawn over a stand-in for the setup controller (screens-world.ts) at the state
// that screen is for: the words on it, in the order they are read, the boxes it has and which of them are red, the buttons it has and which
// of them are dim. This is the screen compared with its drawing, element by element; the drawing is not in this repository, so what it says
// is written out here. The names, codes and keys are made up for the test.
//
// Set PICTURES_DIR to a folder and the test also writes each screen out there as a page (the screen and styles.css), for looking at.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WORDS } from "../src/screens/setup-screens";
import type { SetupState } from "../src/vault-setup";
import { STYLES, box, boxes, buttons, control, isDim, openScreens, pasteInto, tap, typeInto, typeText, words, type OpenScreens } from "./screens-world";

const KEY = ["A1B2", "C3D4", "E5F6", "G7H8", "J9K1", "M2N3", "P4Q5", "R6S7", "T8V9", "W1X2", "Y3Z4", "A5B6", "C7D8", "E9F1"];
const KEY_TEXT = KEY.join("-");
const CODE = "AB12CD34EF"; // a ten-character code, as typed or shown
const SIGN_IN = "WXYZ-2345"; // a sign-in code as Nexus writes it
const LABEL = "Work laptop";
const characters = (code: string): string[] => [...code.replace(/-/g, "")];

const SHOW_KEY: SetupState = { step: "show-key", recoveryKey: KEY_TEXT, ask: [3, 8, 12], wrong: [], message: "shown once" };

/** A screen, once, over a stand-in at `state`; written out for looking at when PICTURES_DIR is set. */
async function drawn(name: string, state: SetupState, prepare: (open: OpenScreens) => void = () => undefined): Promise<OpenScreens> {
  const open = await openScreens(state);
  prepare(open);
  const folder = process.env.PICTURES_DIR;
  if (folder) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, `${name}.html`), `<!doctype html><meta charset="utf-8"><style>body{margin:0}${STYLES}</style><div class="nexus-screen" style="width:375px">${open.root.innerHTML}</div>`);
  }
  return open;
}

/** The screen the key steps show first, at the controller's show-key state. */
const keyScreen = (state: SetupState = SHOW_KEY) => openScreens(state);

const slab = (root: HTMLElement): [string | null | undefined, string | null | undefined] => [root.querySelector(".nx-slab__title")?.textContent, root.querySelector(".nx-slab__line")?.textContent];
const wrongBoxes = (root: HTMLElement): number => root.querySelectorAll(".nx-box--wrong").length;

describe("setup: the start screen", () => {
  it("promises scrambled notes, keeps the Not yet audited box, says a Recovery Key comes next, and has Cancel and Continue", async () => {
    const { root } = await drawn("start", { step: "no-vault" });
    expect(words(root)).toEqual([
      "set up nexus",
      "Step 1 of 4.",
      "Your notes are scrambled on this device before they leave it. The Nexus server only ever holds scrambled text.",
      "Not yet audited",
      "No outside security expert has checked this encryption yet. Fine for notes. Keep another copy of anything you cannot lose.",
      "Next you get a Recovery Key. It is the only way back in if you lose every signed-in device. Nexus cannot reset it.",
      "Cancel",
      "Continue",
    ]);
    expect(buttons(root)).toEqual(["Cancel", "Continue"]);
    expect(root.querySelector(".nx-note")).not.toBeNull();
    expect(root.querySelectorAll(".nx-note--fault")).toHaveLength(0);
  });
});

describe("setup: the Recovery Key, shown once", () => {
  it("shows the 14 groups four to a row, the last row two groups, Copy key, the tick box and a dim Continue", async () => {
    const { root } = await drawn("recovery-key", SHOW_KEY, ({ root: screen }) => tap(screen, "continue")); // from the start screen to the key
    expect(words(root)).toEqual([
      "recovery key",
      "Step 2 of 4.",
      "This is the only time it is shown. Save it now in your password manager, or write it on paper.",
      ...KEY,
      "Copy key",
      "Nexus cannot show it again or reset it. Lose it and every signed-in device, and your notes cannot be opened.",
      "I saved my Recovery Key somewhere safe",
      "Back",
      "Continue",
    ]);
    const rows = [...root.querySelectorAll(".nx-panel .nx-panel__row")].map((row) => row.querySelectorAll(".nx-key-group").length);
    expect(rows, "four to a row, the last row two groups").toEqual([4, 4, 4, 2]);
    expect(root.querySelectorAll(".nx-panel .nx-key-spacer"), "the last row is filled out so its groups line up").toHaveLength(2);
    expect(control(root, "saved").getAttribute("aria-checked")).toBe("false");
    expect(isDim(root, "continue")).toBe(true);
    expect(buttons(root).filter((label) => /approve|check|unlock|verify/i.test(label))).toEqual([]);
  });

  it("with the box ticked: the tick box is teal with a tick in it and Continue is at full strength", async () => {
    const { root } = await drawn("recovery-key-saved", SHOW_KEY, ({ root: screen }) => {
      tap(screen, "continue");
      tap(screen, "saved");
    });
    expect(control(root, "saved").getAttribute("aria-checked")).toBe("true");
    expect(control(root, "saved").querySelector("svg")).not.toBeNull();
    expect(isDim(root, "continue")).toBe(false);
  });
});

describe("setup: typing three groups back", () => {
  it("asks for the groups by number, three rows of four empty boxes, with the plain line about how groups are counted and Back", async () => {
    const { root } = await drawn("check-key", SHOW_KEY, ({ root: screen }) => {
      tap(screen, "continue");
      tap(screen, "saved");
      tap(screen, "continue");
    });
    expect(words(root)).toEqual([
      "check key",
      "Step 3 of 4.",
      "Type three groups of it back from where you saved it. This shows it was written down right.",
      "Group 3",
      "Group 8",
      "Group 12",
      "Groups are blocks of four, counted from the left, top row first. Capitals or small letters both work.",
      "Back",
    ]);
    expect(boxes(root, "type-back")).toHaveLength(12);
    expect(root.querySelectorAll(".nx-group")).toHaveLength(3);
    expect(wrongBoxes(root)).toBe(0);
    expect(buttons(root)).toEqual(["Back"]);
    expect(document.activeElement, "the first empty box has the caret").toBe(box(root, "type-back", 0));
  });

  it("names the group that does not match, turns its four boxes red and keeps the others as typed", async () => {
    const { root, setup } = await drawn("check-key-wrong", SHOW_KEY, ({ root: screen, setup: controller }) => {
      tap(screen, "continue");
      tap(screen, "saved");
      tap(screen, "continue");
      typeInto(screen, "type-back", "4TNB3WVRY8JK");
      controller.show({ ...SHOW_KEY, wrong: [8], message: "wrong" });
    });
    expect(setup.sent("typeBack"), "the twelve characters went to the controller as typed").toEqual([["4TNB3WVRY8JK"]]);
    expect(words(root)).toEqual([
      "check key",
      "Step 3 of 4.",
      "Type three groups of it back from where you saved it. This shows it was written down right.",
      "Group 3",
      ..."4TNB",
      "Group 8",
      ..."3WVR",
      "Group 12",
      ..."Y8JK",
      "Group 8 does not match. Look at your saved key and retype it.",
      "Back",
    ]);
    expect(wrongBoxes(root), "group 8's four boxes").toBe(4);
    const redRow = [...root.querySelectorAll(".nx-group")].findIndex((row) => row.querySelector(".nx-box--wrong"));
    expect(redRow).toBe(1);
    expect(root.querySelector(".nx-fault-line")?.getAttribute("role")).toBe("alert");
  });

  it("names two groups when two are wrong", async () => {
    const { root, setup } = await keyScreen();
    tap(root, "continue");
    tap(root, "saved");
    tap(root, "continue");
    typeInto(root, "type-back", "AAAABBBBCCCC");
    setup.show({ ...SHOW_KEY, wrong: [3, 12], message: "wrong" });
    expect(root.querySelector(".nx-fault-line")?.textContent).toBe("Groups 3 and 12 do not match. Look at your saved key and retype them.");
    expect(wrongBoxes(root)).toBe(8);
  });
});

describe("setup: the password step", () => {
  const choose: SetupState = { step: "choose-password", message: null };

  it("with the switch off: says it is optional, Off is safer, and keeps the cream warning; Finish setup works", async () => {
    const { root } = await drawn("password-off", choose);
    expect(words(root)).toEqual([
      "password",
      "Step 4 of 4.",
      "Optional. Your Recovery Key already opens your notes. A password only saves typing it.",
      "Unlock with a password",
      "Off is safer. Off by default.",
      "Read this first",
      "A password you can remember is much easier to guess than a Recovery Key. Anyone with a copy of your encrypted notes can try guesses on it without limit.",
      "Back",
      "Finish setup",
    ]);
    expect(control(root, "switch").getAttribute("aria-checked")).toBe("false");
    expect(isDim(root, "finish")).toBe(false);
    expect(root.querySelectorAll(".nx-input")).toHaveLength(0);
  });

  it("with the switch on: two password boxes open, the warning stays and is headed Pick a long one, and Finish setup is dim", async () => {
    const { root } = await drawn("password-on", choose, ({ root: screen }) => {
      tap(screen, "switch");
      typeText(screen, "password", "twelve chars");
    });
    expect(words(root)).toEqual([
      "password",
      "Step 4 of 4.",
      "Optional. Your Recovery Key already opens your notes. A password only saves typing it.",
      "Unlock with a password",
      "On. Off is safer.",
      "Password",
      "Type it again",
      "Pick a long one",
      "A password you can remember is much easier to guess than a Recovery Key. Anyone with a copy of your encrypted notes can try guesses on it without limit.",
      "Back",
      "Finish setup",
    ]);
    expect(control(root, "switch").getAttribute("aria-checked")).toBe("true");
    const inputs = [...root.querySelectorAll<HTMLInputElement>(".nx-input")];
    expect(inputs.map((input) => input.type), "typed text is hidden").toEqual(["password", "password"]);
    expect(inputs[1]!.placeholder).toBe("Same password");
    expect(isDim(root, "finish")).toBe(true);
  });
});

describe("setup: done", () => {
  it("shows the tick, the summary (Recovery Key saved, Password off, Not yet audited) and Done", async () => {
    const { root } = await drawn("done", { step: "set-up", password: false, message: null });
    expect(words(root)).toEqual([
      "all set",
      "Nexus is set up.",
      "Your notes are scrambled on this device before they are sent. The first sync starts when you close this.",
      "Recovery Key",
      "Saved by you",
      "Password",
      "Off",
      "Audit",
      "Not yet audited",
      "Done",
    ]);
    expect(root.querySelector(".nx-circle--done svg")).not.toBeNull();
  });

  it("says On for the password when one was kept", async () => {
    const { root } = await openScreens({ step: "set-up", password: true, message: null });
    expect(words(root)).toContain("On");
  });
});

describe("adding a device: the new device waits", () => {
  it("shows the codes to read out, one sand-grey box per character grouped 4, 4, 2, a waiting line with a dot that does not pulse, and Cancel", async () => {
    const { root } = await drawn("new-device-waiting", { step: "waiting-for-device", link: "https://nexus.example.com/nexus/api/approve", code: SIGN_IN, keyCode: "AB12C-D34EF" });
    expect(words(root)).toEqual([
      "new device",
      "Waiting for approval.",
      "On a device that is already signed in, open Nexus settings and choose Approve a device. It will ask for this code.",
      "Sign-in code",
      ...characters(SIGN_IN),
      "Device code",
      ...characters(CODE),
      "Waiting. The code works for 10 minutes.",
      "Cancel",
    ]);
    const device = root.querySelectorAll(".nx-field")[1]!;
    expect([...device.querySelectorAll(".nx-code__group")].map((group) => group.querySelectorAll(".nx-box").length)).toEqual([4, 4, 2]);
    expect(device.querySelectorAll(".nx-box--read")).toHaveLength(10);
    expect(device.getAttribute("aria-label"), "the whole code is one label").toBe("Device code A B 1 2 C D 3 4 E F");
    expect(root.querySelectorAll("input"), "nothing is typed here").toHaveLength(0);
    expect(root.querySelector(".nx-status__dot")).not.toBeNull();
    expect(STYLES, "the dot does not pulse").not.toMatch(/animation|@keyframes/);
  });
});

describe("adding a device: the approving device", () => {
  const asking = (problem: Extract<SetupState, { step: "approve-device" }>["problem"], message: string | null = null): SetupState => ({
    step: "approve-device", message, problem, device: { signInCode: SIGN_IN, label: LABEL },
  });

  it("names the new device in the slab, as text, and asks for its device code in ten empty boxes with Cancel", async () => {
    const { root } = await drawn("approve-device", asking(null));
    expect(words(root)).toEqual([
      "approve device",
      LABEL,
      "Type the code the new device is showing. This stops Nexus's server slipping in a device of its own.",
      "Device code",
      "Nothing is sent to the new device until the code is right.",
      "Cancel",
    ]);
    expect(boxes(root, "device")).toHaveLength(10);
    expect([...root.querySelectorAll(".nx-code__group")].map((group) => group.querySelectorAll(".nx-box").length)).toEqual([4, 4, 2]);
    expect(buttons(root)).toEqual(["Cancel"]);
  });

  it("with a wrong code: all ten boxes red, the red line says nothing was sent and what to do next", async () => {
    const { root } = await drawn("approve-device-wrong", asking(null), ({ root: screen, setup }) => {
      typeInto(screen, "device", "AB12CD34EX");
      setup.show(asking("wrong-key-code", "no match"));
    });
    expect(wrongBoxes(root)).toBe(10);
    expect(words(root)).toEqual([
      "approve device",
      LABEL,
      "Type the code the new device is showing. This stops Nexus's server slipping in a device of its own.",
      "Device code",
      ..."AB12CD34EX",
      "That is not the code on the new device, so nothing was sent. Read it again from its screen. If it keeps failing, cancel and start again on the new device.",
      "Cancel",
    ]);
  });

  it("shows the matching code to read out, tells the person not to use a device that does not accept it, and has Done", async () => {
    const { root } = await drawn("approved", { step: "device-approved", code: "4TKP8-MXD2Q", label: LABEL });
    expect(words(root)).toEqual([
      "approved",
      "Now go to the new device.",
      "It will ask you to type this matching code before it opens your notes.",
      "Matching code",
      ..."4TKP8MXD2Q",
      "If the new device does not accept it, do not use that device. Approve it again from here.",
      "Done",
    ]);
    expect(root.querySelectorAll(".nx-box--read")).toHaveLength(10);
  });

  it("says the account may not approve, with a grey circle and a cross, and Close as the only button", async () => {
    const { root } = await drawn("not-allowed", asking("not-allowed", "Only the owner can approve a device."));
    expect(words(root)).toEqual([
      "not allowed",
      "This device cannot approve.",
      "Nexus says the account this device is signed in as cannot approve new devices. Only the owner's devices can.",
      "Nothing was sent to the new device. Approve it from one of the owner's own devices instead.",
      "Close",
    ]);
    expect(root.querySelector(".nx-circle--neutral svg")).not.toBeNull();
    expect(root.querySelector(".nx-circle--fault"), "grey, not red: nothing is broken").toBeNull();
    expect(buttons(root)).toEqual(["Close"]);
  });
});

describe("adding a device: the new device types the matching code", () => {
  const typing = (message: string | null): SetupState => ({ step: "type-matching-code", triesLeft: 3, message });

  it("asks for the matching code in ten empty boxes, says why, and has Cancel", async () => {
    const { root } = await drawn("matching-code", typing(null));
    expect(words(root)).toEqual([
      "matching code",
      "Your other device approved this one.",
      "It is showing a matching code. Type it here to open your notes.",
      "Matching code",
      "This makes sure the key you were sent is the one your other device sealed.",
      "Cancel",
    ]);
    expect(boxes(root, "matching")).toHaveLength(10);
    expect(buttons(root)).toEqual(["Cancel"]);
  });

  it("with a wrong code: every box red, a red box headed This device stays locked, and no counter", async () => {
    const { root } = await drawn("matching-code-wrong", typing(null), ({ root: screen, setup }) => {
      typeInto(screen, "matching", "4TKP8MXD2R");
      setup.show(typing("That is not the code"));
    });
    expect(wrongBoxes(root)).toBe(10);
    expect(words(root)).toEqual([
      "matching code",
      "Your other device approved this one.",
      "That code does not match.",
      "Matching code",
      ..."4TKP8MXD2R",
      "This device stays locked",
      "A wrong code can mean a typing slip, or that the key was swapped on its way. Try once more. If it still fails, cancel and approve this device again from your other device.",
      "Cancel",
    ]);
    expect(root.querySelectorAll(".nx-note--fault")).toHaveLength(1);
    expect(root.textContent, "no count of tries is shown").not.toMatch(/\b[0-9]+ (tries|attempts)|left/i);
  });

  it("is unlocked: a tick, one line, and Done", async () => {
    const { root } = await drawn("unlocked", { step: "device-unlocked" });
    expect(words(root)).toEqual(["unlocked", "Your notes are opening.", "This device is unlocked. The first sync starts when you close this.", "Done"]);
    expect(root.querySelector(".nx-circle--done svg")).not.toBeNull();
  });

  it("has the wait run out: a light red clock, Use Recovery Key on the left and Start again on the right", async () => {
    const { root } = await drawn("wait-ran-out", { step: "stopped", reason: "expired", message: "The Nexus sign-in ran out. Try again." });
    expect(words(root)).toEqual([
      "wait ran out",
      "No approval in 10 minutes.",
      "Nobody approved this device in time, or the answer got lost. An approval works once, so start again.",
      "You get a new device code. Or skip the other device and unlock with your Recovery Key.",
      "Use Recovery Key",
      "Start again",
    ]);
    expect(buttons(root)).toEqual(["Use Recovery Key", "Start again"]);
    expect(root.querySelector(".nx-circle--fault svg circle")).not.toBeNull();
    expect(root.querySelector(".nx-pill--main")?.textContent).toBe("Start again");
  });
});

describe("unlocking with the Recovery Key", () => {
  const locked = (hasPassword: boolean, problem: "incomplete" | "wrong" | null = null, message: string | null = null): SetupState => ({ step: "has-vault", message, problem, hasPassword });

  it("asks for the key in 14 boxes of four characters, four to a row and the last row two, with the password link only when a password was set up", async () => {
    const { root } = await drawn("locked", locked(true));
    expect(words(root)).toEqual([
      "locked",
      "Signed in, no key yet.",
      "This device is signed in to Nexus but does not have your key. Type your Recovery Key, or approve this device from another one.",
      "Recovery key",
      "Use my password instead",
      "Cancel",
    ]);
    expect(boxes(root, "recovery-key")).toHaveLength(14);
    expect([...root.querySelectorAll(".nx-keyrow")].map((row) => row.querySelectorAll(".nx-box").length)).toEqual([4, 4, 4, 2]);
    expect(wrongBoxes(root)).toBe(0);
    expect(control(root, "use-password").className).toBe("nx-link");
    expect(buttons(root)).toEqual(["Cancel"]);

    const without = await openScreens(locked(false));
    expect(words(without.root)).not.toContain("Use my password instead");
  });

  it("with a key whose last group does not check: only the last box is red, and the line names the last group first", async () => {
    const { root } = await drawn("locked-wrong", locked(true), ({ root: screen, setup }) => {
      pasteInto(screen, "recovery-key", 0, KEY.join(" "));
      // The controller says the key is not whole: the last group is the one it can prove wrong.
      setup.show(locked(true, "incomplete", "not whole"));
    });
    expect(words(root)).toEqual([
      "locked",
      "Signed in, no key yet.",
      "This device is signed in to Nexus but does not have your key. Type your Recovery Key, or approve this device from another one.",
      "Recovery key",
      ...KEY,
      "That Recovery Key is not right. The last group checks the rest, so look at it first, then read the others again.",
      "Use my password instead",
      "Cancel",
    ]);
    const red = [...root.querySelectorAll(".nx-keyrow .nx-box")].map((element, index) => (element.classList.contains("nx-box--wrong") ? index : -1)).filter((index) => index >= 0);
    expect(red, "the last box only").toEqual([13]);
  });
});

describe("the look of every screen", () => {
  it("uses no hand-written colour: every colour in the stylesheet is a token", () => {
    const outside = STYLES.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\.nexus-screen \{[^}]*\}/, "");
    expect(outside.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []).toEqual([]);
    expect(WORDS.cancel).toBe("Cancel");
  });
});
