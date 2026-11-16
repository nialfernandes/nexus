// @vitest-environment happy-dom
//
// What the screens do when the person does something, over a stand-in for the setup controller (screens-world.ts): every tap and every
// full code sends one event and nothing else; a button that is dim ignores taps; red goes at the first edit; Back goes back to the same
// key; the screen closes when the controller has nothing going on; and what a device sent is only ever text.

import { afterEach, describe, expect, it } from "vitest";
import { COPIED_FOR_MS } from "../src/screens/setup-screens";
import type { SetupState } from "../src/vault-setup";
import {
  FakeSetup, box, boxes, buttons, control, isDim, openScreens, pasteInto, press, setBox, tap, typeInto, typeText, typed, words, type OpenScreens,
} from "./screens-world";

const KEY = ["A1B2", "C3D4", "E5F6", "G7H8", "J9K1", "M2N3", "P4Q5", "R6S7", "T8V9", "W1X2", "Y3Z4", "A5B6", "C7D8", "E9F1"];
const SHOW_KEY: SetupState = { step: "show-key", recoveryKey: KEY.join("-"), ask: [3, 8, 12], wrong: [], message: null };
const HOSTILE = "<img src=x onerror=alert(1)><script>alert(2)</script>";

afterEach(() => {
  document.body.replaceChildren();
});

/** The key screens, opened at the controller's no-vault state and moved on to show-key, as Continue does. */
async function atTheKey(): Promise<OpenScreens> {
  const open = await openScreens({ step: "no-vault" });
  tap(open.root, "continue");
  expect(open.setup.sent("startFirstRun"), "Continue on the start screen asks the controller to make the key").toHaveLength(1);
  open.setup.show(SHOW_KEY);
  return open;
}

describe("the start and the key", () => {
  it("Cancel on the start screen cancels, and Continue asks for the key to be made, once", async () => {
    const { root, setup } = await openScreens({ step: "no-vault" });
    tap(root, "cancel");
    expect(setup.sent("cancel")).toHaveLength(1);
    tap(root, "continue");
    expect(setup.sent("startFirstRun")).toHaveLength(1);
  });

  it("shows the key when the controller has made it, and Back goes to the start screen and Continue to the same key, which is not made again", async () => {
    const { root, setup } = await atTheKey();
    expect(words(root)).toContain("A1B2");
    tap(root, "back");
    expect(words(root)[0]).toBe("set up nexus");
    tap(root, "continue");
    expect(words(root)).toContain("A1B2");
    expect(setup.sent("startFirstRun"), "still one: the key was not made again").toHaveLength(1);
  });

  it("keeps Continue dim, and ignoring taps, until the box is ticked; unticking dims it again", async () => {
    const { root } = await atTheKey();
    expect(isDim(root, "continue")).toBe(true);
    tap(root, "continue");
    expect(words(root)[0], "a dim Continue goes nowhere").toBe("recovery key");
    tap(root, "saved");
    expect(isDim(root, "continue")).toBe(false);
    tap(root, "saved");
    expect(isDim(root, "continue")).toBe(true);
    tap(root, "saved");
    tap(root, "continue");
    expect(words(root)[0]).toBe("check key");
  });

  it("copies the whole key as one string with a space between groups, says Copied for two seconds, and then says Copy key again", async () => {
    const { root, copied, timers } = await atTheKey();
    tap(root, "copy");
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toEqual([KEY.join(" ")]);
    expect(control(root, "copy").textContent).toBe("Copied");
    expect(timers.map((timer) => timer.ms)).toEqual([COPIED_FOR_MS]);
    expect(COPIED_FOR_MS).toBe(2000);
    timers[0]!.run();
    expect(control(root, "copy").textContent).toBe("Copy key");
  });

  it("is not told the key again by anything but the controller's state: closing forgets the ticks and the boxes", async () => {
    const { root, screens, setup } = await atTheKey();
    tap(root, "saved");
    screens.dispose();
    expect(root.children, "nothing is left on the screen").toHaveLength(0);
    expect(setup.sent("cancel"), "and what was going on is cancelled").toHaveLength(1);
  });
});

