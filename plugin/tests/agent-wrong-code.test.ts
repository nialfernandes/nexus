// Board 31a over the real command, the real plugin and the real server code: `nexus-agent join scribe` is waiting, and the owner types a
// code that is not scribe's agent code into the plugin's board 31 screen. Every box turns red and the screen says "That code does not match."
// with the red box "scribe does not get the key". Nothing is handed over: no approval is sent, Nexus holds no sealed key for the sign-in, and
// join is still waiting with nothing printed on standard output. The owner may type again (a second wrong try shows the same screen, no
// counter, no lock-out), and the right code then gives the key and join ends with done.
//
// A code that is the code of ANOTHER key is the case the check is for: a wrong try is not a typing slip alone, it can be a key put in the
// agent's place (docs/FORMAT.md section 7.4). The second test swaps the key Nexus lists for scribe's sign-in for one of its own and types
// the code scribe itself printed: it does not match the key the plugin was given, and nothing is sealed to the key Nexus made up.

import { generateDeviceKeyPair } from "@nexus/crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV } from "../../packages/agent/src/cli/labels";
import { ADDRESS, fetchOverNexus, run } from "../../packages/agent/tests/world";
import { encodeBase64 } from "../src/base64";
import { addAgent, agentCodeIn, environmentOf, screensFor, slipped, until, whileWaiting } from "./agent-join-world";
import { firstRun } from "./setup-world";
import { boxes, buttons, installDom, typeInto, words } from "./screens-world";
import { askNexus, forbidFetch, hostileServer, openWorld, type World } from "./world";

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

const title = (root: HTMLElement): string => root.querySelector(".nx-slab__title")?.textContent ?? "";
const redBoxes = (root: HTMLElement): number => root.querySelectorAll(".nx-box--wrong").length;

/** The words of board 31a for the characters typed. */
const board31a = (typedCode: string): string[] => [
  "nexus",
  "give the key",
  "scribe has joined.",
  "That code does not match.",
  "Agent code",
  ...typedCode,
  "scribe does not get the key",
  "A wrong code can mean a typing slip, or that this is not the agent you added. Try once more. If it still fails, cancel and add the agent again.",
  "Cancel",
];

describe("a wrong agent code", () => {
  it("shows board 31a and gives nothing: join keeps waiting; a second wrong try shows the same screen; the right code then gives the key", async () => {
    forbidFetch();
    const { device: mac } = await firstRun(world, { files: { "Ideas/one.md": "a note\n" }, name: "Owner's Mac" });
    await mac.engine.sync();
    await addAgent(world, "scribe");
    const owner = screensFor(mac);
    let went = false;

    const owners = whileWaiting(async (printed) => {
        if (went) return;
        went = true;
        const code = agentCodeIn(printed.stderr);
        await owner.screens.start("approve");
        await until("board 31", () => title(owner.root) === "give the key", () => mac.setup.state);

        // First wrong try: one character is not scribe's.
        const first = slipped(code);
        typeInto(owner.root, "device", first);
        await until("board 31a", () => redBoxes(owner.root) === 10, () => mac.setup.state);
        expect(words(owner.root)).toEqual(board31a(first));
        expect(buttons(owner.root)).toEqual(["Cancel"]);
        expect(mac.log.to("POST device/approve"), "nothing was sent").toEqual([]);
        expect(hostileServer().approvalsHeld(), "Nexus holds no sealed key for anyone").toBe(0);
        expect(printed.stdout, "join has been given nothing and has printed nothing").toBe("");
        expect(owner.closed(), "the screen stays").toBe(0);

        // Second wrong try (the last character changed again): the same screen, and still nothing given.
        const refusals = (): number => mac.states.filter((state) => state.step === "approve-device" && state.problem === "wrong-key-code").length;
        const before = refusals();
        const another = [..."XYZW"].find((character) => character !== code[9] && character !== first[9])!;
        typeInto(owner.root, "device", another, 9);
        await until("the second refusal", () => refusals() > before, () => mac.setup.state);
        expect(redBoxes(owner.root)).toBe(10);
        expect(words(owner.root)).toEqual(board31a(`${code.slice(0, 9)}${another}`));
        expect(mac.log.to("POST device/approve"), "still nothing was sent").toEqual([]);
        expect(hostileServer().approvalsHeld()).toBe(0);
        expect(owner.closed()).toBe(0);
        expect(boxes(owner.root, "device")).toHaveLength(10);

        // The right code: the last box is typed over, and the whole code is checked.
        typeInto(owner.root, "device", code[9]!, 9);
        await until("the screen closes", () => owner.closed() === 1, () => mac.setup.state);
    });
    const joined = await run(["join", "scribe"], { env: { [ENV.address]: ADDRESS }, fetch: fetchOverNexus().fetch, onWait: owners.onWait });
    owners.check();

    expect(joined.code, joined.stderr).toBe(0);
    expect(mac.log.to("POST device/approve"), "exactly one approval, the one for the right code").toHaveLength(1);
    const read = await run(["read", "Ideas/one.md"], { env: environmentOf(joined.stdout), fetch: fetchOverNexus().fetch });
    expect(read.stdout).toBe("a note\n");
  }, 60_000);

  it("refuses a key Nexus put in scribe's place: the code scribe printed is not the code of that key, so nothing is sealed to it", async () => {
    forbidFetch();
    const { device: mac } = await firstRun(world, { name: "Owner's Mac" });
    await addAgent(world, "scribe");
    const owner = screensFor(mac);
    const server = hostileServer();
    let went = false;

    const owners = whileWaiting(async (printed) => {
        if (went) return; // the owner turned the sign-in down at the first pause, so join ends at its next poll
        went = true;
        const code = agentCodeIn(printed.stderr);
        const signIn = /sign-in code: ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(printed.stderr)![1]!;
        const theirs = await generateDeviceKeyPair();
        server.swapDeviceKey(signIn, encodeBase64(theirs.publicKey));

        await owner.screens.start("approve");
        await until("board 31", () => title(owner.root) === "give the key", () => mac.setup.state);
        typeInto(owner.root, "device", code); // exactly what scribe's own screen said
        await until("board 31a", () => redBoxes(owner.root) === 10, () => mac.setup.state);
        expect(words(owner.root)).toEqual(board31a(code));
        expect(mac.log.to("POST device/approve"), "nothing was sealed to Nexus's key").toEqual([]);
        expect(server.approvalsHeld()).toBe(0);
        // The owner cancels, and turns the sign-in down so join ends.
        owner.screens.dispose();
        await askNexus("POST", "device/deny", { cookie: world.ownerCookie }, { code: signIn });
    });
    const joined = await run(["join", "scribe"], { env: { [ENV.address]: ADDRESS }, fetch: fetchOverNexus().fetch, onWait: owners.onWait });
    owners.check();

    expect(joined.code).toBe(1);
    expect(joined.stderr.trimEnd().split("\n").at(-1), "join ended because the sign-in was turned down, not because something broke").toBe("nexus-agent: The owner denied this sign-in.");
    expect(joined.stdout, "scribe was given nothing").toBe("");
    expect(server.approvalsHeld()).toBe(0);
  }, 60_000);
});
