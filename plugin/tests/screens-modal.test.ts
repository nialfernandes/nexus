//
// The modal the screens are shown in: it holds the screens, hands them the controller, and closes when they say they are done. Over a
// stand-in for Obsidian's modal (fake-obsidian.ts) and for the setup controller (screens-world.ts). It runs in Node with a page installed
// by hand (installDom), as vitest's own browser-like environment cannot be told that `obsidian` is the stand-in.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeSetup, installDom } from "./screens-world";

vi.mock("obsidian", () => import("./fake-obsidian"));

const { NexusSetupModal } = await import("../src/screens/modal");
import type { SetupState, VaultSetup } from "../src/vault-setup";

let removeDom: () => void;

beforeAll(() => {
  removeDom = installDom();
});

afterEach(() => {
  document.body.replaceChildren();
});

afterAll(() => removeDom());

const open = (state: SetupState, entry: "unlock" | "approve" = "unlock") => {
  const setup = new FakeSetup(state);
  const modal = new NexusSetupModal({} as never, setup as unknown as VaultSetup, entry);
  modal.open();
  return { setup, modal };
};

describe("the modal the setup screens are shown in", () => {
  it("is Obsidian's modal with the teal band as its top: the screens are in its content, under the class styles.css gives it", async () => {
    const { modal } = open({ step: "no-vault" });
    expect(modal.modalEl.classList.contains("nexus-modal")).toBe(true);
    expect(modal.contentEl.querySelector(".nexus-screen .nx-slab__title")?.textContent).toBe("set up nexus");
    expect(document.body.contains(modal.modalEl)).toBe(true);
  });

  it("starts what it was opened for: asking Nexus what it holds, or readying this device to approve another", () => {
    expect(open({ step: "locked" }, "unlock").setup.sent("begin")).toHaveLength(1);
    expect(open({ step: "unlocked" }, "approve").setup.sent("startApprovingDevice")).toHaveLength(1);
  });

  it("closes itself when the controller has nothing going on, as Done does", () => {
    const { modal, setup } = open({ step: "set-up", password: false, message: null });
    expect(modal.isOpen).toBe(true);
    setup.show({ step: "unlocked" });
    expect(modal.isOpen).toBe(false);
    expect(document.body.contains(modal.modalEl)).toBe(false);
  });

  it("throws away what was going on when it is closed any other way, and leaves nothing in its content", () => {
    const { modal, setup } = open({ step: "no-vault" });
    setup.calls.length = 0;
    modal.close();
    expect(setup.sent("cancel")).toHaveLength(1);
    expect(modal.contentEl.children).toHaveLength(0);
  });

  it("puts the key on the clipboard through the browser's clipboard, one string", async () => {
    const written: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (text: string) => void written.push(text) } });
    const { modal, setup } = open({ step: "no-vault" });
    modal.contentEl.querySelector<HTMLElement>("[data-key=continue]")!.click();
    setup.show({ step: "show-key", recoveryKey: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH-JJJJ-KKKK-MMMM-NNNN-PPPP-QQQQ", ask: [1, 2, 3], wrong: [], message: null });
    modal.contentEl.querySelector<HTMLElement>("[data-key=copy]")!.click();
    await Promise.resolve();
    expect(written).toEqual(["AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH JJJJ KKKK MMMM NNNN PPPP QQQQ"]);
    vi.unstubAllGlobals();
  });
});