describe("typing three groups back", () => {
  async function atTheCheck(): Promise<OpenScreens> {
    const open = await atTheKey();
    tap(open.root, "saved");
    tap(open.root, "continue");
    return open;
  }

  it("sends the twelve characters, as typed, the moment the twelfth is in, and not before", async () => {
    const { root, setup } = await atTheCheck();
    typeInto(root, "type-back", "4TNB3WVRY8J");
    expect(setup.sent("typeBack"), "eleven characters are not a full set").toEqual([]);
    typeInto(root, "type-back", "K", 11);
    expect(setup.sent("typeBack")).toEqual([["4TNB3WVRY8JK"]]);
  });

  it("sends the twelve characters when they are pasted into any box, small letters and spaces and all", async () => {
    const { root, setup } = await atTheCheck();
    pasteInto(root, "type-back", 7, "4tnb 3wvr y8jk");
    expect(setup.sent("typeBack")).toEqual([["4TNB3WVRY8JK"]]);
    expect(typed(root, "type-back")).toBe("4TNB3WVRY8JK");
  });

  it("turns only the wrong group red and names it, keeps what was typed, and clears the red and the line at the first edit of that group", async () => {
    const { root, setup } = await atTheCheck();
    typeInto(root, "type-back", "4TNB3WVRY8JK");
    setup.show({ ...SHOW_KEY, wrong: [8], message: "wrong" });
    expect(root.querySelectorAll(".nx-box--wrong")).toHaveLength(4);
    expect(words(root)).toContain("Group 8 does not match. Look at your saved key and retype it.");
    expect(typed(root, "type-back"), "the other groups keep what was typed").toBe("4TNB3WVRY8JK");

    typeInto(root, "type-back", "X", 4);
    expect(root.querySelectorAll(".nx-box--wrong"), "the group was edited: plain white again").toHaveLength(0);
    expect(root.querySelector(".nx-fault-line")).toBeNull();
    expect(words(root)).toContain("Groups are blocks of four, counted from the left, top row first. Capitals or small letters both work.");
    expect(setup.sent("typeBack"), "and the next full set is checked straight away").toEqual([["4TNB3WVRY8JK"], ["4TNBXWVRY8JK"]]);
  });

  it("goes back to the key with Back", async () => {
    const { root } = await atTheCheck();
    tap(root, "back");
    expect(words(root)[0]).toBe("recovery key");
  });

  it("starts empty when a new key is shown after the last was thrown away", async () => {
    const { root, setup } = await atTheCheck();
    typeInto(root, "type-back", "AAAA");
    setup.show({ step: "no-vault" });
    setup.show({ ...SHOW_KEY, recoveryKey: KEY.slice().reverse().join("-") });
    expect(control(root, "saved").getAttribute("aria-checked"), "the tick was forgotten with the old key").toBe("false");
    tap(root, "saved");
    tap(root, "continue");
    expect(typed(root, "type-back")).toBe("");
  });
});

