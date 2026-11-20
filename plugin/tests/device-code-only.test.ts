//
// Adding a device takes one code. The new device shows its device code (with Copy) and nothing else to carry; the approving device is
// typed that code and nothing more, finds the new device's sign-in from it through Nexus's list of the sign-ins waiting, and goes on to
// the matching code. Run for real: both devices' screens over the real setup controller and the real Nexus server code (the plugin's
// test world, world.ts), as settings-sign-in-copy.test.ts runs the settings tab. The screens are driven the way a person drives them,
// by characters typed into boxes and by taps; the test calls nothing on the controller itself.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupScreens } from "../src/screens/setup-screens";
import { at, firstRun, setupDevice, type SetupDevice } from "./setup-world";
import { boxes, buttons, installDom, tap, typeInto, words } from "./screens-world";
import { forbidFetch, openWorld, type World } from "./world";

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
function screensFor(device: SetupDevice): { screens: SetupScreens; root: HTMLElement; copied: string[] } {
  const copied: string[] = [];
  const screens = new SetupScreens({
    setup: device.setup,
    copy: async (text) => void copied.push(text),
    later: (_ms, run) => {
      const timer = setTimeout(run, 2000);
      return () => clearTimeout(timer);
    },
    close: () => undefined,
  });
  document.body.append(screens.element);
  return { screens, root: screens.element, copied };
}

/** Waits (letting the controller's calls to Nexus run) until `done` says so. */
async function until(what: string, done: () => boolean, where: () => unknown = () => undefined): Promise<void> {
  for (let turn = 0; turn < 400; turn++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never reached: ${what}; the controller is at ${JSON.stringify(where())}`);
}

const title = (root: HTMLElement): string => root.querySelector(".nx-slab__title")?.textContent ?? "";
/** The characters of the read-only code with this name on the screen. */
const shownCode = (root: HTMLElement, name: string): string => {
  const field = [...root.querySelectorAll(".nx-field")].find((candidate) => candidate.querySelector(".nx-label")?.textContent === name);
  if (!field) throw new Error(`no code called ${name} on the screen`);
  return [...field.querySelectorAll(".nx-box--read")].map((element) => element.textContent).join("");
};

describe("adding a device with one code", () => {
  it("worked example: the new device shows its device code, the approving device is typed only that code, and goes on to the matching code", async () => {
    forbidFetch();
    const { device: a } = await firstRun(world, { files: { "Ideas/one.md": "first note\n" }, name: "Device A" });
    await a.engine.sync();
    const b = await setupDevice(world, { token: null, name: "New phone" });
    const onB = screensFor(b);
    let matching = "";
    let typedOnA = "";
    let onA: ReturnType<typeof screensFor> | null = null;

    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      // B's screen (board 14): one code, with Copy.
      expect(title(onB.root)).toBe("new device");
      const device = shownCode(onB.root, "Device code");
      expect(device).toHaveLength(10);
      expect(onB.root.querySelectorAll(".nx-field"), "one code to carry, not two").toHaveLength(1);
      expect(buttons(onB.root)).toEqual(["Copy", "Cancel"]);
      tap(onB.root, "copy-device");
      await until("the copy", () => onB.copied.length > 0);
      expect(onB.copied, "Copy puts the device code and nothing else on the clipboard").toEqual([device]);
      const signIn = at(b, "waiting-for-device").code;
      expect(words(onB.root).join(" "), "the sign-in code is nowhere on B's screen").not.toContain(signIn.replace("-", ""));

      // A's screen (board 15): ten boxes for the device code, and no other box.
      onA = screensFor(a);
      await onA.screens.start("approve");
      expect(title(onA.root)).toBe("approve device");
      expect(boxes(onA.root, "device")).toHaveLength(10);
      expect(onA.root.querySelectorAll("input.nx-box__input"), "ten boxes and nothing else to type").toHaveLength(10);
      typedOnA = device;
      typeInto(onA.root, "device", device);
      await until("the matching code", () => a.setup.state.step === "device-approved", () => a.setup.state);
      expect(title(onA.root), "board 17").toBe("approved");
      matching = shownCode(onA.root, "Matching code");
      expect(matching).toHaveLength(10);
    };

    await b.setup.askAnotherDevice();
    expect(typedOnA, "A was typed the device code").not.toBe("");
    expect(typedOnA).not.toContain("-");
    expect(b.holder.keys(), "B is locked until the matching code is typed on B").toBeNull();

    // A found the sign-in through the list of those waiting, asked for its key, and sent one approval.
    expect(a.log.to("GET device/waiting")).toHaveLength(1);
    expect(a.log.to("GET device/pending")).toHaveLength(1);
    expect(a.log.to("POST device/approve")).toHaveLength(1);
    expect(a.log.to("POST device/approve")[0]!.body.code, "to the sign-in the device code belongs to").toBe(
      b.states.find((state) => state.step === "waiting-for-device" && state.code !== "")!.code,
    );

    typeInto(onB.root, "matching", matching);
    await until("B unlocked", () => b.setup.state.step === "device-unlocked", () => b.setup.state);
    expect(Array.from(b.holder.keys()!.vaultKey)).toEqual(Array.from(a.holder.keys()!.vaultKey));
    await b.engine.sync();
    expect(b.vault.texts()).toEqual({ "Ideas/one.md": "first note\n" });
  }, 60_000);

  it("is not found by the sign-in code: the old first code finds no device, and nothing is sent", async () => {
    forbidFetch();
    const { device: a } = await firstRun(world);
    const b = await setupDevice(world, { token: null, name: "New phone" });
    let refused = false;
    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const onA = screensFor(a);
      await onA.screens.start("approve");
      // Ten characters of the sign-in code's alphabet that are no device's code, as a person who typed the wrong thing would.
      typeInto(onA.root, "device", "WXYZ234567");
      await until("the refusal", () => (a.setup.state as { problem?: unknown }).problem === "wrong-key-code", () => a.setup.state);
      expect(onA.root.querySelectorAll(".nx-box--wrong"), "all ten boxes red").toHaveLength(10);
      expect(a.log.to("POST device/approve"), "nothing was sent to the new device").toEqual([]);
      refused = true;
      b.setup.cancel();
    };
    await b.setup.askAnotherDevice();
    expect(refused, "A's screen took the code and refused it").toBe(true);
  }, 30_000);
});
