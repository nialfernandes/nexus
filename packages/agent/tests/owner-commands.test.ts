// The owner's commands, run for real over the real server code (world.ts): make-identity, allow and deny, owner-sign-in and
// set-up-agent. The owner's secret is the one the server's own sign-in check reads (the `nexus_owner` cookie), so a wrong secret is
// refused by the server's own code, and "nothing was changed" is read from the server's own state.
//
// Every output of every command and every request it sent is searched for the secrets: the owner's secret is in no argument, no
// output and no body or address; a token, a private key and an approval are each on the one line made to show them.

import { beforeEach, describe, expect, it } from "vitest";
import { ENV, LABEL } from "../src/cli/labels";
import { AgentVault } from "../src/index";
import { Nexus } from "../src/nexus";
import { ADDRESS, askNexus, bodyOf, fetchOverNexus, openWorld, run, setUpVault, timesIn, valueOf, type Ran, type SetUp, type World } from "./world";

let world: World;
let secret: string;
let fetched: ReturnType<typeof fetchOverNexus>;

/** The wrong secret a person might type: as long as a real one, so it is refused for being wrong and not for being short. */
const WRONG_SECRET = "ab".repeat(32);

beforeEach(async () => {
  world = await openWorld();
  secret = world.ownerCookie.split("=")[1]!;
  fetched = fetchOverNexus();
});

const env = (extra: Record<string, string> = {}) => ({ [ENV.address]: ADDRESS, [ENV.ownerSecret]: secret, ...extra });
const ownerCookie = () => ({ cookie: world.ownerCookie });
const posts = () => fetched.seen.filter((s) => s.method === "POST").map((s) => s.route);
const runOwner = (argv: string[], options: Partial<Parameters<typeof run>[1]> = {}) => run(argv, { env: env(), fetch: fetched.fetch, ...options });

/** Starts a sign-in the way a device does, answering with what it was handed. */
const startedBy = async (identity: string, label: string) => bodyOf(await askNexus("POST", "device/start", null, { identity, label })) as { code: string; secret: string };
const polled = async (started: { secret: string }) => (await askNexus("POST", "device/poll", null, { secret: started.secret })) as { status: number; body: any };
/** What Nexus says of an identity: a sign-in can be started for it, or Nexus says there is none. */
const identityExists = async (name: string) => (await askNexus("POST", "device/start", null, { identity: name, label: "check" })).status === 200;

/** Nothing is in the arguments, the outputs or what was sent to Nexus but the lines made to show it. */
function expectNoLeak(secretText: string, ran: Ran[], argv: string[][], what: string): void {
  expect(timesIn(argv.map((a) => a.join(" ")).join("\n"), secretText), `${what} is in no argument`).toBe(0);
  expect(timesIn(JSON.stringify(fetched.seen), secretText), `${what} is in no body or address sent to Nexus`).toBe(0);
  expect(ran.length).toBeGreaterThan(0);
}