describe("the password step", () => {
  const choose: SetupState = { step: "choose-password", message: null };

  it("opens two boxes with the caret in the first when the switch goes on, and forgets what was typed when it goes off", async () => {
    const { root } = await openScreens(choose);
    tap(root, "switch");
    expect(document.activeElement).toBe(control(root, "password"));
    typeText(root, "password", "secret words");
    typeText(root, "again", "secret words");
    tap(root, "switch");
    expect(root.querySelectorAll(".nx-input")).toHaveLength(0);
    tap(root, "switch");
    expect((control(root, "password") as HTMLInputElement).value).toBe("");
    expect((control(root, "again") as HTMLInputElement).value).toBe("");
  });

  it("keeps Finish setup dim until both boxes hold the same password (compared as NFKC), and sends the password then", async () => {
    const { root, setup } = await openScreens(choose);
    tap(root, "switch");
    expect(isDim(root, "finish")).toBe(true);
    typeText(root, "password", "Ｐassword that is long");
    expect(isDim(root, "finish"), "one box is not enough").toBe(true);
    typeText(root, "again", "Password that is lon");
    expect(isDim(root, "finish")).toBe(true);
    tap(root, "finish");
    expect(setup.sent("finishSetup"), "a dim Finish setup ignores taps").toEqual([]);
    typeText(root, "again", "Password that is long");
    expect(isDim(root, "finish")).toBe(false);
    tap(root, "finish");
    expect(setup.sent("finishSetup")).toEqual([[{ password: "Ｐassword that is long", again: "Password that is long" }]]);
  });

  it("finishes with no password when the switch is off, which is the way it starts", async () => {
    const { root, setup } = await openScreens(choose);
    expect(isDim(root, "finish")).toBe(false);
    tap(root, "finish");
    expect(setup.sent("finishSetup")).toEqual([[null]]);
  });

  it("goes back to the key through the controller, and says in red what the controller refused", async () => {
    const { root, setup } = await openScreens({ step: "choose-password", message: "The two passwords are not the same." });
    expect(root.querySelector(".nx-fault-line")?.textContent).toBe("The two passwords are not the same.");
    tap(root, "back");
    expect(setup.sent("backToKey")).toHaveLength(1);
  });

  it("goes back to the key as it was left: the same key, the box still ticked, the password forgotten", async () => {
    const { root, setup } = await atTheKey();
    tap(root, "saved");
    tap(root, "continue");
    typeInto(root, "type-back", "AAAABBBBCCCC");
    setup.show({ step: "choose-password", message: null });
    tap(root, "switch");
    typeText(root, "password", "forgotten words");
    tap(root, "back");
    setup.show(SHOW_KEY);
    expect(words(root)[0]).toBe("recovery key");
    expect(control(root, "saved").getAttribute("aria-checked")).toBe("true");
    tap(root, "continue");
    setup.show({ step: "choose-password", message: null });
    expect(control(root, "switch").getAttribute("aria-checked")).toBe("false");
  });

  it("ends with Done, which is the controller's done", async () => {
    const { root, setup } = await openScreens({ step: "set-up", password: true, message: "plain" });
    expect(root.querySelector(".nx-fault-line")?.textContent).toBe("plain");
    tap(root, "done");
    expect(setup.sent("done")).toHaveLength(1);
  });
});

