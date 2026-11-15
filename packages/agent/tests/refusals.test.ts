// An agent that is given the wrong thing is refused in plain words, and nothing is written: a wrong private key, an approval with a
// byte flipped, an approval sealed with another vault key, an approval for another vault, a server with no vault, a token Nexus does
// not know. No message, and nothing else the library says or throws, holds any piece of a key, an approval or a token.

import { generateDeviceKeyPair, generateVaultKey, sealApproval } from "@nexus/crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { nexusNotes } from "../../../plugin/tests/world";
import { decodeBase64, encodeBase64 } from "../src/base64";
import { AgentVault, type AgentErrorCode } from "../src/index";
import { ADDRESS, agentCredentials, fetchOverNexus, openWorld, setUpVault, type AgentCredentials, type World } from "./world";

let world: World;
let credentials: AgentCredentials;

beforeEach(async () => {
  world = await openWorld();
  await setUpVault(world);
  // The vault already holds a note, so a key that opens nothing can be told from a vault that is empty.
  await world.elsewhere.create("Existing/note.md", "a note that was here first\n");
  credentials = await agentCredentials(world);
});

/** Every way a secret could be written into a message: as given, as hex, and every piece of 8 characters or more of its base64. */
function shapesOf(secret: string): string[] {
  const bytes = decodeBase64(secret);
  const shapes = [secret, secret.replace(/=+$/, "")];
  if (bytes !== null) shapes.push(Buffer.from(bytes).toString("hex"));
  for (let at = 0; at + 8 <= secret.length; at += 4) shapes.push(secret.slice(at, at + 8));
  return shapes;
}

/** Tries to open a vault with `given`, and answers what it refused with: the error, its text in every shape, and the calls made. */
async function refusedWith(given: Partial<AgentCredentials>, secrets: string[]): Promise<{ code: AgentErrorCode; message: string }> {
  const { fetch, seen } = fetchOverNexus();
  const options = { ...credentials, ...given, fetch };
  let error: unknown;
  try {
    (await AgentVault.open(options)).close();
  } catch (caught) {
    error = caught;
  }
  expect(error, "opening was refused").toBeDefined();
  const { name, code, message, stack } = error as { name: string; code: AgentErrorCode; message: string; stack: string };
  expect(name).toBe("AgentError");
  const everything = [name, code, message, stack, JSON.stringify(error)].join("\n");
  for (const secret of secrets) {
    for (const shape of shapesOf(secret)) expect(everything, `the refusal holds ${shape.slice(0, 4)}...`).not.toContain(shape);
  }
  expect(seen.filter((s) => s.method !== "GET"), "nothing was written").toEqual([]);
  expect(Object.keys(await nexusNotes(world)), "the vault holds just the note it had").toHaveLength(1);
  return { code, message };
}

const SECRETS = () => [credentials.privateKey, credentials.approval, credentials.token, encodeBase64(world.keys.vaultKey)];