describe("the owner's secret", () => {
  it("is sent as the owner's cookie only, never with a token, never as an argument, and never printed", async () => {
    const argv = ["make-identity", "--name", "scribe", "--kind", "agent"];
    const ran = await runOwner(argv);
    expect(ran.code, ran.stderr).toBe(0);
    expect(fetched.seen.length).toBeGreaterThan(0);
    expect(fetched.seen.every((s) => s.credential === "cookie"), "every call carried the cookie and nothing else").toBe(true);
    expect(timesIn(ran.stdout + ran.stderr, secret), "in no output").toBe(0);
    expectNoLeak(secret, [ran], [argv], "the owner's secret");
  });

  it("is read from standard input when the environment does not have it, one line, and is not echoed", async () => {
    const ran = await run(["make-identity", "--name", "scribe", "--kind", "agent"], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch, stdin: `${secret}\n` });
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toContain("Owner secret (typing is hidden): ");
    expect(timesIn(ran.stdout + ran.stderr, secret)).toBe(0);
    expect(await identityExists("scribe")).toBe(true);
  });

  it("is typed at a hidden prompt on a terminal: the terminal's echo is off while it is typed, and nothing of it reaches the screen", async () => {
    const terminal = { rawModes: [] as boolean[] };
    let typed = false;
    const ran = await run(["make-identity", "--name", "scribe", "--kind", "agent"], {
      env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch, terminal,
      reply: (printed) => {
        if (typed || !printed.stderr.endsWith("(typing is hidden): ")) return undefined;
        typed = true;
        return `${secret}\r`;
      },
    });
    expect(ran.code, ran.stderr).toBe(0);
    expect(terminal.rawModes).toEqual([true, false]);
    expect(timesIn(ran.stdout + ran.stderr, secret), "not on the screen").toBe(0);
    expect(await identityExists("scribe")).toBe(true);
  });

  it("is refused plainly when none is given, with nothing sent to Nexus", async () => {
    const ran = await run(["make-identity", "--name", "scribe", "--kind", "agent"], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch, stdin: "\n" });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/No owner secret was given/);
    expect(fetched.seen).toEqual([]);
  });

  it("is refused plainly when it is not a secret a cookie can carry, with nothing sent and nothing repeated", async () => {
    for (const bad of ["has a space in it", "semi;colon", "café-secret"]) {
      const ran = await runOwner(["make-identity", "--name", "scribe", "--kind", "agent"], { env: env({ [ENV.ownerSecret]: bad }) });
      expect(ran.code, bad).toBe(1);
      expect(ran.stderr, bad).toMatch(/owner secret .* cookie cannot carry/);
      expect(timesIn(ran.stdout + ran.stderr, bad), bad).toBe(0);
    }
    expect(fetched.seen).toEqual([]);
  });

  it("is refused as an argument, and the refusal does not repeat what was given", async () => {
    for (const flag of [`--owner-secret=${secret}`, `--secret=${secret}`, `--password=${secret}`]) {
      const ran = await runOwner(["make-identity", "--name", "scribe", "--kind", "agent", flag]);
      expect(ran.code, flag).toBe(1);
      expect(ran.stderr, flag).toMatch(/A secret is never an argument/);
      expect(timesIn(ran.stdout + ran.stderr, secret), flag).toBe(0);
    }
    const asWord = await runOwner(["owner-sign-in", "--identity", "owner", secret]);
    expect(asWord.code).toBe(1);
    expect(timesIn(asWord.stdout + asWord.stderr, secret)).toBe(0);
    expect(fetched.seen, "nothing was sent").toEqual([]);
  });

  it("is refused by Nexus when it is wrong, in plain words, by every owner command, and none of them changes anything", async () => {
    const wrong = { env: env({ [ENV.ownerSecret]: WRONG_SECRET }) };
    const waiting = await startedBy("agents", "a device that must stay waiting");
    const everyRun: Ran[] = [];
    const every: string[][] = [];
    for (const [argv, stdin] of [
      [["make-identity", "--name", "scribe", "--kind", "agent"], undefined],
      [["allow", waiting.code], "yes\n"],
      [["deny", waiting.code], "yes\n"],
      [["owner-sign-in", "--identity", "owner"], undefined],
      [["set-up-agent", "--name", "scribe"], "NOT-A-KEY\n"],
    ] as const) {
      fetched.seen.length = 0;
      const ran = await runOwner([...argv], { ...wrong, ...(stdin === undefined ? {} : { stdin }) });
      everyRun.push(ran);
      every.push([...argv]);
      expect(ran.code, argv[0]).toBe(1);
      expect(ran.stderr, argv[0]).toMatch(/Nexus did not accept the owner secret: it is wrong, or this server has none set/);
      expect(ran.stderr, argv[0]).toMatch(/Nothing was changed\./);
      expect(ran.stdout, argv[0]).toBe("");
      expect(fetched.seen.map((s) => `${s.method} ${s.route} ${s.status}`), `${argv[0]} stopped at its first call`).toEqual(["GET tokens 401"]);
      expect(timesIn(ran.stdout + ran.stderr, WRONG_SECRET), argv[0]).toBe(0);
    }
    expect(await identityExists("scribe"), "no identity was made").toBe(false);
    expect((await polled(waiting)).body, "the waiting sign-in was neither allowed nor denied").toEqual({ status: "pending" });
    expect(bodyOf(await askNexus("GET", "tokens", ownerCookie())).tokens.map((t: { label: string }) => t.label)).not.toContain("owner terminal");
    expect(timesIn(JSON.stringify(everyRun), WRONG_SECRET)).toBe(0);
  });

  it("is never added to a call that carries a token", () => {
    // The client's own rule: a token and the owner's secret are two ways to call, and a bearer header would win on the server and hide the cookie.
    const sent: Array<Record<string, string>> = [];
    const ok = async (_url: string, init: { headers: Record<string, string> }) => ((sent.push(init.headers), { status: 200, text: async () => "{}" }));
    return Promise.all([new Nexus(ADDRESS, "a-token", ok, secret).get("tokens"), new Nexus(ADDRESS, null, ok, secret).get("tokens"), new Nexus(ADDRESS, null, ok).get("tokens")]).then(() => {
      expect(sent.map((h) => [h.authorization !== undefined, h.cookie !== undefined])).toEqual([[true, false], [false, true], [false, false]]);
    });
  });
});

