// The worked example, as one test against the real server code: `create-vault` on an empty server, `keygen`, `approve-agent` with the
// Recovery Key and the agent's public key, then the library, with that private key and approval, writes `Agent/2026-11-15 First.md`.
// The plugin's sync engine, unlocked with the same vault key (the one a device gets from the Recovery Key), syncs and shows that note
// with the same text; the plugin edits it and the agent reads the edit.
//
// Every output of every command is kept and searched afterwards: the Recovery Key is in the one line made to show it, the private key
// in the one line of `keygen`, the approval in the one line of `approve-agent`, and none of them is in any argument or any other output.

import { parseRecoveryKey, unwrapVaultKeyWithRecoveryKey } from "@nexus/crypto";
import { describe, expect, it } from "vitest";
import { makeDevice, nexusTexts, TestUnlock } from "../../../plugin/tests/world";
import { decodeBase64, encodeBase64 } from "../src/base64";
import { ENV, LABEL } from "../src/cli/labels";
import { AgentVault } from "../src/index";
import { ADDRESS, askNexus, bodyOf, fetchOverNexus, openWorld, run, timesIn, valueOf, type Ran } from "./world";

const PATH = "Agent/2026-11-15 First.md";
const TEXT = "# First\n\nThe agent's first note, written with its own key.\n";
const EDIT = `${TEXT}\nAn edit made in the plugin.\n`;

describe("the worked example", () => {
  it("sets up a vault, approves an agent, and the agent and the plugin share a note", async () => {
    const world = await openWorld();
    const { fetch, seen } = fetchOverNexus();
    const ownerToken = await world.tokenFor(world.user, "the owner's terminal");
    const ownerEnv = { [ENV.address]: ADDRESS, [ENV.token]: ownerToken };
    const everyRun: Array<{ argv: string[]; ran: Ran }> = [];
    const record = async (argv: string[], options: Parameters<typeof run>[1]): Promise<Ran> => {
      const ran = await run(argv, { fetch, ...options });
      everyRun.push({ argv, ran });
      return ran;
    };

    // 1. create-vault, on a server that has none: the person writes the key down, and types the check characters back.
    expect(bodyOf(await askNexus("GET", "wraps", { cookie: world.ownerCookie }))).toEqual({ vaultId: null, wraps: [] });
    let typed = false;
    const created = await record(["create-vault"], {
      env: ownerEnv, screen: true,
      reply: (printed) => {
        if (typed || !printed.stderr.endsWith("(the last group): ")) return undefined;
        typed = true;
        return `${valueOf(printed.stdout, LABEL.recoveryKey)!.split("-").at(-1)}\n`;
      },
    });
    expect(created.code, created.stderr).toBe(0);
    const recoveryKeyText = valueOf(created.stdout, LABEL.recoveryKey)!;
    const vaultId = valueOf(created.stdout, LABEL.vaultId)!;

    // 2. keygen: the agent's key pair, made by the person.
    const generated = await record(["keygen"], {});
    expect(generated.code).toBe(0);
    const privateKey = valueOf(generated.stdout, LABEL.privateKey)!;
    const publicKey = valueOf(generated.stdout, LABEL.publicKey)!;

    // 3. approve-agent: the Recovery Key at the prompt and the public key pasted. It prints the sealed approval.
    const approved = await record(["approve-agent"], { env: ownerEnv, stdin: `${publicKey}\n${recoveryKeyText}\n` });
    expect(approved.code, approved.stderr).toBe(0);
    const approval = valueOf(approved.stdout, LABEL.approval)!;

    // 4. the agent: signed in as its own identity, with its own key and approval, writes a note.
    const agentToken = await world.tokenFor("agents", "the agent in the worked example");
    const agent = await AgentVault.open({ address: ADDRESS, token: agentToken, privateKey, approval, fetch, now: () => new Date(Date.UTC(2026, 10, 15, 12)) });
    expect(agent.vaultId).toBe(vaultId);
    expect(await agent.write(PATH, TEXT)).toMatchObject({ path: PATH, version: 1, saved: true });

    // 5. the plugin, unlocked with the vault key a device gets from the Recovery Key and the vault id the server holds, syncs and shows it.
    const held = bodyOf(await askNexus("GET", "wraps", { cookie: world.ownerCookie }));
    expect(held.vaultId).toBe(vaultId);
    const recovery = held.wraps.find((wrap: { kind: string }) => wrap.kind === "recovery");
    const vaultKey = await unwrapVaultKeyWithRecoveryKey(await parseRecoveryKey(recoveryKeyText), decodeBase64(recovery.wrap)!, { vaultId: held.vaultId, kid: recovery.kid });
    const device = await makeDevice(world, { unlock: new TestUnlock({ vaultKey, vaultId: held.vaultId, kid: recovery.kid }) });
    await device.engine.sync();
    expect(device.vault.textOf(PATH), "the plugin shows the agent's note with the same text").toBe(TEXT);
    expect(device.vault.texts()).toEqual({ [PATH]: TEXT });

    // 6. the plugin edits it, and the agent reads the edit.
    device.vault.type(PATH, EDIT);
    await device.engine.push(PATH);
    expect(await agent.read(PATH)).toBe(EDIT);
    expect(await agent.list()).toEqual([PATH]);
    agent.close();

    // What the server holds opens only with the key from the Recovery Key: not with anything the world made on its own.
    expect(await nexusTexts({ ...world, keys: { vaultKey, vaultId: held.vaultId, kid: recovery.kid } })).toEqual({ [PATH]: EDIT });

    // ── the search: every output, every argument ─────────────────────────────
    const outputs = everyRun.map(({ ran }) => ran.stdout + ran.stderr).join("\n--\n");
    const argvs = everyRun.map(({ argv }) => argv.join(" ")).join("\n");
    const secrets = { recoveryKey: recoveryKeyText, privateKey, approval, vaultKey: encodeBase64(vaultKey), token: agentToken };
    for (const [name, secret] of Object.entries(secrets)) {
      expect(timesIn(argvs, secret), `${name} is in no argument`).toBe(0);
      expect(timesIn(JSON.stringify(seen), secret), `${name} is in no body or address sent to Nexus`).toBe(0);
    }
    expect(timesIn(outputs, recoveryKeyText), "the Recovery Key is in the one line made to show it").toBe(1);
    expect(created.stdout.split("\n").filter((line) => timesIn(line, recoveryKeyText) > 0)).toEqual([`${LABEL.recoveryKey}: ${recoveryKeyText}`]);
    expect(timesIn(outputs, privateKey), "the private key is on keygen's one line").toBe(1);
    expect(generated.stdout.split("\n").filter((line) => timesIn(line, privateKey) > 0)).toEqual([`${LABEL.privateKey}: ${privateKey}`]);
    expect(timesIn(outputs, approval), "the approval is on approve-agent's one line").toBe(1);
    expect(timesIn(outputs, encodeBase64(vaultKey)), "the vault key is in no output").toBe(0);
    expect(timesIn(outputs, agentToken), "the agent's token is in no output of these commands").toBe(0);
    // Nexus was sent the wrap and the agent's one save, and never the key the wrap is made from.
    expect(seen.filter((s) => s.method === "POST").map((s) => s.route)).toEqual(["wrap", "save"]);
  });
});
