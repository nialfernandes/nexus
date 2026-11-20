// @vitest-environment happy-dom
//
// A code the person has to carry to another device (the device code on the waiting screen, the matching code on the
// approved screen) can be copied: it is text they can select, and a Copy button on the label's row puts exactly the code on the clipboard
// and says Copied for two seconds. The Recovery Key's own Copy key is held by screens-flows.test.ts. The boards draw no Copy beside a
// code, so it is the quiet pill of board 7's Copy key.

import { afterEach, describe, expect, it } from "vitest";
import { COPIED_FOR_MS } from "../src/copied";
import type { SetupState } from "../src/vault-setup";
import { buttons, control, openScreens, tap, words } from "./screens-world";

afterEach(() => {
  document.body.replaceChildren();
});

const WAITING: SetupState = { step: "waiting-for-device", link: "https://nexus.example.com/nexus/api/approve", code: "WXYZ-2345", keyCode: "AB12C-D34EF" };
const APPROVED: SetupState = { step: "device-approved", code: "4TKP8-MXD2Q", label: "Work laptop" };

/** The clipboard answers on the next turn of the microtask queue, and the screen draws Copied after that. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) await Promise.resolve();
};

/** What a person who selects the whole of a code and copies it gets: the copy event, with a clipboard that records what it is given. */
function copyOf(code: Element, selected: string | null): string {
  const given: Record<string, string> = {};
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { setData: (type: string, text: string) => void (given[type] = text) } });
  if (selected !== null) {
    const selection = document.getSelection()!;
    selection.selectAllChildren(code);
    // The page's selection of boxes reads with a line break after each; that is what the screen has to take out.
    selection.toString = () => selected;
  }
  code.dispatchEvent(event);
  expect(event.defaultPrevented, "the screen put its own text on the clipboard").toBe(true);
  return given["text/plain"]!;
}

describe("the device code on the waiting screen (board 14)", () => {
  it("is the one code, with a Copy button on the label's row, and the whole code is text in the page", async () => {
    const { root } = await openScreens(WAITING);
    expect(buttons(root)).toEqual(["Copy", "Cancel"]);
    const fields = [...root.querySelectorAll(".nx-field")];
    expect(fields.map((field) => field.querySelector(".nx-field__head .nx-label")?.textContent), "no sign-in code beside it").toEqual(["Device code"]);
    expect(fields.map((field) => field.querySelector(".nx-field__head button")?.textContent)).toEqual(["Copy"]);
    expect(fields.map((field) => field.querySelector(".nx-code")?.textContent)).toEqual(["AB12CD34EF"]);
    expect(fields.map((field) => field.querySelector(".nx-field__head button")?.getAttribute("aria-label"))).toEqual(["Copy Device code"]);
    expect(root.querySelectorAll(".nx-code--read")).toHaveLength(1);
    expect(root.textContent, "the sign-in code the controller holds is not on the screen at all").not.toContain("WXYZ");
    expect(root.querySelector("[data-key=copy-sign-in]"), "and has no Copy for it").toBeNull();
  });

  it("Copy puts exactly the device code on the clipboard, says Copied for two seconds, then Copy again", async () => {
    const { root, copied, timers } = await openScreens(WAITING);
    tap(root, "copy-device");
    await settle();
    expect(copied).toEqual(["AB12CD34EF"]);
    expect(control(root, "copy-device").textContent).toBe("Copied");
    expect(control(root, "copy-device").getAttribute("aria-label")).toBe("Copied Device code");
    expect(timers.map((timer) => timer.ms)).toEqual([COPIED_FOR_MS]);
    timers[0]!.run();
    expect(control(root, "copy-device").textContent).toBe("Copy");
  });

  it("a second copy while Copied shows starts the two seconds again", async () => {
    const { root, copied, timers } = await openScreens(WAITING);
    tap(root, "copy-device");
    await settle();
    tap(root, "copy-device");
    await settle();
    expect(copied).toEqual(["AB12CD34EF", "AB12CD34EF"]);
    expect(timers.map((timer) => timer.stopped)).toEqual([true, false]);
    expect(control(root, "copy-device").textContent).toBe("Copied");
  });

  it("copying the selected code gives its characters with nothing between the boxes", async () => {
    const { root } = await openScreens(WAITING);
    const device = root.querySelector(".nx-code--read")!;
    expect(copyOf(device, "A\nB\n1\n2\nC\nD\n3\n4\nE\nF\n")).toBe("AB12CD34EF");
    // Nothing readable selected: the whole code.
    expect(copyOf(device, null)).toBe("AB12CD34EF");
  });

  it("still shows the same words, and only the Copy button is new", async () => {
    const { root } = await openScreens(WAITING);
    expect(words(root).filter((word) => word !== "Copy")).toEqual([
      "nexus",
      "new device",
      "Waiting for approval.",
      "On a device that is already signed in, open Nexus settings and choose Approve a device. It will ask for this code.",
      "Device code",
      ..."AB12CD34EF",
      "Waiting. The code works for 10 minutes.",
      "Cancel",
    ]);
  });
});

describe("the matching code on the approved screen (board 17)", () => {
  it("has a Copy button that puts exactly the code on the clipboard and says Copied", async () => {
    const { root, copied } = await openScreens(APPROVED);
    expect(buttons(root)).toEqual(["Copy", "Done"]);
    tap(root, "copy-matching");
    await settle();
    expect(copied).toEqual(["4TKP8MXD2Q"]);
    expect(control(root, "copy-matching").textContent).toBe("Copied");
  });
});

describe("a code that is typed, not read", () => {
  it("has no Copy button: the device code the approving device types is checked by being typed", async () => {
    const { root } = await openScreens({ step: "approve-device", message: null, problem: null, devices: [{ label: "New phone", signInCode: "ABCD-EFGH" }], device: { label: "New phone", signInCode: "ABCD-EFGH" } });
    expect(buttons(root)).toEqual(["Cancel"]);
  });
});

describe("closing the screens while Copied shows", () => {
  it("stops the two seconds, so nothing draws after it is gone", async () => {
    const { root, screens, timers } = await openScreens(WAITING);
    tap(root, "copy-device");
    await settle();
    screens.dispose();
    expect(timers.map((timer) => timer.stopped)).toEqual([true]);
  });
});