describe("nexus-agent make-identity", () => {
  it("makes an identity of the kind asked, which can then be signed in", async () => {
    for (const kind of ["agent", "person", "app"]) {
      const ran = await runOwner(["make-identity", "--name", `made-${kind}`, "--kind", kind]);
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stderr).toContain(`Made the identity made-${kind} (kind ${kind})`);
      expect(await identityExists(`made-${kind}`), kind).toBe(true);
    }
    expect(posts().filter((route) => route === "identity")).toHaveLength(3);
  });

  it("takes --name=x and --kind=y, and prints no secret", async () => {
    const ran = await runOwner(["make-identity", "--name=scribe", "--kind=agent"]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(fetched.seen.find((s) => s.route === "identity")!.body).toEqual({ name: "scribe", kind: "agent" });
  });

  it("says plainly what is missing or wrong, before it asks for the secret or sends anything", async () => {
    for (const [argv, said] of [
      [["make-identity", "--kind", "agent"], /Say the identity's name/],
      [["make-identity", "--name", "scribe"], /Say the identity's kind/],
      [["make-identity", "--name", "scribe", "--kind", "owner"], /Say the identity's kind/],
    ] as const) {
      const ran = await run([...argv], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch, stdin: "" });
      expect(ran.code, argv.join(" ")).toBe(1);
      expect(ran.stderr).toMatch(said);
      expect(ran.stderr, "it did not ask for the secret").not.toContain("Owner secret");
    }
    expect(fetched.seen).toEqual([]);
  });

  it("says in Nexus's words when the name is taken or is not a name, and changes nothing more", async () => {
    expect((await runOwner(["make-identity", "--name", "scribe", "--kind", "agent"])).code).toBe(0);
    const taken = await runOwner(["make-identity", "--name", "scribe", "--kind", "agent"]);
    expect(taken.code).toBe(1);
    expect(taken.stderr).toMatch(/There is already an identity called scribe/);
    const bad = await runOwner(["make-identity", "--name", "Not A Name", "--kind", "agent"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/lower case letters, digits and hyphens/);
  });

  it("names the address when it is missing", async () => {
    const ran = await run(["make-identity", "--name", "scribe", "--kind", "agent"], { env: { [ENV.ownerSecret]: secret }, fetch: fetched.fetch });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/Set NEXUS_ADDRESS/);
  });
});

describe("nexus-agent allow and deny", () => {
  let waiting: { code: string; secret: string };

  beforeEach(async () => {
    waiting = await startedBy("agents", "Work laptop");
  });

  it("shows what is asking and, when yes is typed, allows it: the device is handed its token", async () => {
    const ran = await runOwner(["allow", waiting.code], { stdin: "yes\n" });
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toContain("as the identity: agents");
    expect(ran.stderr).toContain("label: Work laptop");
    expect(ran.stderr).toContain(`code: ${waiting.code}`);
    expect(ran.stderr).toContain("Type yes to allow it: ");
    expect(ran.stderr).toContain("Allowed the sign-in for agents.");
    expect(fetched.seen.map((s) => `${s.method} ${s.route.split("?")[0]}`)).toEqual(["GET tokens", "GET device/pending", "POST device/approve"]);
    const handed = await polled(waiting);
    expect(handed.body).toMatchObject({ status: "approved", identity: "agents", label: "Work laptop" });
    expect(handed.body.token).toMatch(/^nx_[0-9a-f]{64}$/);
    expect(timesIn(ran.stdout + ran.stderr, handed.body.token), "the token is not shown to the owner: it is the device's").toBe(0);
  });

  it("takes the secret and the yes from standard input, in that order, when the secret is not in the environment", async () => {
    const ran = await run(["allow", waiting.code], { env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch, stdin: `${secret}\nYES\n` });
    expect(ran.code, ran.stderr).toBe(0);
    expect((await polled(waiting)).body.status).toBe("approved");
    expect(timesIn(ran.stdout + ran.stderr, secret)).toBe(0);
  });

  it("approves nothing without a typed yes: not for no, not for a blank line, not for y, not when the input ends", async () => {
    for (const typed of ["no\n", "\n", "y\n", "yes please\n", "", "n"]) {
      fetched.seen.length = 0;
      const ran = await runOwner(["allow", waiting.code], { stdin: typed });
      expect(ran.code, JSON.stringify(typed)).toBe(1);
      expect(ran.stderr, JSON.stringify(typed)).toMatch(/That was not "yes", so the sign-in was not allowed\. Nothing was changed\./);
      expect(posts(), JSON.stringify(typed)).toEqual([]);
      expect((await polled(waiting)).body, JSON.stringify(typed)).toEqual({ status: "pending" });
    }
  });

  it("shows the question before it reads the answer, so the answer is a reply to what was shown", async () => {
    let answered = false;
    const ran = await runOwner(["allow", waiting.code], {
      reply: (printed) => {
        if (answered || !printed.stderr.endsWith("Type yes to allow it: ")) return undefined;
        answered = true;
        expect(printed.stderr, "what was asking is on the screen first").toContain("label: Work laptop");
        return "yes\n";
      },
    });
    expect(ran.code, ran.stderr).toBe(0);
    expect(answered).toBe(true);
  });

  it("denies a sign-in only on a typed yes: the device is told the owner denied it", async () => {
    const declined = await runOwner(["deny", waiting.code], { stdin: "no\n" });
    expect(declined.code).toBe(1);
    expect(declined.stderr).toMatch(/not denied/);
    expect((await polled(waiting)).body).toEqual({ status: "pending" });

    const ran = await runOwner(["deny", waiting.code], { stdin: "yes\n" });
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toContain("Type yes to deny it: ");
    expect(ran.stderr).toContain("Denied the sign-in for agents.");
    expect((await polled(waiting)).status).toBe(403);
  });

  it("is refused plainly for a code that is not there, is used, or is not given", async () => {
    const unknown = await runOwner(["allow", "ZZZZ-ZZZZ"], { stdin: "yes\n" });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/did not look up that sign-in|would not look up that sign-in/);
    expect(unknown.stderr).not.toContain("Type yes");

    expect((await runOwner(["allow", waiting.code], { stdin: "yes\n" })).code).toBe(0);
    const again = await runOwner(["allow", waiting.code], { stdin: "yes\n" });
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/410/);

    const none = await runOwner(["allow"], { stdin: "yes\n" });
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/Say which sign-in: nexus-agent allow <code>/);
    const two = await runOwner(["deny", "AAAA-AAAA", "BBBB-BBBB"], { stdin: "yes\n" });
    expect(two.code).toBe(1);
    expect(two.stderr).toMatch(/deny takes one code after it/);
  });

  it("shows a label with its control characters taken out, so a device cannot paint over the screen", async () => {
    const sneaky = await startedBy("agents", "\u001b[2J\u001b[1;1HAllowed by the owner‮");
    const ran = await runOwner(["allow", sneaky.code], { stdin: "no\n" });
    expect(ran.stderr).not.toMatch(/[\u001b‮]/);
    expect(ran.stderr).toContain("label: [2J[1;1HAllowed by the owner");
  });

  it("says when the device sent a key of its own, and that nothing is sealed to it", async () => {
    const withKey = bodyOf(await askNexus("POST", "device/start", null, { identity: "agents", label: "Phone", deviceKey: Buffer.alloc(32, 7).toString("base64") })) as { code: string };
    const ran = await runOwner(["allow", withKey.code], { stdin: "yes\n" });
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toMatch(/sent a key of its own to be sealed to\. This command sends no approval/);
    expect(fetched.seen.find((s) => s.route === "device/approve")!.body, "no approval is sent").toEqual({ code: withKey.code });
  });
});

