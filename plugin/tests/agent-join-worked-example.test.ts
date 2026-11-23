// The worked example of an agent joining, over the real server code, the real command and the real plugin:
//
//   The owner's Mac is a first run that holds the vault key and has saved a note. The owner adds the agent `scribe` (the identity the Nexus
//   page makes). On the agent, `nexus-agent join scribe` (the real command, packages/agent) makes its key pair, starts a sign-in with the
//   public key, prints its agent code and sign-in code, and waits. The owner opens Approve a device in the plugin: board 31, "scribe has
//   joined.", and types scribe's agent code into the ten boxes; the plugin works out the code of the key Nexus lists for that sign-in, seals the
//   vault key to it and sends the approval through the approval the plugin already sends when it approves a device. The screen closes, `join`
//   ends with done and the four values on standard output, and scribe, with only those values, reads the note the owner saved, and a note the
//   owner saves after.
//
// Checked besides: no Recovery Key was typed or asked for anywhere; the vault key is on the owner's device and in the sealed approval, and in
// no plaintext on the server or on anything the agent printed; the agent's token is the identity scribe's. Names and codes are made up.

import { generateDeviceKeyPair } from "@nexus/crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV } from "../../packages/agent/src/cli/labels";
import { ADDRESS, fetchOverNexus, run, timesIn } from "../../packages/agent/tests/world";
import { encodeBase64 } from "../src/base64";
import { addAgent, agentCodeIn, environmentOf, screensFor, until, whileWaiting } from "./agent-join-world";
import { firstRun } from "./setup-world";
import { boxes, buttons, installDom, tap, typeInto, words } from "./screens-world";
import { deviceRoutes, everythingStored, forbidFetch, manage, openWorld, type World } from "./world";

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