describe("an agent that is given the wrong thing", () => {
  it("is refused when its private key is not the one the approval was sealed to", async () => {
    const other = await generateDeviceKeyPair();
    const refused = await refusedWith({ privateKey: encodeBase64(other.privateKey) }, [...SECRETS(), encodeBase64(other.privateKey)]);
    expect(refused.code).toBe("bad-approval");
    expect(refused.message).toMatch(/could not be opened with this private key/);
  });

  it("is refused when any one byte of the approval is flipped", async () => {
    const approval = decodeBase64(credentials.approval)!;
    for (let at = 0; at < approval.length; at++) {
      const flipped = approval.slice();
      flipped[at] = flipped[at]! ^ 1;
      const refused = await refusedWith({ approval: encodeBase64(flipped) }, SECRETS());
      expect(refused.code, `byte ${at}`).toBe("bad-approval");
    }
  });

  it("is refused when the approval is cut short, empty, or not base64", async () => {
    const approval = decodeBase64(credentials.approval)!;
    expect((await refusedWith({ approval: encodeBase64(approval.slice(0, 40)) }, SECRETS())).code).toBe("bad-approval");
    expect((await refusedWith({ approval: "" }, SECRETS())).code).toBe("bad-settings");
    expect((await refusedWith({ approval: "not base64 at all!" }, SECRETS())).code).toBe("bad-settings");
  });

  it("is refused when the approval holds another vault key, though it opens: the key opens none of the notes", async () => {
    const pair = await generateDeviceKeyPair();
    const wrongKey = await generateVaultKey();
    const approval = encodeBase64(await sealApproval(pair.publicKey, wrongKey, { vaultId: world.keys.vaultId, kid: world.keys.kid }));
    const refused = await refusedWith({ privateKey: encodeBase64(pair.privateKey), approval }, [...SECRETS(), encodeBase64(pair.privateKey), approval, encodeBase64(wrongKey)]);
    expect(refused.code).toBe("wrong-key");
    expect(refused.message).toMatch(/opens none of the notes/);
  });

  it("is refused when the approval is for another vault than the one the server holds", async () => {
    const pair = await generateDeviceKeyPair();
    const approval = encodeBase64(await sealApproval(pair.publicKey, world.keys.vaultKey, { vaultId: "some-other-vault", kid: world.keys.kid }));
    const refused = await refusedWith({ privateKey: encodeBase64(pair.privateKey), approval }, [...SECRETS(), encodeBase64(pair.privateKey), approval]);
    expect(refused.code).toBe("wrong-vault");
    expect(refused.message).toMatch(/different vault/);
  });

  it("is refused by a server that holds no vault yet", async () => {
    const empty = await openWorld();
    const pair = await generateDeviceKeyPair();
    const approval = encodeBase64(await sealApproval(pair.publicKey, world.keys.vaultKey, { vaultId: world.keys.vaultId, kid: world.keys.kid }));
    const token = await empty.tokenFor("agents", "agent on an empty server");
    const refused = await refusedWith({ token, privateKey: encodeBase64(pair.privateKey), approval }, [...SECRETS(), token, approval]);
    expect(refused.code).toBe("wrong-vault");
    expect(refused.message).toMatch(/no vault yet/);
  });

  it("is refused with Nexus's own words when its token is not one Nexus knows, and the token is not in them", async () => {
    const refused = await refusedWith({ token: "nx_not_a_token_nexus_made_0123456789" }, [...SECRETS(), "nx_not_a_token_nexus_made_0123456789"]);
    expect(refused.code).toBe("refused");
    expect(refused.message).toMatch(/did not accept the agent's sign-in token/);
  });

  it("is refused before any call when the address or the token is missing or is not what it should be", async () => {
    const { fetch, seen } = fetchOverNexus();
    for (const [what, options] of [
      ["no address", { address: "" }],
      ["an address that is not a web address", { address: "nexus.example.test/nexus/api" }],
      ["an address that is not http", { address: "ftp://nexus.example.test/nexus/api" }],
      ["no token", { token: "  " }],
      ["a private key of the wrong length", { privateKey: encodeBase64(new Uint8Array(31)) }],
    ] as const) {
      await expect(AgentVault.open({ ...credentials, ...options, fetch }), what).rejects.toMatchObject({ name: "AgentError", code: "bad-settings" });
    }
    expect(seen, "no call was made").toEqual([]);
  });

  it("says Nexus could not be reached, not what it was sending, when the network fails", async () => {
    const down = async () => {
      throw new Error(`connect ECONNREFUSED while sending ${credentials.token}`);
    };
    const error = await AgentVault.open({ ...credentials, address: ADDRESS, fetch: down }).catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ name: "AgentError", code: "unreachable" });
    expect((error as Error).message).not.toContain(credentials.token);
  });

  it("opens with the right things, so the refusals above are the doing of what was wrong", async () => {
    const { fetch } = fetchOverNexus();
    const vault = await AgentVault.open({ ...credentials, fetch });
    expect(await vault.list()).toEqual(["Existing/note.md"]);
    vault.close();
  });
});
