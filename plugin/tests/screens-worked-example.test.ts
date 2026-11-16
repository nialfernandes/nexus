//
// The setup screens, worked through from the person's side: nothing is called on the controller by the test. Every step is a tap on a
// button or a character typed into a box of the screen, over the real setup controller and the real Nexus server code (the plugin's test
// world, world.ts), with the sync engine syncing a note at the end.
//
//   Device A is a first run: the start screen, the Recovery Key shown once and saved, three groups typed back (wrong, then right), no
//   password, done. A's engine then syncs a note.
//   Device B is new: it asks another to approve it and shows its two codes. A opens the approving screens, types B's sign-in code, sees
//   B's name, types B's device code (wrong, then right) and is shown the matching code. B types the matching code (wrong, which opens
//   nothing, then right), and its engine syncs A's note.
//   Device C joins with the password A set up.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupScreens } from "../src/screens/setup-screens";
import { at, setupDevice, type SetupDevice } from "./setup-world";
import { boxes, buttons, control, installDom, isDim, pasteInto, setBox, tap, typeInto, typeText, typed, words } from "./screens-world";
import { forbidFetch, openBlob, openWorld, type World } from "./world";

let world: World;
let removeDom: () => void;

beforeAll(() => {
  removeDom = installDom();
});

beforeEach(async () => {
  world = await openWorld();
});

afterAll(() => removeDom());

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** The screens over a device's controller, in a page of their own, as the modal holds them. */
function screensFor(device: SetupDevice): { screens: SetupScreens; root: HTMLElement; closed: () => number } {
  let closes = 0;
  const screens = new SetupScreens({
    setup: device.setup,
    copy: async () => undefined,
    later: (_ms, run) => {
      const timer = setTimeout(run, 2000);
      return () => clearTimeout(timer);
    },
    close: () => void closes++,
  });
  document.body.append(screens.element);
  return { screens, root: screens.element, closed: () => closes };
}