describe("an agent joins", () => {
  it("scribe joins with one command and is given the key from the plugin by typing its agent code; it then reads the owner's note", async () => {
    forbidFetch();
    // The owner's device holds the vault key and has saved a note.
    const { device: mac } = await firstRun(world, { files: { "Ideas/one.md": "the owner's first note\n" }, name: "Owner's Mac" });
    await mac.engine.sync();
    const vaultKey = mac.holder.keys()!.vaultKey;
    await addAgent(world, "scribe");

    // The agent: `nexus-agent join scribe`. While it waits, the owner uses the plugin.
    const owner = screensFor(mac);
    let seenWhileWaiting = "";
    const agentSide = fetchOverNexus();
    const owners = whileWaiting(async (printed) => {
        if (seenWhileWaiting !== "") return;
        seenWhileWaiting = printed.stderr;
        // join has printed both codes and is waiting, and has printed nothing else on standard output.
        expect(printed.stderr).toMatch(/sign-in code: [0-9A-Z]{4}-[0-9A-Z]{4}/);
        expect(printed.stdout, "no value is printed before the key is given").toBe("");
        const code = agentCodeIn(printed.stderr);

        // The owner opens Approve a device: one sign-in waits, and it is scribe's, so it is board 31.
        await owner.screens.start("approve");
        await until("board 31", () => title(owner.root) === "give the key", () => mac.setup.state);
        expect(words(owner.root)).toEqual([
          "nexus",
          "give the key",
          "scribe has joined.",
          "Type scribe's code here to give it the key.",
          "Agent code",
          "This makes sure the key goes to scribe and no one else.",
          "Cancel",
        ]);
        expect(boxes(owner.root, "device")).toHaveLength(10);
        expect(buttons(owner.root), "there is no Recovery Key box and no Give button").toEqual(["Cancel"]);
        expect(mac.log.to("POST device/approve"), "nothing is sent before the code is typed").toEqual([]);

        // The code is typed (small letters count), the tenth character checks it, and the screen closes.
        typeInto(owner.root, "device", code.toLowerCase());
        await until("the screen closes", () => owner.closed() === 1, () => mac.setup.state);
    });
    const joined = await run(["join", "scribe"], { env: { [ENV.address]: ADDRESS }, fetch: agentSide.fetch, onWait: owners.onWait });
    owners.check();

    expect(joined.code, joined.stderr).toBe(0);
    expect(joined.stderr).toContain("Done. scribe has joined and holds the key.");
    expect(mac.setup.state, "the owner's device is back to unlocked").toEqual({ step: "unlocked" });
    expect(mac.log.to("POST device/approve"), "one approval was sent").toHaveLength(1);
    const approval = mac.log.to("POST device/approve")[0]!.body;
    expect(Object.keys(approval).sort(), "the sign-in's code, the sealed key and the approving device's public key").toEqual(["approval", "approverKey", "code"]);

    // The four values scribe was given are the whole of its setup.
    const env = environmentOf(joined.stdout);
    expect(Object.keys(env)).toEqual([ENV.address, ENV.token, ENV.privateKey, ENV.approval]);
    expect(env[ENV.approval], "the approval the agent printed is the one the plugin sent").toBe(approval.approval);

    // The vault key left the owner's device only sealed to the agent's key: it is in no plaintext, on the server or in what the agent printed.
    const keyText = encodeBase64(vaultKey);
    expect(timesIn(everythingStored(), keyText), "not on the server").toBe(0);
    expect(timesIn(joined.stdout + joined.stderr, keyText), "not in anything join printed").toBe(0);

    // scribe reads the note the owner saved, with nothing but those values.
    const read = await run(["read", "Ideas/one.md"], { env, fetch: fetchOverNexus().fetch });
    expect(read.code, read.stderr).toBe(0);
    expect(read.stdout).toBe("the owner's first note\n");
    // And a note the owner saves after it joined.
    mac.vault.type("Ideas/two.md", "saved after scribe joined\n");
    await mac.engine.push("Ideas/two.md");
    expect((await run(["read", "Ideas/two.md"], { env, fetch: fetchOverNexus().fetch })).stdout).toBe("saved after scribe joined\n");

    // The token is scribe's, as the identity the owner added.
    const tokens = (await manage({ cookie: world.ownerCookie }).tokens()).body.tokens as Array<{ identity: string; label: string }>;
    expect(tokens.find((token) => token.label === "scribe")).toMatchObject({ identity: "scribe" });
  }, 60_000);

  it("lists an agent and a phone that wait together by name, and each is drawn as what it is when picked", async () => {
    forbidFetch();
    const { device: mac } = await firstRun(world, { name: "Owner's Mac" });
    await addAgent(world, "scribe");
    // Two sign-ins wait, each with a public key: a phone, signed in as the owner, and scribe (a sign-in starts with no credential).
    const keyOf = async () => encodeBase64((await generateDeviceKeyPair()).publicKey);
    const asking = deviceRoutes(null);
    expect((await asking.start(world.user, "Work phone", await keyOf())).status).toBe(200);
    expect((await asking.start("scribe", "scribe", await keyOf())).status).toBe(200);

    const first = screensFor(mac);
    await first.screens.start("approve");
    await until("the list", () => title(first.root) === "approve device", () => mac.setup.state);
    expect(words(first.root)).toEqual(expect.arrayContaining(["Which device?", "Work phone", "scribe"]));
    const waiting = (mac.setup.state as { devices: Array<{ label: string; signInCode: string; agent?: boolean }> }).devices;
    // Both started in the same millisecond, so Nexus lists them in the order of their random codes: each is found by its label.
    const named = (label: string) => waiting.find((entry) => entry.label === label)!;
    expect(waiting.map((entry) => [entry.label, entry.agent === true]).sort(), "only scribe says it is an agent").toEqual([["Work phone", false], ["scribe", true]]);

    tap(first.root, `device:${named("scribe").signInCode}`);
    expect(title(first.root), "scribe is the key being given").toBe("give the key");
    expect(words(first.root)).toContain("scribe has joined.");
    tap(first.root, "cancel");
    expect(mac.setup.state).toEqual({ step: "unlocked" });
    first.screens.dispose();

    const second = screensFor(mac);
    await second.screens.start("approve");
    await until("the list again", () => title(second.root) === "approve device", () => mac.setup.state);
    tap(second.root, `device:${named("Work phone").signInCode}`);
    expect(title(second.root), "the phone is an approved device").toBe("approve device");
    expect(words(second.root)).toContain("Work phone");
    expect(words(second.root)).not.toContain("give the key");
  }, 30_000);
});