describe("adding a device", () => {
  const found = (label = "Work laptop"): SetupState => ({ step: "approve-device", message: null, problem: null, device: { signInCode: "ABCD-EFGH", label } });
  const asking: SetupState = { step: "approve-device", message: null, problem: null, device: null };

  it("asks for the sign-in code first, and looks the device up when the eighth character is in", async () => {
    const { root, setup } = await openScreens(asking, "approve");
    expect(boxes(root, "sign-in")).toHaveLength(8);
    typeInto(root, "sign-in", "abcdefg");
    expect(setup.sent("lookUpDevice")).toEqual([]);
    typeInto(root, "sign-in", "h", 7);
    expect(setup.sent("lookUpDevice")).toEqual([["ABCDEFGH"]]);
  });

  it("starts the approval screen itself when it is opened for it", async () => {
    const { opening } = await openScreens({ step: "unlocked" }, "approve");
    expect(opening).toEqual([["startApprovingDevice"]]);
  });

  it("marks a sign-in code Nexus does not know red, with Nexus's words, until the first edit", async () => {
    const { root, setup } = await openScreens(asking);
    typeInto(root, "sign-in", "ABCDEFGH");
    setup.show({ step: "approve-device", message: "Nexus has no sign-in with that code.", problem: "no-such-code", device: null });
    expect(root.querySelectorAll(".nx-box--wrong")).toHaveLength(8);
    expect(root.querySelector(".nx-fault-line")?.textContent).toBe("Nexus has no sign-in with that code.");
    typeInto(root, "sign-in", "Z", 0);
    expect(root.querySelectorAll(".nx-box--wrong")).toHaveLength(0);
  });

  it("sends the device code with the sign-in code the controller found, the moment the tenth character is typed", async () => {
    const { root, setup } = await openScreens(found());
    typeInto(root, "device", "AB12CD34E");
    expect(setup.sent("approveDevice")).toEqual([]);
    typeInto(root, "device", "F", 9);
    expect(setup.sent("approveDevice")).toEqual([["ABCD-EFGH", "AB12CD34EF"]]);
  });

  it("turns all ten boxes red when the code is wrong, and the first edit clears the red and the next full ten are checked at once", async () => {
    const { root, setup } = await openScreens(found());
    typeInto(root, "device", "AB12CD34EX");
    setup.show({ ...found(), problem: "wrong-key-code", message: "no" } as SetupState);
    expect(root.querySelectorAll(".nx-box--wrong")).toHaveLength(10);
    typeInto(root, "device", "F", 9);
    expect(root.querySelectorAll(".nx-box--wrong")).toHaveLength(0);
    expect(setup.sent("approveDevice").at(-1)).toEqual(["ABCD-EFGH", "AB12CD34EF"]);
  });

  it("has no lock-out: any number of wrong codes in a row leaves the same screen, typed again each time", async () => {
    const { root, setup } = await openScreens(found());
    for (let attempt = 0; attempt < 5; attempt++) {
      pasteInto(root, "device", 0, `AB12CD34E${attempt}`);
      setup.show({ ...found(), problem: "wrong-key-code", message: "no" } as SetupState);
      expect(root.querySelectorAll(".nx-box--wrong")).toHaveLength(10);
    }
    expect(setup.sent("approveDevice")).toHaveLength(5);
  });

  it("shows the label a device sent as text and never as markup, in the slab and nowhere else it could be read as a tag", async () => {
    const { root } = await openScreens(found(HOSTILE));
    expect(root.querySelector(".nx-slab__line")?.textContent).toBe(HOSTILE);
    expect(root.querySelectorAll("img, script")).toHaveLength(0);
    expect(root.querySelector(".nx-slab__line")?.children).toHaveLength(0);
  });

  it("closes with Cancel and sends nothing to the new device", async () => {
    const { root, setup } = await openScreens(found());
    tap(root, "cancel");
    expect(setup.sent("cancel")).toHaveLength(1);
    expect(setup.sent("approveDevice")).toEqual([]);
  });

  it("is told it may not approve: the grey screen with Close, which is done", async () => {
    const { root, setup } = await openScreens({ ...found(), problem: "not-allowed", message: "Only the owner can approve a device." } as SetupState);
    expect(words(root)[0]).toBe("not allowed");
    tap(root, "close");
    expect(setup.sent("done")).toHaveLength(1);
  });

  it("shows the matching code to read out and ends with Done", async () => {
    const { root, setup } = await openScreens({ step: "device-approved", code: "4TKP8-MXD2Q", label: "Work laptop" });
    expect(root.querySelectorAll(".nx-box--read")).toHaveLength(10);
    tap(root, "done");
    expect(setup.sent("done")).toHaveLength(1);
  });
});

describe("the new device", () => {
  const waiting: SetupState = { step: "waiting-for-device", link: "https://nexus.example.com/nexus/api/approve", code: "ABCD-EFGH", keyCode: "AB12C-D34EF" };
  const typing = (message: string | null = null): SetupState => ({ step: "type-matching-code", triesLeft: 3, message });

  it("Cancel while waiting cancels the wait and looks at the device again, without the screen closing in between", async () => {
    const open = await openScreens(waiting);
    const { root, setup } = open;
    const fake = setup as FakeSetup & { cancel: () => void; begin: () => Promise<void> };
    fake.cancel = () => setup.show({ step: "locked" });
    fake.begin = async () => setup.show({ step: "has-vault", message: null, problem: null, hasPassword: false });
    tap(root, "cancel");
    expect(open.closed(), "the device is signed in but locked: the Recovery Key screen follows, the screen stays").toBe(0);
    expect(words(root)[0]).toBe("locked");
  });

  it("sends the matching code when the tenth character is typed, and marks it red with the plain note when it is wrong", async () => {
    const { root, setup } = await openScreens(typing());
    typeInto(root, "matching", "4TKP8MXD2R");
    expect(setup.sent("typeMatchingCode")).toEqual([["4TKP8MXD2R"]]);
    setup.show(typing("wrong"));
    expect(root.querySelectorAll(".nx-box--wrong")).toHaveLength(10);
    expect(words(root)).toContain("This device stays locked");
    typeInto(root, "matching", "Q", 9);
    expect(root.querySelectorAll(".nx-box--wrong"), "the first edit clears the red").toHaveLength(0);
    expect(root.querySelector(".nx-note--fault")).toBeNull();
    expect(setup.sent("typeMatchingCode").at(-1)).toEqual(["4TKP8MXD2Q"]);
  });

  it("is told it is unlocked, with Done", async () => {
    const { root, setup } = await openScreens({ step: "device-unlocked" });
    tap(root, "done");
    expect(setup.sent("done")).toHaveLength(1);
  });

  it("starts again or goes to the Recovery Key from the screen that says the wait ran out", async () => {
    const { root, setup } = await openScreens({ step: "stopped", reason: "expired", message: "ran out" });
    tap(root, "again");
    expect(setup.sent("askAnotherDevice")).toHaveLength(1);
    tap(root, "recovery-key");
    expect(setup.sent("begin")).toHaveLength(1);
  });
});