describe("nexus-agent owner-sign-in", () => {
  it("signs the owner in with the secret alone: the owner's own token, printed once on its own line", async () => {
    const argv = ["owner-sign-in", "--identity", "owner"];
    const ran = await runOwner(argv);
    expect(ran.code, ran.stderr).toBe(0);
    const token = valueOf(ran.stdout, LABEL.token)!;
    expect(token).toMatch(/^nx_[0-9a-f]{64}$/);
    expect(ran.stdout.trimEnd().split("\n"), "one line").toHaveLength(1);
    expect(timesIn(ran.stderr, token), "the token is on stdout only").toBe(0);
    expect(ran.stderr).toContain(`the ${ENV.token} that create-vault and approve-agent read`);
    expectNoLeak(token, [ran], [argv], "the token");
    expectNoLeak(secret, [ran], [argv], "the owner's secret");
    expect(timesIn(ran.stdout + ran.stderr, secret)).toBe(0);

    // It is the owner's token: it makes the identity only the owner makes, and it is listed under the label.
    const asToken = await askNexus("GET", "tokens", { bearer: token });
    expect(asToken.status).toBe(200);
    expect(asToken.body.tokens.find((t: { label: string }) => t.label === "owner terminal")).toMatchObject({ identity: "owner" });
    expect(fetched.seen.map((s) => `${s.method} ${s.route} ${s.credential}`)).toEqual([
      "GET tokens cookie", "POST device/start none", "POST device/approve cookie", "POST device/poll none",
    ]);
  });

  it("takes the label it is given", async () => {
    const ran = await runOwner(["owner-sign-in", "--identity=owner", "--label", "my laptop"]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(fetched.seen.find((s) => s.route === "device/start")!.body).toEqual({ identity: "owner", label: "my laptop" });
  });

  it("makes a token that create-vault takes, on a server that has no vault", async () => {
    const signed = await runOwner(["owner-sign-in", "--identity", "owner"]);
    const token = valueOf(signed.stdout, LABEL.token)!;
    let typed = false;
    const created = await run(["create-vault"], {
      env: { [ENV.address]: ADDRESS, [ENV.token]: token }, fetch: fetched.fetch, screen: true,
      reply: (printed) => {
        if (typed || !printed.stderr.endsWith("(the last group): ")) return undefined;
        typed = true;
        return `${valueOf(printed.stdout, LABEL.recoveryKey)!.split("-").at(-1)}\n`;
      },
    });
    expect(created.code, created.stderr).toBe(0);
    expect(bodyOf(await askNexus("GET", "wraps", ownerCookie())).wraps).toHaveLength(1);
  });

  it("says who it needs, and when Nexus has no such identity, and changes nothing", async () => {
    const none = await runOwner(["owner-sign-in"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/Say the owner's name: nexus-agent owner-sign-in --identity/);
    const unknown = await runOwner(["owner-sign-in", "--identity", "nobody-here"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/There is no identity called nobody-here/);
    expect(unknown.stdout).toBe("");
    expect(bodyOf(await askNexus("GET", "tokens", ownerCookie())).tokens.filter((t: { label: string }) => t.label === "owner terminal")).toEqual([]);
  });
});

describe("nexus-agent set-up-agent", () => {
  let vault: SetUp;
  /** The Recovery Key is the line after the owner's secret, when that is typed too. */
  const setUp = (name: string, recoveryKey: string, extra: Partial<Parameters<typeof run>[1]> = {}) =>
    runOwner(["set-up-agent", "--name", name], { stdin: `${recoveryKey}\n`, ...extra });

  beforeEach(async () => {
    vault = await setUpVault(world);
  });

  it("makes the identity, the key pair, the token and the approval, and prints the four values, each on its own labelled line", async () => {
    const argv = ["set-up-agent", "--name", "scribe"];
    const ran = await runOwner(argv, { stdin: `${vault.recoveryKeyText}\n` });
    expect(ran.code, ran.stderr).toBe(0);
    const calledByTheCommand = [...fetched.seen];
    expect(ran.stdout.trimEnd().split("\n").map((line) => line.split("=")[0])).toEqual([ENV.address, ENV.token, ENV.privateKey, ENV.approval]);
    const value = (name: string) => ran.stdout.split("\n").find((line) => line.startsWith(`${name}=`))!.slice(name.length + 1);
    expect(value(ENV.address)).toBe(ADDRESS);
    expect(value(ENV.token)).toMatch(/^nx_[0-9a-f]{64}$/);
    expect(ran.stderr).toMatch(/save them in your secrets manager now/);
    expect(ran.stderr).toMatch(/shown once/);

    // The agent, given those four values and nothing else, opens the vault and writes a note.
    const agent = await AgentVault.open({ address: value(ENV.address), token: value(ENV.token), privateKey: value(ENV.privateKey), approval: value(ENV.approval), fetch: fetched.fetch });
    expect(agent.vaultId).toBe(world.keys.vaultId);
    await world.elsewhere.create("Shared/note.md", "written with the vault key\n");
    expect(await agent.read("Shared/note.md")).toBe("written with the vault key\n");
    agent.close();

    // The token is the identity's, under the label the command gave.
    const tokens = bodyOf(await askNexus("GET", "tokens", ownerCookie())).tokens as Array<{ identity: string; label: string }>;
    expect(tokens.find((t) => t.identity === "scribe")).toMatchObject({ label: "nexus-agent" });
    expect(await identityExists("scribe")).toBe(true);

    // No secret is anywhere but its own line.
    const everything = ran.stdout + ran.stderr;
    for (const [name, text] of [[ENV.token, value(ENV.token)], [ENV.privateKey, value(ENV.privateKey)], [ENV.approval, value(ENV.approval)]] as const) {
      expect(timesIn(everything, text), `${name} is on its one line`).toBe(1);
      expectNoLeak(text, [ran], [argv], name);
    }
    for (const [name, text] of [["the owner's secret", secret], ["the Recovery Key", vault.recoveryKeyText]] as const) {
      expect(timesIn(everything, text), `${name} is in no output`).toBe(0);
      expectNoLeak(text, [ran], [argv], name);
    }
    expect(calledByTheCommand.every((s) => s.credential === "cookie" || s.credential === "none"), "the command sent no token: the owner's secret did it all").toBe(true);
  });

  it("asks for the owner's secret and then the Recovery Key at hidden prompts when the environment has no secret, and shows neither", async () => {
    const terminal = { rawModes: [] as boolean[] };
    const typed: string[] = [];
    const ran = await run(["set-up-agent", "--name", "scribe"], {
      env: { [ENV.address]: ADDRESS }, fetch: fetched.fetch, terminal,
      reply: (printed) => {
        if (!printed.stderr.endsWith("(typing is hidden): ")) return undefined;
        const asked = printed.stderr.match(/\(typing is hidden\): /g)!.length;
        if (typed.length >= asked) return undefined;
        typed.push(asked === 1 ? "secret" : "recovery key");
        return `${asked === 1 ? secret : vault.recoveryKeyText}\r`;
      },
    });
    expect(ran.code, ran.stderr).toBe(0);
    expect(typed).toEqual(["secret", "recovery key"]);
    expect(ran.stderr).toContain("Owner secret (typing is hidden): ");
    expect(ran.stderr).toContain("Recovery Key (typing is hidden): ");
    expect(terminal.rawModes, "echo was off for each, and back on after each").toEqual([true, false, true, false]);
    expect(timesIn(ran.stdout + ran.stderr, secret)).toBe(0);
    expect(timesIn(ran.stdout + ran.stderr, vault.recoveryKeyText)).toBe(0);
  });

  it("uses an identity that already exists, and says so", async () => {
    expect((await runOwner(["make-identity", "--name", "scribe", "--kind", "agent"])).code).toBe(0);
    const ran = await setUp("scribe", vault.recoveryKeyText);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toContain("There is already an identity called scribe: it is used as it is.");
    expect(ran.stdout).toContain(`${ENV.address}=${ADDRESS}\n`);
    expect(fetched.seen.filter((s) => s.route === "identity").map((s) => s.status)).toEqual([200, 409]);
  });

  it("can be run again for the same name: each run is a token of its own, and the first agent keeps working", async () => {
    const first = await setUp("scribe", vault.recoveryKeyText);
    const second = await setUp("scribe", vault.recoveryKeyText);
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    const tokenOf = (ran: Ran) => /NEXUS_TOKEN=(\S+)/.exec(ran.stdout)![1]!;
    expect(tokenOf(first)).not.toBe(tokenOf(second));
    expect((await askNexus("GET", "list", { bearer: tokenOf(first) })).status).toBe(200);
    expect((await askNexus("GET", "list", { bearer: tokenOf(second) })).status).toBe(200);
  });

  it("is refused for a wrong Recovery Key, with nothing made: no identity, no token, nothing printed", async () => {
    const flipped = vault.recoveryKeyText.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    for (const typed of [flipped, "", "not a key"]) {
      const ran = await setUp("scribe", typed);
      expect(ran.code, typed).toBe(1);
      expect(ran.stdout, typed).toBe("");
      expect(ran.stderr, typed).toMatch(/Nothing was made/);
    }
    expect(posts(), "nothing was posted").toEqual([]);
    expect(await identityExists("scribe")).toBe(false);
    expect(bodyOf(await askNexus("GET", "tokens", ownerCookie())).tokens.filter((t: { identity: string }) => t.identity === "scribe")).toEqual([]);
  });

  it("is refused by a server that holds no vault, saying to set one up, with nothing made", async () => {
    const empty = await openWorld();
    const emptySecret = empty.ownerCookie.split("=")[1]!;
    const ran = await run(["set-up-agent", "--name", "scribe"], { env: { [ENV.address]: ADDRESS, [ENV.ownerSecret]: emptySecret }, fetch: fetched.fetch, stdin: `${vault.recoveryKeyText}\n` });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/create-vault/);
    expect(ran.stdout).toBe("");
    expect((await askNexus("POST", "device/start", null, { identity: "scribe", label: "check" })).status, "no identity was made").toBe(404);
  });

  it("says what it needs: a name, and the address", async () => {
    const noName = await runOwner(["set-up-agent"], { stdin: `${vault.recoveryKeyText}\n` });
    expect(noName.code).toBe(1);
    expect(noName.stderr).toMatch(/Say the agent's name: nexus-agent set-up-agent --name <name>/);
    const noAddress = await run(["set-up-agent", "--name", "scribe"], { env: { [ENV.ownerSecret]: secret }, stdin: `${vault.recoveryKeyText}\n` });
    expect(noAddress.code).toBe(1);
    expect(noAddress.stderr).toMatch(/Set NEXUS_ADDRESS/);
  });

  it("says in Nexus's words when the name is not a name", async () => {
    const ran = await setUp("Not A Name", vault.recoveryKeyText);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/lower case letters, digits and hyphens/);
    expect(ran.stdout).toBe("");
  });
});
