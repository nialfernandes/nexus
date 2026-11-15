// The nexus-agent command, run for real over the real server code (world.ts): the same `main` the built command runs, over streams the
// test keeps. Every output of every command is searched for the keys: a Recovery Key or a private key is in the one line meant to
// show it and in no other, and no key is ever an argument.

import { deviceKeyCode, devicePublicKey, generateDeviceKeyPair, generateRecoveryKey, formatRecoveryKey, unwrapVaultKeyWithRecoveryKey, parseRecoveryKey } from "@nexus/crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64 } from "../src/base64";
import { ENV, LABEL } from "../src/cli/labels";
import { AgentVault } from "../src/index";
import {
  ADDRESS, agentCredentials, askNexus, bodyOf, fetchOverNexus, openWorld, run, setUpVault, shapesOf, timesIn, valueOf,
  type AgentCredentials, type SetUp, type World,
} from "./world";

let world: World;
let owner: string;
let fetched: ReturnType<typeof fetchOverNexus>;

beforeEach(async () => {
  world = await openWorld();
  owner = await world.tokenFor(world.user, "the owner's terminal");
  fetched = fetchOverNexus();
});

const ownerEnv = () => ({ [ENV.address]: ADDRESS, [ENV.token]: owner });
const wrapsOnServer = async () => bodyOf(await askNexus("GET", "wraps", { cookie: world.ownerCookie }));
const posts = () => fetched.seen.filter((s) => s.method === "POST");

/** The last group of the Recovery Key a run printed: the check characters create-vault asks for. */
const checkGroupOf = (stdout: string): string => valueOf(stdout, LABEL.recoveryKey)!.split("-").at(-1)!;

/** create-vault, answering the question the way a person who has written the key down does. */
const createVault = (typedBack: (printed: { stdout: string; stderr: string }) => string, extra: Partial<Parameters<typeof run>[1]> = {}) => {
  let answered = 0;
  return run(["create-vault"], {
    env: ownerEnv(), screen: true, fetch: fetched.fetch,
    reply: (printed) => {
      if (printed.stderr.endsWith("(the last group): ") && answered === (printed.stderr.match(/\(the last group\): /g) ?? []).length - 1) {
        answered++;
        return `${typedBack(printed)}\n`;
      }
      return undefined;
    },
    ...extra,
  });
};

describe("nexus-agent keygen", () => {
  it("prints the private key, the public key and its code, each on its own labelled line, and nothing goes to the server", async () => {
    const ran = await run(["keygen"], { fetch: fetched.fetch });
    expect(ran.code).toBe(0);
    expect(ran.stdout.trimEnd().split("\n").map((line) => line.split(": ")[0])).toEqual([LABEL.privateKey, LABEL.publicKey, LABEL.publicKeyCode]);
    const privateKey = decodeBase64(valueOf(ran.stdout, LABEL.privateKey)!)!;
    const publicKey = decodeBase64(valueOf(ran.stdout, LABEL.publicKey)!)!;
    expect(privateKey).toHaveLength(32);
    expect(Buffer.from(await devicePublicKey(privateKey)).toString("hex"), "the public half belongs to the private half").toBe(Buffer.from(publicKey).toString("hex"));
    expect(valueOf(ran.stdout, LABEL.publicKeyCode)).toBe(await deviceKeyCode(publicKey));
    expect(fetched.seen, "no call to Nexus").toEqual([]);
    expect(timesIn(ran.stderr, valueOf(ran.stdout, LABEL.privateKey)!), "the private key is on stdout only").toBe(0);
  });

  it("makes a new pair each time", async () => {
    const [a, b] = [await run(["keygen"]), await run(["keygen"])];
    expect(valueOf(a.stdout, LABEL.privateKey)).not.toBe(valueOf(b.stdout, LABEL.privateKey));
  });
});