/** Waits (letting the controller's calls to Nexus run) until `done` says so. */
async function until(what: string, done: () => boolean, where: () => unknown = () => undefined): Promise<void> {
  for (let turn = 0; turn < 400; turn++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the screens never reached: ${what}; the controller is at ${JSON.stringify(where())}`);
}

const title = (root: HTMLElement): string => root.querySelector(".nx-slab__title")?.textContent ?? "";
const line = (root: HTMLElement): string => root.querySelector(".nx-slab__line")?.textContent ?? "";
/** The characters of the read-only code with this name on the screen. */
const shownCode = (root: HTMLElement, name: string): string => {
  const field = [...root.querySelectorAll(".nx-field")].find((candidate) => candidate.querySelector(".nx-label")?.textContent === name);
  if (!field) throw new Error(`no code called ${name} on the screen`);
  return [...field.querySelectorAll(".nx-box--read")].map((element) => element.textContent).join("");
};
/** The Recovery Key as the screen shows it: its groups, in order. */
const shownKey = (root: HTMLElement): string[] => [...root.querySelectorAll(".nx-panel .nx-key-group")].map((element) => element.textContent ?? "");
const slip = (group: string): string => `${group[0] === "9" ? "8" : "9"}${group.slice(1)}`;

describe("the setup screens, from the person's side", () => {
  it("A sets the vault up through the screens and syncs a note; B joins through the screens, with a wrong code on each side that opens nothing; C unlocks with the password", async () => {
    forbidFetch();

    // ── device A: first run ────────────────────────────────────────────────────
    const a = await setupDevice(world, { files: { "Ideas/one.md": "first note\n" }, name: "Device A" });
    const first = screensFor(a);
    await first.screens.start("unlock");
    expect(title(first.root), "a fresh install shows the start screen").toBe("set up nexus");
    expect(words(first.root)).toContain("Not yet audited");
    expect(a.log.to("POST wrap")).toEqual([]);

    tap(first.root, "continue");
    await until("the key", () => a.setup.state.step === "show-key");
    expect(title(first.root)).toBe("recovery key");
    const key = shownKey(first.root);
    expect(key, "14 groups").toHaveLength(14);
    expect(a.log.to("POST wrap"), "shown once and nothing sent").toEqual([]);
    expect(isDim(first.root, "continue"), "Continue is dim until the box is ticked").toBe(true);
    tap(first.root, "saved");
    tap(first.root, "continue");
    expect(title(first.root)).toBe("check key");

    // Three groups: the first try has a slip in one of them, and that group is named and red.
    const asked = at(a, "show-key").ask;
    expect(words(first.root).filter((text) => /^Group \d+$/.test(text))).toEqual(asked.map((group) => `Group ${group}`));
    const right = asked.map((group) => key[group - 1]!);
    typeInto(first.root, "type-back", [slip(right[0]!), right[1], right[2]].join(""));
    expect(first.root.querySelectorAll(".nx-box--wrong"), "the slipped group's four boxes").toHaveLength(4);
    expect(words(first.root)).toContain(`Group ${asked[0]} does not match. Look at your saved key and retype it.`);
    expect(a.log.to("POST wrap"), "a wrong try sends nothing").toEqual([]);
    expect(a.holder.keys()).toBeNull();
    // Putting the slipped character right: the red goes at that first edit, and the full set is checked at once.
    typeInto(first.root, "type-back", right[0]![0]!, 0);
    await until("the password step", () => a.setup.state.step === "choose-password");
    expect(title(first.root)).toBe("password");
    expect(a.log.to("POST wrap"), "still nothing sent: the password step is next").toEqual([]);

    // No password: the switch is off, and Finish setup works.
    expect(control(first.root, "switch").getAttribute("aria-checked")).toBe("false");
    tap(first.root, "finish");
    await until("set up", () => a.setup.state.step === "set-up");
    expect(title(first.root)).toBe("all set");
    expect(words(first.root)).toEqual(expect.arrayContaining(["Password", "Off", "Not yet audited"]));
    expect(a.log.to("POST wrap")).toHaveLength(1);
    tap(first.root, "done");
    expect(a.setup.state).toEqual({ step: "unlocked" });
    expect(first.closed(), "Done closes the screen").toBe(1);

    await a.engine.sync();
    const sent = a.log.to("POST save");
    expect(sent, "the engine syncs a note").toHaveLength(1);
    expect((await openBlob(a.holder.keys()!, sent[0]!.body.id, sent[0]!.body.blob)).text, "sealed with the key A made").toBe("first note\n");

    // ── device B: new, approved from A ─────────────────────────────────────────
    const b = await setupDevice(world, { token: null, name: "New phone" });
    const second = screensFor(b);
    let matching = "";
    let approving: ReturnType<typeof screensFor> | null = null;
    const walkToA = async (pause: number): Promise<void> => {
      if (pause !== 1) return;
      // B shows the link, the sign-in code and the device code.
      expect(title(second.root)).toBe("new device");
      const signIn = shownCode(second.root, "Sign-in code");
      const device = shownCode(second.root, "Device code");
      expect(signIn).toHaveLength(8);
      expect(device).toHaveLength(10);
      expect(second.root.querySelectorAll("input"), "the codes are only shown on B").toHaveLength(0);

      // A opens the approving screens and types B's codes.
      approving = screensFor(a);
      await approving.screens.start("approve");
      const there = approving.root;
      expect(title(there)).toBe("approve device");
      typeInto(there, "sign-in", signIn);
      await until("B's name", () => (a.setup.state as { device?: unknown }).device !== undefined && (a.setup.state as { device: unknown }).device !== null);
      expect(line(there), "A is told which device it is approving, as text").toBe("New phone");
      expect(boxes(there, "device")).toHaveLength(10);

      const wrong = `${device.slice(0, 9)}${device[9] === "Z" ? "Y" : "Z"}`;
      typeInto(there, "device", wrong);
      await until("the refusal", () => (a.setup.state as { problem?: unknown }).problem === "wrong-key-code");
      expect(there.querySelectorAll(".nx-box--wrong"), "all ten boxes red").toHaveLength(10);
      expect(a.log.to("POST device/approve"), "nothing was sent to the new device").toEqual([]);

      typeInto(there, "device", device[9]!, 9); // the first edit clears the red, and the full ten are checked at once
      await until("the matching code", () => a.setup.state.step === "device-approved");
      expect(title(there)).toBe("approved");
      matching = shownCode(there, "Matching code");
      expect(matching).toHaveLength(10);
    };
    b.whenWaiting = async (pause) => {
      try {
        await walkToA(pause);
      } catch (error) {
        console.error("A's side failed:", error);
        throw error;
      }
    };

    await b.setup.begin();
    await second.screens.start("unlock");
    expect(b.setup.state).toEqual({ step: "signed-out" });
    expect(title(second.root)).toBe("sign in");
    tap(second.root, "ask");
    await until("B typing the matching code", () => b.setup.state.step === "type-matching-code", () => b.setup.state);
    expect(title(second.root)).toBe("matching code");
    expect(b.holder.keys(), "B is locked until the matching code is typed").toBeNull();
    expect(b.deps.data.token, "and has kept no token").toBeNull();

    // A wrong matching code opens nothing.
    const wrongMatching = `${matching.slice(0, 9)}${matching[9] === "Z" ? "Y" : "Z"}`;
    typeInto(second.root, "matching", wrongMatching);
    await until("the refusal", () => (b.setup.state as { message?: unknown }).message !== null && b.setup.state.step === "type-matching-code");
    expect(second.root.querySelectorAll(".nx-box--wrong")).toHaveLength(10);
    expect(words(second.root)).toContain("This device stays locked");
    expect(b.holder.keys(), "the key is not kept").toBeNull();
    expect(b.deps.data.token, "and neither is the token").toBeNull();

    typeInto(second.root, "matching", matching[9]!, 9);
    await until("unlocked", () => b.setup.state.step === "device-unlocked");
    expect(title(second.root)).toBe("unlocked");
    expect(Array.from(b.holder.keys()!.vaultKey)).toEqual(Array.from(a.holder.keys()!.vaultKey));
    tap(second.root, "done");
    expect(second.closed()).toBe(1);

    tap(approving!.root, "done");
    expect(a.setup.state).toEqual({ step: "unlocked" });

    await b.engine.sync();
    expect(b.vault.texts(), "B holds A's note").toEqual({ "Ideas/one.md": "first note\n" });
  }, 60_000);

  it("shows the screen that says the account may not approve when Nexus refuses the approving device, and Close ends it", async () => {
    forbidFetch();
    const { device: a } = await (await import("./setup-world")).firstRun(world);
    a.deps.data.token = await world.tokenFor("agents", "not the owner");
    const { screens, root } = screensFor(a);
    await screens.start("approve");
    typeInto(root, "sign-in", "ABCDEFGH");
    await until("not allowed", () => (a.setup.state as { problem?: unknown }).problem === "not-allowed");
    expect(title(root)).toBe("not allowed");
    expect(buttons(root)).toEqual(["Close"]);
    expect(a.log.to("POST device/approve")).toEqual([]);
    tap(root, "close");
    expect(a.setup.state).toEqual({ step: "unlocked" });
  }, 30_000);

  it("unlocks with the Recovery Key pasted whole into the boxes, and a key whose last group is wrong marks that group and opens nothing", async () => {
    forbidFetch();
    const { recoveryKey } = await (await import("./setup-world")).firstRun(world);
    const device = await setupDevice(world);
    const { screens, root, closed } = screensFor(device);
    await screens.start("unlock");
    expect(title(root)).toBe("locked");
    expect(words(root)).not.toContain("Use my password instead");

    const groups = recoveryKey.split("-");
    const mistyped = [...groups.slice(0, 13), `${groups[13]!.slice(0, 3)}${groups[13]![3] === "2" ? "3" : "2"}`].join(" ");
    pasteInto(root, "recovery-key", 3, mistyped);
    await until("the refusal", () => (device.setup.state as { problem?: unknown }).problem === "incomplete");
    expect([...root.querySelectorAll(".nx-keyrow .nx-box")].map((element) => element.classList.contains("nx-box--wrong")).lastIndexOf(true), "the last box is red").toBe(13);
    expect(root.querySelectorAll(".nx-box--wrong")).toHaveLength(1);
    expect(typed(root, "recovery-key"), "the others keep what was typed").toBe(mistyped.replace(/ /g, ""));
    expect(device.holder.keys()).toBeNull();

    setBox(root, "recovery-key", 13, groups[13]!.slice(0, 3)); // the last character is deleted: the red goes
    typeInto(root, "recovery-key", groups[13]!.slice(3), 13); // and typed again: the key is checked again
    await until("unlocked", () => closed() === 1);
    expect(device.holder.isUnlocked).toBe(true);
  }, 30_000);

  it("sets a password at the first run and unlocks another device with it from the screen: the link only shows when one was set up", async () => {
    forbidFetch();
    const owner = await setupDevice(world);
    const ownerScreens = screensFor(owner);
    await ownerScreens.screens.start("unlock");
    tap(ownerScreens.root, "continue");
    await until("the key", () => owner.setup.state.step === "show-key");
    tap(ownerScreens.root, "saved");
    tap(ownerScreens.root, "continue");
    const state = at(owner, "show-key");
    const key = shownKeyFromState(state.recoveryKey);
    typeInto(ownerScreens.root, "type-back", state.ask.map((group) => key[group - 1]).join(""));
    await until("the password step", () => owner.setup.state.step === "choose-password");
    tap(ownerScreens.root, "switch");
    typeText(ownerScreens.root, "password", "a long password I will remember");
    expect(isDim(ownerScreens.root, "finish"), "dim until both boxes agree").toBe(true);
    typeText(ownerScreens.root, "again", "a long password I will remember");
    tap(ownerScreens.root, "finish");
    await until("set up", () => owner.setup.state.step === "set-up");
    expect(words(ownerScreens.root)).toEqual(expect.arrayContaining(["Password", "On"]));
    tap(ownerScreens.root, "done");

    const other = await setupDevice(world);
    const screens = screensFor(other);
    await screens.screens.start("unlock");
    expect(words(screens.root)).toContain("Use my password instead");
    tap(screens.root, "use-password");
    typeText(screens.root, "unlock-password", "not the password");
    (control(screens.root, "unlock-password") as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until("the refusal", () => (other.setup.state as { problem?: unknown }).problem === "wrong");
    expect(other.holder.keys()).toBeNull();
    typeText(screens.root, "unlock-password", "a long password I will remember");
    (control(screens.root, "unlock-password") as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until("unlocked", () => other.holder.isUnlocked);
    expect(screens.closed()).toBe(1);
  }, 60_000);
});

function shownKeyFromState(recoveryKey: string): string[] {
  return recoveryKey.split("-");
}
