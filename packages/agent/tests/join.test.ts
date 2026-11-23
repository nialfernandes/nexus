// `nexus-agent join <name>`, run for real over the real server code (world.ts): the agent makes its key pair and starts a device sign-in
// with the public half, prints the agent code and the sign-in code and waits; the owner's device (played here the way the plugin's
// approving device does it: it asks Nexus which sign-ins wait, seals the vault key to the key Nexus lists for this one, and allows the
// sign-in with the sealed key) gives it the key; and join ends with the four values the other commands read, on standard output only.
//
// What the test checks about the owner's side is only what the server sees: the plugin's own approving device, and the board that asks
// the owner for the agent code, are in plugin/tests/agent-join-worked-example.test.ts.

import { deviceKeyCode, generateDeviceKeyPair, sealApproval } from "@nexus/crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64 } from "../src/base64";
import { ENV } from "../src/cli/labels";
import { ADDRESS, askNexus, bodyOf, fetchOverNexus, openWorld, run, setUpVault, timesIn, type Ran, type World } from "./world";

let world: World;
let fetched: ReturnType<typeof fetchOverNexus>;

beforeEach(async () => {
  world = await openWorld();
  fetched = fetchOverNexus();
  // The identity the page makes when the owner adds an agent by name.
  bodyOf(await askNexus("POST", "identity", { cookie: world.ownerCookie }, { name: "scribe", kind: "agent" }));
});

const ownerCall = (method: string, route: string, body?: unknown) => askNexus(method, route, { cookie: world.ownerCookie }, body);

/** The sign-in code `join` printed. */
const signInCodeIn = (stderr: string): string | undefined => /sign-in code: ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(stderr)?.[1];

/** The owner's device: finds the waiting sign-in by the code `join` printed, and allows it with whatever `approval` makes of the key Nexus lists for it. */
function owners(approval: ((deviceKey: Uint8Array) => Promise<{ approval: string; approverKey: string } | undefined>) | "key"): (printed: { stderr: string }) => Promise<void> {
  let answered = false;
  return async (printed) => {
    const code = signInCodeIn(printed.stderr);
    if (answered || code === undefined) return;
    answered = true;
    const listed = bodyOf(await ownerCall("GET", "device/waiting")).signins as Array<{ code: string; label: string; deviceKey: string | null }>;
    const entry = listed.find((signin) => signin.code === code)!;
    const sealedFor = async (deviceKey: Uint8Array) => {
      const sealed = await sealApproval(deviceKey, world.keys.vaultKey, { vaultId: world.keys.vaultId, kid: world.keys.kid });
      const mine = await generateDeviceKeyPair();
      mine.privateKey.fill(0);
      return { approval: encodeBase64(sealed), approverKey: encodeBase64(mine.publicKey) };
    };
    const sealed = approval === "key" ? await sealedFor(decodeBase64(entry.deviceKey!)!) : await approval(decodeBase64(entry.deviceKey!)!);
    bodyOf(await ownerCall("POST", "device/approve", { code, ...sealed }));
  };
}