describe("nexus-agent create-vault", () => {
  it("sets up a server with no vault: shows the Recovery Key once, asks for the check characters, then keeps the wrap and the vault id", async () => {
    const ran = await createVault((printed) => checkGroupOf(printed.stdout));
    expect(ran.code, ran.stderr).toBe(0);

    const kept = await wrapsOnServer();
    const vaultId = valueOf(ran.stdout, LABEL.vaultId)!;
    expect(kept.vaultId, "the server holds the vault id the command printed").toBe(vaultId);
    expect(kept.wraps).toHaveLength(1);
    expect(kept.wraps[0]).toMatchObject({ kid: 1, kind: "recovery" });
    expect(posts().map((s) => s.route), "one post, and it came last").toEqual(["wrap"]);
    expect(posts()[0]!.body).toMatchObject({ kid: 1, kind: "recovery", vaultId });

    // The Recovery Key opens the wrap, with the vault id the server holds: all a device that has only the key needs.
    const recoveryKey = await parseRecoveryKey(valueOf(ran.stdout, LABEL.recoveryKey)!);
    const vaultKey = await unwrapVaultKeyWithRecoveryKey(recoveryKey, decodeBase64(kept.wraps[0].wrap)!, { vaultId: kept.vaultId, kid: 1 });
    expect(vaultKey).toHaveLength(32);

    const keyText = valueOf(ran.stdout, LABEL.recoveryKey)!;
    expect(timesIn(ran.stdout, keyText), "the Recovery Key is on its one line").toBe(1);
    expect(timesIn(ran.stderr, keyText), "and nowhere on the error stream").toBe(0);
    expect(timesIn(ran.stdout + ran.stderr, encodeBase64(vaultKey)), "the vault key is shown nowhere").toBe(0);
    expect(timesIn(JSON.stringify(fetched.seen), keyText), "the key was not sent to the server").toBe(0);
  });

  it("takes the check characters in capitals or small letters, with spaces, and O for 0 as the key does", async () => {
    const ran = await createVault((printed) => ` ${checkGroupOf(printed.stdout).toLowerCase().replace(/0/g, "o")} `);
    expect(ran.code, ran.stderr).toBe(0);
  });

  it("is refused, and sends nothing, when the check characters are not typed back (three tries, and none right)", async () => {
    const ran = await createVault(() => "ZZZZ");
    expect(ran.code).toBe(1);
    expect(ran.stderr.match(/Those are not the last four characters/g)).toHaveLength(3);
    expect(ran.stderr).toMatch(/nothing was sent/i);
    expect(posts(), "nothing was posted").toEqual([]);
    expect(await wrapsOnServer()).toEqual({ vaultId: null, wraps: [] });
    expect(timesIn(ran.stdout, valueOf(ran.stdout, LABEL.recoveryKey)!), "the key was shown once, to be written down").toBe(1);
  });

  it("is refused, and sends nothing, when the input ends before the check characters are typed", async () => {
    const ran = await run(["create-vault"], { env: ownerEnv(), screen: true, fetch: fetched.fetch, stdin: "" });
    expect(ran.code).toBe(1);
    expect(posts()).toEqual([]);
    expect(await wrapsOnServer()).toEqual({ vaultId: null, wraps: [] });
  });

  it("lets a typo be put right, within three tries", async () => {
    let tries = 0;
    const ran = await createVault((printed) => (++tries < 3 ? "ZZZZ" : checkGroupOf(printed.stdout)));
    expect(ran.code, ran.stderr).toBe(0);
    expect((await wrapsOnServer()).wraps).toHaveLength(1);
  });

  it("is refused by a server that already has a wrap, before any key is shown, and changes nothing", async () => {
    const existing: SetUp = await setUpVault(world);
    const before = await wrapsOnServer();
    const ran = await createVault(() => "ZZZZ");
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/already holds a vault/);
    expect(ran.stdout, "no Recovery Key was shown").not.toContain(LABEL.recoveryKey);
    expect(posts()).toEqual([]);
    expect(await wrapsOnServer(), "the wrap and the vault id are as they were").toEqual(before);
    expect(timesIn(ran.stdout + ran.stderr, existing.recoveryKeyText)).toBe(0);
  });

  it("is refused by a server that holds a vault id with no wrap left, since the notes belong to that vault", async () => {
    await setUpVault(world);
    bodyOf(await askNexus("POST", "wrap/delete", { cookie: world.ownerCookie }, { kid: world.keys.kid, kind: "recovery" }));
    const ran = await createVault(() => "ZZZZ");
    expect(ran.code).toBe(1);
    expect(ran.stdout).not.toContain(LABEL.recoveryKey);
    expect(posts()).toEqual([]);
  });

  it("is refused, before any key is shown, with a token that is not the owner's", async () => {
    const ran = await createVault(() => "ZZZZ", { env: { ...ownerEnv(), [ENV.token]: await world.tokenFor("agents", "not the owner") } });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/not the owner's/);
    expect(ran.stdout).not.toContain(LABEL.recoveryKey);
    expect(posts()).toEqual([]);
  });

  it("shows the key on a screen only: piped or redirected, it stops before it makes one", async () => {
    const ran = await run(["create-vault"], { env: ownerEnv(), screen: false, fetch: fetched.fetch });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/on this terminal only/);
    expect(ran.stdout).toBe("");
    expect(fetched.seen, "it asked nothing of Nexus").toEqual([]);
  });

  it("names the settings it is missing", async () => {
    const ran = await run(["create-vault"], { env: {}, screen: true });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain(ENV.address);
    expect(ran.stderr).toContain(ENV.token);
  });
});