describe("unlocking", () => {
  const locked = (hasPassword = false, problem: "incomplete" | "wrong" | "other" | null = null, message: string | null = null): SetupState => ({ step: "has-vault", message, problem, hasPassword });
  const written = KEY.join("");

  it("sends the Recovery Key when the fourteenth group is in, typed group by group with the caret moving on after each four characters", async () => {
    const { root, setup } = await openScreens(locked());
    for (let group = 0; group < 13; group++) typeInto(root, "recovery-key", KEY[group]!, group);
    expect(setup.sent("typeRecoveryKey")).toEqual([]);
    expect(document.activeElement).toBe(box(root, "recovery-key", 13));
    typeInto(root, "recovery-key", KEY[13]!, 13);
    expect(setup.sent("typeRecoveryKey")).toEqual([[written]]);
  });

  it("fills every box when the whole key is pasted, hyphens or spaces or none, and checks it at once", async () => {
    const { root, setup } = await openScreens(locked());
    pasteInto(root, "recovery-key", 6, KEY.join("-").toLowerCase());
    expect(typed(root, "recovery-key")).toBe(written);
    expect(setup.sent("typeRecoveryKey")).toEqual([[written]]);
  });

  it("marks only the last group red when the key's own check does not agree, keeps the other groups, and clears the red at the first edit", async () => {
    const { root, setup } = await openScreens(locked());
    pasteInto(root, "recovery-key", 0, KEY.join(" "));
    setup.show(locked(false, "incomplete", "not whole"));
    expect([...root.querySelectorAll(".nx-keyrow .nx-box")].map((element) => element.classList.contains("nx-box--wrong"))).toEqual([...Array(13).fill(false), true]);
    expect(typed(root, "recovery-key"), "the other boxes keep what was typed").toBe(written);
    setBox(root, "recovery-key", 13, "Y8J"); // a character of the last group is deleted
    expect(root.querySelectorAll(".nx-box--wrong")).toHaveLength(0);
    expect(root.querySelector(".nx-fault-line")).toBeNull();
  });

  it("says in red what the controller said when the key was whole and still did not open the vault, and marks no box", async () => {
    const { root } = await openScreens(locked(false, "wrong", "That Recovery Key does not open this vault."));
    expect(root.querySelector(".nx-fault-line")?.textContent).toBe("That Recovery Key does not open this vault.");
    expect(root.querySelectorAll(".nx-box--wrong")).toHaveLength(0);
  });

  it("offers the password only when one was set up, and the password box sends on Enter, with a way back to the key", async () => {
    const { root, setup } = await openScreens(locked(true));
    tap(root, "use-password");
    expect(words(root)).toContain("Type the password you set up for this vault.");
    expect(document.activeElement).toBe(control(root, "unlock-password"));
    typeText(root, "unlock-password", "the words I chose");
    expect(setup.sent("typePassword"), "typing alone sends nothing").toEqual([]);
    press(root, "unlock-password", "Enter");
    expect(setup.sent("typePassword")).toEqual([["the words I chose"]]);
    tap(root, "use-recovery-key");
    expect(words(root)).toContain("Recovery key");
    expect((await openScreens(locked(false))).root.querySelector("[data-key='use-password']")).toBeNull();
  });

  it("says what the controller said when the password was wrong", async () => {
    const { root, setup } = await openScreens(locked(true));
    tap(root, "use-password");
    setup.show(locked(true, "wrong", "That password does not open this vault."));
    expect(root.querySelector(".nx-fault-line")?.textContent).toBe("That password does not open this vault.");
    expect((control(root, "unlock-password") as HTMLInputElement).type, "typed text is hidden").toBe("password");
  });

  it("closes with Cancel and the device stays locked", async () => {
    const { root, setup } = await openScreens(locked());
    tap(root, "cancel");
    expect(setup.sent("cancel")).toHaveLength(1);
  });
});

