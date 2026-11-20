//
// Adding a device takes one code. The new device shows its device code (with Copy) and nothing else to carry; the approving device names the
// new device (the one that waits is the slab line; several are a list by name to pick from), is typed that code and nothing more, checks it
// against the key of the device named, and goes on to the matching code. Run for real: both devices' screens over the real setup controller and the real Nexus server code (the plugin's
// test world, world.ts), as settings-sign-in-copy.test.ts runs the settings tab. The screens are driven the way a person drives them,
// by characters typed into boxes and by taps; the test calls nothing on the controller itself.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupScreens } from "../src/screens/setup-screens";
import type { SetupState } from "../src/vault-setup";
import { at, firstRun, setupDevice, type SetupDevice } from "./setup-world";
import { boxes, buttons, installDom, tap, typeInto, words } from "./screens-world";
import { generateDeviceKeyPair } from "@nexus/crypto";
import { encodeBase64 } from "../src/base64";
import { bodyOf, deviceRoutes, forbidFetch, openWorld, type World } from "./world";

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
/** The line the boards call the slab line (first in the body). */
const line = (root: HTMLElement): string => root.querySelector(".nx-slab__line")?.textContent ?? "";
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
      expect(line(onA.root), "board 15: the slab line names the new device").toBe("New phone");
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

    // A got the sign-in and its key through the list of those waiting (one call), and sent one approval.
    expect(a.log.to("GET device/waiting")).toHaveLength(1);
    expect(a.log.to("GET device/pending"), "the list held the key, so nothing more was asked").toEqual([])
    expect(a.log.to("POST device/approve")).toHaveLength(1);
    expect(a.log.to("POST device/approve")[0]!.body.code, "to the sign-in the device code belongs to").toBe(
      (b.states.find((state) => state.step === "waiting-for-device") as Extract<SetupState, { step: "waiting-for-device" }>).code,
    );

    typeInto(onB.root, "matching", matching);
    await until("B unlocked", () => b.setup.state.step === "device-unlocked", () => b.setup.state);
    expect(Array.from(b.holder.keys()!.vaultKey)).toEqual(Array.from(a.holder.keys()!.vaultKey));
    await b.engine.sync();
    expect(b.vault.texts()).toEqual({ "Ideas/one.md": "first note\n" });
  }, 60_000);

  it("several new devices waiting: a list by name, picking one goes on to its code, and another device's code is refused with nothing sent", async () => {
    forbidFetch();
    const { device: a } = await firstRun(world);
    const other = bodyOf(await deviceRoutes().start(world.user, "Old tablet", encodeBase64((await generateDeviceKeyPair()).publicKey)));
    const b = await setupDevice(world, { token: null, name: "New phone" });
    let drawn: string[] = [];
    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const device = shownCode(onB.root, "Device code");
      const onA = screensFor(a);
      await onA.screens.start("approve");
      // The list: by name, oldest first, and no code to type yet.
      expect(title(onA.root)).toBe("approve device");
      expect(line(onA.root)).toBe("Which device?");
      expect(buttons(onA.root)).toEqual(["Old tablet", "New phone", "Cancel"]);
      expect(boxes(onA.root, "device"), "no code is asked for before a device is picked").toHaveLength(0);
      expect(words(onA.root).join(" "), "no sign-in code is drawn").not.toContain(other.code);

      // The wrong one is picked: the code on the new phone is not the code of the old tablet's key.
      tap(onA.root, `device:${other.code}`);
      expect(line(onA.root), "the slab line names the one picked").toBe("Old tablet");
      expect(buttons(onA.root)).toEqual(["Not this one", "Cancel"]);
      typeInto(onA.root, "device", device);
      await until("the refusal", () => (a.setup.state as { problem?: unknown }).problem === "wrong-key-code", () => a.setup.state);
      expect(onA.root.querySelectorAll(".nx-box--wrong"), "all ten boxes red").toHaveLength(10);
      expect(a.log.to("POST device/approve"), "nothing was sent").toEqual([]);

      // Back to the list, the right one: its name is the slab line and its code is typed afresh.
      tap(onA.root, "another");
      expect(line(onA.root)).toBe("Which device?");
      tap(onA.root, `device:${at(b, "waiting-for-device").code}`);
      expect(line(onA.root)).toBe("New phone");
      expect(onA.root.querySelectorAll(".nx-box--wrong"), "the red is gone with the other device").toHaveLength(0);
      expect(boxes(onA.root, "device").map((box) => box.value).join(""), "and the boxes are empty").toBe("");
      typeInto(onA.root, "device", device);
      await until("the matching code", () => a.setup.state.step === "device-approved", () => a.setup.state);
      drawn = buttons(onA.root);
      b.setup.cancel();
    };
    const onB = screensFor(b);
    await b.setup.askAnotherDevice();
    expect(drawn, "board 17 after the right pick").toContain("Done");
    expect(a.log.to("POST device/approve"), "one approval, for the device that was picked and typed").toHaveLength(1);
    expect(bodyOf(await deviceRoutes().poll(other.secret)), "the old tablet is still waiting").toEqual({ status: "pending" });
  }, 60_000);

  it("no device waiting: says so and offers to look again, which names a device that has started since", async () => {
    forbidFetch();
    const { device: a } = await firstRun(world);
    const onA = screensFor(a);
    await onA.screens.start("approve");
    expect(title(onA.root)).toBe("approve device");
    expect(line(onA.root)).toBe("No device is waiting.");
    expect(buttons(onA.root)).toEqual(["Cancel", "Look again"]);
    expect(boxes(onA.root, "device"), "nothing to type a code for").toHaveLength(0);

    const started = bodyOf(await deviceRoutes().start(world.user, "Late phone", encodeBase64((await generateDeviceKeyPair()).publicKey)));
    tap(onA.root, "look-again");
    await until("the device named", () => line(onA.root) === "Late phone", () => a.setup.state);
    expect(boxes(onA.root, "device")).toHaveLength(10);
    expect(a.log.to("POST device/approve")).toEqual([]);
    expect(bodyOf(await deviceRoutes().poll(started.secret))).toEqual({ status: "pending" });
  }, 30_000);

  it("a code that is not the one of the device named is refused: all ten boxes red, and nothing is sent", async () => {
    forbidFetch();
    const { device: a } = await firstRun(world);
    const b = await setupDevice(world, { token: null, name: "New phone" });
    let refused = false;
    b.whenWaiting = async (pause) => {
      if (pause !== 1) return;
      const onA = screensFor(a);
      await onA.screens.start("approve");
      // Ten characters that are no device's code, as a person who typed the wrong thing would (and the old sign-in code is no use either).
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