describe("nexus-agent approve-agent", () => {
  let vault: SetUp;
  let pair: { publicKey: string; privateKey: string };

  beforeEach(async () => {
    vault = await setUpVault(world);
    const made = await generateDeviceKeyPair();
    pair = { publicKey: encodeBase64(made.publicKey), privateKey: encodeBase64(made.privateKey) };
  });

  const approve = (recoveryKeyText: string, publicKey = pair.publicKey, extra: Partial<Parameters<typeof run>[1]> = {}) =>
    run(["approve-agent"], { env: ownerEnv(), stdin: `${publicKey}\n${recoveryKeyText}\n`, fetch: fetched.fetch, ...extra });

  it("seals the vault key to the agent's public key and prints the approval, which the agent opens", async () => {
    const ran = await approve(vault.recoveryKeyText);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout.trimEnd().split("\n"), "one line, the approval").toHaveLength(1);
    const approval = valueOf(ran.stdout, LABEL.approval)!;
    expect(decodeBase64(approval)!.length).toBeGreaterThan(48);
    expect(posts(), "it only reads: the server is told nothing").toEqual([]);

    const token = await world.tokenFor("agents", "approved agent");
    const agent = await AgentVault.open({ address: ADDRESS, token, privateKey: pair.privateKey, approval, fetch: fetched.fetch });
    expect(agent.vaultId).toBe(world.keys.vaultId);
    await world.elsewhere.create("Shared/note.md", "written with the vault key\n");
    expect(await agent.read("Shared/note.md"), "the key in the approval is the vault's").toBe("written with the vault key\n");
    agent.close();
  });

  it("shows the code of the public key it was given, to be compared with the one keygen printed", async () => {
    const ran = await approve(vault.recoveryKeyText);
    expect(ran.stderr).toContain(await deviceKeyCode(decodeBase64(pair.publicKey)!));
  });

  it("takes the Recovery Key in small letters and without its hyphens", async () => {
    expect((await approve(vault.recoveryKeyText.replace(/-/g, "").toLowerCase())).code).toBe(0);
  });

  it("never echoes the Recovery Key, the vault key or the private key, and never takes one as an argument", async () => {
    const ran = await approve(vault.recoveryKeyText);
    for (const secret of [vault.recoveryKeyText, encodeBase64(world.keys.vaultKey), pair.privateKey]) {
      expect(timesIn(ran.stdout + ran.stderr, secret), "in no output").toBe(0);
    }
    const asArgument = await run(["approve-agent", vault.recoveryKeyText], { env: ownerEnv(), stdin: `${pair.publicKey}\n${vault.recoveryKeyText}\n`, fetch: fetched.fetch });
    expect(asArgument.code).toBe(1);
    expect(asArgument.stdout).toBe("");
    expect(timesIn(asArgument.stdout + asArgument.stderr, vault.recoveryKeyText), "a key given as an argument is refused, and not repeated").toBe(0);
    expect(fetched.seen.filter((s) => s.method === "POST")).toEqual([]);
  });

  it("is refused, and prints no approval, for a Recovery Key that is not this vault's", async () => {
    const other = await formatRecoveryKey(await generateRecoveryKey());
    const ran = await approve(other);
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toMatch(/does not open this vault's Recovery wrap/);
    expect(timesIn(ran.stdout + ran.stderr, other)).toBe(0);
  });

  it("is refused for a Recovery Key with a character mistyped, or cut short, or blank", async () => {
    const flipped = vault.recoveryKeyText.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    for (const [what, text] of [["a mistyped character", flipped], ["a key cut short", vault.recoveryKeyText.slice(0, 30)], ["a blank line", ""], ["words", "correct horse battery staple"]] as const) {
      const ran = await approve(text);
      expect(ran.code, what).toBe(1);
      expect(ran.stdout, what).toBe("");
    }
  });

  it("is refused for a public key that is not a key, and makes no approval", async () => {
    for (const bad of ["", "not base64!", encodeBase64(new Uint8Array(31)), encodeBase64(new Uint8Array(33))]) {
      const ran = await approve(vault.recoveryKeyText, bad);
      expect(ran.code, JSON.stringify(bad)).toBe(1);
      expect(ran.stdout).toBe("");
    }
  });

  it("is refused by a server that holds no vault, saying to set one up", async () => {
    const empty = await openWorld();
    const token = await empty.tokenFor(empty.user, "owner on an empty server");
    const ran = await approve(vault.recoveryKeyText, pair.publicKey, { env: { [ENV.address]: ADDRESS, [ENV.token]: token } });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/create-vault/);
    expect(ran.stdout).toBe("");
  });

  it("uses the newest Recovery wrap's key number and its vault id, so the agent's approval says which vault key it holds", async () => {
    const ran = await approve(vault.recoveryKeyText);
    const token = await world.tokenFor("agents", "kid check");
    const agent = await AgentVault.open({ address: ADDRESS, token, privateKey: pair.privateKey, approval: valueOf(ran.stdout, LABEL.approval)!, fetch: fetched.fetch });
    expect(agent.kid).toBe(world.keys.kid);
    agent.close();
  });
});