/** The four values a run printed, as the environment the other commands read. */
function valuesOf(ran: Ran): Record<string, string> {
  return Object.fromEntries(ran.stdout.trimEnd().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

describe("nexus-agent join", () => {
  it("starts the sign-in with the agent's public key, prints its two codes, waits, and ends with the four values on standard output only", async () => {
    await setUpVault(world);
    const ran = await run(["join", "scribe"], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch, onWait: owners("key") });
    expect(ran.code, ran.stderr).toBe(0);

    // The start asked as the identity, under the same name as its label, with a public key and no credential.
    const start = fetched.seen[0]!;
    expect(start).toMatchObject({ method: "POST", route: "device/start", credential: "none", body: { identity: "scribe", label: "scribe" } });
    const deviceKey = decodeBase64(start.body.deviceKey)!;
    expect(deviceKey, "an X25519 public key").toHaveLength(32);

    // It printed the code of that key and the sign-in's code, and said it was waiting, before anything was given.
    expect(ran.stderr).toContain(`agent code: ${await deviceKeyCode(deviceKey)}`);
    expect(signInCodeIn(ran.stderr)).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(ran.stderr).toContain("Waiting for the owner to give scribe the key");
    expect(ran.stderr.indexOf("Waiting for the owner")).toBeLessThan(ran.stderr.indexOf("Done."));

    // Standard output is the four values and nothing else, named as the other commands read them.
    expect(ran.stdout.trimEnd().split("\n").map((line) => line.split("=")[0])).toEqual([ENV.address, ENV.token, ENV.privateKey, ENV.approval]);
    const values = valuesOf(ran);
    expect(values[ENV.address]).toBe(ADDRESS);
    expect(values[ENV.token]).toMatch(/^nx_[0-9a-f]{64}$/);
    expect(decodeBase64(values[ENV.privateKey]!)).toHaveLength(32);
    // None of the secrets is anywhere a person or a log reads.
    for (const secret of [values[ENV.token]!, values[ENV.privateKey]!, values[ENV.approval]!]) {
      expect(timesIn(ran.stderr, secret), "a secret on the error stream").toBe(0);
      expect(timesIn(ran.stdout, secret), "a secret shown more than once").toBe(1);
    }
    expect(ran.stderr).toContain("scribe.env");

    // The token is the identity's, under the label the agent asked with; the sign-in was used once.
    const tokens = bodyOf(await ownerCall("GET", "tokens")).tokens as Array<{ identity: string; label: string }>;
    expect(tokens.find((token) => token.label === "scribe")).toMatchObject({ identity: "scribe" });
  });

  it("gives an agent that reads and writes with exactly those values, and nothing else set", async () => {
    await setUpVault(world);
    const joined = await run(["join", "scribe"], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch, onWait: owners("key") });
    expect(joined.code, joined.stderr).toBe(0);
    const env = valuesOf(joined);

    const text = "# From the agent\n\nWritten with the key it was given.\n";
    const written = await run(["write", "Agent/First.md"], { env, fetch: fetched.fetch, stdin: text });
    expect(written.code, written.stderr).toBe(0);
    const read = await run(["read", "Agent/First.md"], { env, fetch: fetched.fetch });
    expect(read.stdout).toBe(text);
    expect((await run(["list"], { env, fetch: fetched.fetch })).stdout).toBe("Agent/First.md\n");
  });

  it("takes --label for the name the sign-in is listed under", async () => {
    await setUpVault(world);
    const ran = await run(["join", "scribe", "--label", "the lab machine"], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch, onWait: owners("key") });
    expect(ran.code, ran.stderr).toBe(0);
    expect(fetched.seen[0]!.body).toMatchObject({ identity: "scribe", label: "the lab machine" });
  });

  it("stops with nothing printed on standard output when the owner allows the sign-in without giving the key", async () => {
    await setUpVault(world);
    const ran = await run(["join", "scribe"], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch, onWait: owners(async () => undefined) });
    expect(ran.code).toBe(1);
    expect(ran.stdout, "no value is printed").toBe("");
    expect(ran.stderr).toMatch(/did not give it the key/);
  });

  it("stops with nothing printed when the key Nexus hands over does not open with the agent's own key", async () => {
    await setUpVault(world);
    const someoneElse = await generateDeviceKeyPair();
    const ran = await run(["join", "scribe"], {
      env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch,
      onWait: owners(async () => {
        const sealed = await sealApproval(someoneElse.publicKey, world.keys.vaultKey, { vaultId: world.keys.vaultId, kid: world.keys.kid });
        return { approval: encodeBase64(sealed), approverKey: encodeBase64(someoneElse.publicKey) };
      }),
    });
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toMatch(/does not open with this agent's own key/);
  });

  it("says what to do when no name was given, and has Nexus say so when it has no identity of that name", async () => {
    const none = await run(["join"], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch });
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/nexus-agent join <name>/);
    const unknown = await run(["join", "nobody-here"], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/There is no identity called nobody-here/);
    expect(unknown.stdout).toBe("");
    const noAddress = await run(["join", "scribe"], { env: {}, fetch: fetched.fetch });
    expect(noAddress.code).toBe(1);
    expect(noAddress.stderr).toContain(ENV.address);
  });
});