describe("the steps that have no drawing of their own, in the same look", () => {
  it("says what the controller said, as text, for a step that stopped, and offers to try again", async () => {
    const { root, setup } = await openScreens({ step: "stopped", reason: "denied", message: HOSTILE });
    expect(root.querySelector(".nx-text")?.textContent).toBe(HOSTILE);
    expect(root.querySelectorAll("img, script")).toHaveLength(0);
    expect(buttons(root)).toEqual(["Close", "Try again"]);
    tap(root, "again");
    expect(setup.sent("begin")).toHaveLength(1);
  });

  it("says what failed to save and tries the same wraps again", async () => {
    const { root, setup } = await openScreens({ step: "save-failed", message: HOSTILE });
    expect(root.querySelector(".nx-text")?.textContent).toBe(HOSTILE);
    tap(root, "again");
    expect(setup.sent("tryAgain")).toHaveLength(1);
  });

  it("tells a signed-out device to sign in first, or to ask another device", async () => {
    const { root, setup } = await openScreens({ step: "signed-out" });
    expect(words(root)[0]).toBe("sign in");
    tap(root, "ask");
    expect(setup.sent("askAnotherDevice")).toHaveLength(1);
  });

  it("says one moment while the controller works", async () => {
    const { root } = await openScreens({ step: "working", doing: "saving" });
    expect(words(root)).toEqual(["working", "One moment.", "Keeping your wraps on Nexus."]);
  });
});

describe("opening and closing", () => {
  it("asks the controller what Nexus holds when opened to set up or unlock, and to approve when opened for that", async () => {
    const unlock = await openScreens({ step: "locked" }, "unlock");
    expect(unlock.opening).toEqual([["begin"]]);
    const approve = await openScreens({ step: "unlocked" }, "approve");
    expect(approve.opening).toEqual([["startApprovingDevice"]]);
  });

  it("closes when the controller has nothing going on: locked or unlocked", async () => {
    for (const idle of [{ step: "locked" }, { step: "unlocked" }] as SetupState[]) {
      const open = await openScreens({ step: "set-up", password: false, message: null });
      expect(open.closed()).toBe(0);
      open.setup.show(idle);
      expect(open.closed(), idle.step).toBe(1);
    }
  });

  it("stops drawing when it is closed, and stops its timers", async () => {
    const { screens, setup, root, timers, copied } = await atTheKey();
    tap(root, "copy");
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toHaveLength(1);
    screens.dispose();
    expect(timers[0]!.stopped).toBe(true);
    setup.show({ step: "no-vault" });
    expect(root.children, "a state that arrives later draws nothing").toHaveLength(0);
  });
});

describe("no button of the drawings' rule", () => {
  it("has no Approve, Check, Unlock or Verify button on any screen", async () => {
    const states: SetupState[] = [
      { step: "no-vault" }, SHOW_KEY, { step: "choose-password", message: null }, { step: "set-up", password: false, message: null },
      { step: "waiting-for-device", link: "l", code: "ABCD-EFGH", keyCode: "AB12C-D34EF" }, { step: "type-matching-code", triesLeft: 3, message: null },
      { step: "device-unlocked" }, { step: "approve-device", message: null, problem: null, device: null },
      { step: "approve-device", message: null, problem: null, device: { signInCode: "ABCD-EFGH", label: "Work laptop" } },
      { step: "device-approved", code: "4TKP8-MXD2Q", label: "x" }, { step: "has-vault", message: null, problem: null, hasPassword: true },
      { step: "stopped", reason: "expired", message: "x" }, { step: "stopped", reason: "denied", message: "x" }, { step: "signed-out" },
    ];
    for (const state of states) {
      const { root } = await openScreens(state);
      expect(buttons(root).filter((label) => /^(approve|check|unlock|verify)/i.test(label)), state.step).toEqual([]);
      document.body.replaceChildren();
    }
  });
});