describe("nexus-agent sign-in", () => {
  /** Allows the sign-in the command has started, as the owner on the approval page does. */
  const allowing = async (printed: { stderr: string }) => {
    const code = /code: ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(printed.stderr)?.[1];
    if (code !== undefined) bodyOf(await askNexus("POST", "device/approve", { cookie: world.ownerCookie }, { code }));
  };

  it("starts the device sign-in, waits while the owner allows it, and prints the token once", async () => {
    const ran = await run(["sign-in", "--identity", "agents", "--label", "lab-agent"], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch, onWait: allowing });
    expect(ran.code, ran.stderr).toBe(0);
    const token = valueOf(ran.stdout, LABEL.token)!;
    expect(token).toMatch(/^nx_[0-9a-f]{64}$/);
    expect(ran.stdout.trimEnd().split("\n"), "one line").toHaveLength(1);
    expect(timesIn(ran.stderr, token), "the token is on stdout only").toBe(0);
    expect(ran.stderr).toContain("/nexus/approve?code=");
    // The token works, as the identity, and it is listed under the label the command gave.
    const listed = bodyOf(await askNexus("GET", "list", { bearer: token }));
    expect(listed).toEqual({ notes: [] });
    const tokens = bodyOf(await askNexus("GET", "tokens", { cookie: world.ownerCookie })).tokens as Array<{ identity: string; label: string }>;
    expect(tokens.find((t) => t.label === "lab-agent")).toMatchObject({ identity: "agents" });
    // The start sent no key and no credential.
    expect(fetched.seen[0]).toMatchObject({ method: "POST", route: "device/start", body: { identity: "agents", label: "lab-agent" } });
  });

  it("takes --identity=name, and a label of its own when none is given", async () => {
    const ran = await run(["sign-in", "--identity=agents"], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch, onWait: allowing });
    expect(ran.code, ran.stderr).toBe(0);
    expect(fetched.seen[0]!.body).toEqual({ identity: "agents", label: "nexus-agent" });
  });

  it("stops with a plain message when the owner denies it", async () => {
    const ran = await run(["sign-in", "--identity", "agents"], {
      env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch,
      onWait: async (printed) => {
        const code = /code: ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(printed.stderr)![1];
        bodyOf(await askNexus("POST", "device/deny", { cookie: world.ownerCookie }, { code }));
      },
    });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/denied/);
    expect(ran.stdout).toBe("");
  });

  it("says so when Nexus has no such identity, and when no identity was named", async () => {
    const unknown = await run(["sign-in", "--identity", "nobody-here"], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/no identity/i);
    const none = await run(["sign-in"], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch });
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/--identity/);
  });

  it("gives up when the owner never answers", async () => {
    let clock = Date.UTC(2026, 10, 15);
    const { main } = await import("../src/cli/main");
    const { PassThrough } = await import("node:stream");
    let stderr = "";
    const code = await main(["sign-in", "--identity", "agents"], {
      env: { [ENV.address]: ADDRESS }, stdin: new PassThrough() as never, stdout: { write: () => true }, stderr: { write: (t) => ((stderr += t), true) },
      fetch: fetched.fetch, wait: async () => { clock += 5 * 60 * 1000; }, now: () => new Date(clock),
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/ran out/);
  });
});

describe("nexus-agent read, write and list", () => {
  let credentials: AgentCredentials;
  let env: Record<string, string>;

  beforeEach(async () => {
    await setUpVault(world);
    credentials = await agentCredentials(world);
    env = { [ENV.address]: ADDRESS, [ENV.token]: credentials.token, [ENV.privateKey]: credentials.privateKey, [ENV.approval]: credentials.approval };
  });

  const nexusAgent = (argv: string[], extra: Partial<Parameters<typeof run>[1]> = {}) => run(argv, { env, fetch: fetched.fetch, ...extra });

  it("writes the text on standard input as a note, reads it back exactly, and lists it", async () => {
    const text = "# Notes\n\nline one\nline two without a final newline";
    const written = await nexusAgent(["write", "Agent/2026-11-15 First.md"], { stdin: text });
    expect(written.code, written.stderr).toBe(0);
    expect(written.stdout).toBe("Saved Agent/2026-11-15 First.md (version 1).\n");
    const read = await nexusAgent(["read", "Agent/2026-11-15 First.md"]);
    expect(read.code).toBe(0);
    expect(read.stdout, "exactly the text, with nothing added").toBe(text);
    expect((await nexusAgent(["list"])).stdout).toBe("Agent/2026-11-15 First.md\n");
    expect((await nexusAgent(["write", "Agent/2026-11-15 First.md"], { stdin: text })).stdout).toMatch(/nothing was saved/);
  });

  it("never prints a key or the token", async () => {
    const outputs = [
      await nexusAgent(["write", "a.md"], { stdin: "hello\n" }), await nexusAgent(["read", "a.md"]), await nexusAgent(["list"]),
      await nexusAgent(["read", "missing.md"]), await nexusAgent(["read", "../escape.md"]),
    ];
    const printed = outputs.map((o) => o.stdout + o.stderr).join("\n");
    for (const secret of [credentials.privateKey, credentials.approval, credentials.token, encodeBase64(world.keys.vaultKey)]) {
      for (const shape of shapesOf(secret)) expect(printed).not.toContain(shape);
    }
  });

  it("says plainly when there is no such note, or the path is not one a note can have", async () => {
    const missing = await nexusAgent(["read", "missing.md"]);
    expect([missing.code, missing.stderr]).toEqual([1, "nexus-agent: There is no note at missing.md.\n"]);
    const unsafe = await nexusAgent(["write", "../escape.md"], { stdin: "x" });
    expect(unsafe.code).toBe(1);
    expect(unsafe.stderr).toMatch(/not a path a note can have/);
  });

  it("refuses to wait for typed text: the note's text is piped in", async () => {
    const ran = await nexusAgent(["write", "a.md"], { stdinIsTTY: true });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/Pipe the note's text in/);
  });

  it("names the settings it is missing, and is refused with a key that is not the agent's", async () => {
    const none = await run(["list"], { env: {} });
    expect(none.code).toBe(1);
    for (const name of [ENV.address, ENV.token, ENV.privateKey, ENV.approval]) expect(none.stderr).toContain(name);
    expect(none.stderr, "the agent's commands never ask for the owner's secret").not.toContain(ENV.ownerSecret);
    const wrong = await nexusAgent(["list"], { env: { ...env, [ENV.privateKey]: encodeBase64((await generateDeviceKeyPair()).privateKey) } });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toMatch(/could not be opened with this private key/);
    expect(wrong.stdout).toBe("");
  });

  it("says how many notes it could not list", async () => {
    await world.elsewhere.create("../escape.md", "refused path\n");
    const ran = await nexusAgent(["list"]);
    expect(ran.stderr).toMatch(/1 note\(s\) in this vault could not be opened/);
  });

  it("takes only the words each command wants", async () => {
    expect((await nexusAgent(["list", "extra"])).code).toBe(1);
    expect((await nexusAgent(["read"])).stderr).toMatch(/Say which note/);
    expect((await nexusAgent(["read", "a.md", "b.md"])).code).toBe(1);
    expect((await nexusAgent(["list", "--colour=red"])).stderr).toMatch(/Unknown option/);
  });
});

describe("nexus-agent on its own", () => {
  it("prints how to use it, with the names of the environment variables, for --help and help", async () => {
    for (const argv of [["--help"], ["help"], ["-h"]]) {
      const ran = await run(argv);
      expect(ran.code).toBe(0);
      for (const name of Object.values(ENV)) expect(ran.stdout).toContain(name);
    }
  });

  it("says it is not understood, with the usage, for no command and for a command it does not have", async () => {
    expect((await run([])).code).toBe(2);
    const unknown = await run(["frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("frobnicate is not a command");
  });

  it("stops with a fixed sentence, and not the fault's own words, when something unexpected goes wrong", async () => {
    const faulty = new Proxy({}, {
      get() {
        throw new Error("secret-token-in-a-fault-message");
      },
    }) as Record<string, string>;
    const ran = await run(["list"], { env: faulty });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/something went wrong/);
    expect(ran.stderr).not.toContain("secret-token-in-a-fault-message");
  });
});
