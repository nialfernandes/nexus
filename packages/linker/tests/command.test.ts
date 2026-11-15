// The command, run in this process over streams and an environment of its own, as the agent's command tests run theirs.

import { afterEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/command";
import { SETTING, VAULT_SETTING } from "../src/settings";
import { hushPath, transcriptNote } from "./fixtures";
import { listOf, openLab, realFetch, type Lab } from "./lab";

const labs: Lab[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.close();
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[], env: Record<string, string>, extra: Partial<Io> = {}): Promise<Ran> {
  const printed = { stdout: "", stderr: "" };
  const code = await main(argv, { env, stdout: { write: (text) => (printed.stdout += text) }, stderr: { write: (text) => (printed.stderr += text) }, ...extra });
  return { code, ...printed };
}

async function lab(): Promise<Lab> {
  const opened = await openLab();
  labs.push(opened);
  return opened;
}

describe("nexus-linker run", () => {
  it("links the notes, says what it did to each on the error stream and sums up on standard output, and prints no key", async () => {
    const l = await lab();
    await l.seed(hushPath("One"), transcriptNote({ title: "One", spoken: ["Atomic Habits by James Clear."] }));
    l.model.answer(() => listOf({ type: "book", title: "Atomic Habits", author: "James Clear" }));
    const ran = await run(["run"], l.env, { fetchNexus: l.fetchNexus, fetchModel: realFetch });
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe("Linked 1 of 1 note taken on.\n");
    expect(ran.stderr).toBe(`${hushPath("One")}: linked to 1 thing\n`);
    expect(Object.keys(await l.texts()).sort()).toEqual([hushPath("One"), "Mentions/Atomic Habits.md", "Mentions/James Clear.md"]);
    const everything = ran.stdout + ran.stderr;
    for (const secret of [l.credentials.token, l.credentials.privateKey, l.credentials.approval, l.env[SETTING.modelKey]!]) expect(everything).not.toContain(secret);
  });

  it("exits 1 and says why, once, for a note it could not link", async () => {
    const l = await lab();
    await l.seed(hushPath("One"), transcriptNote({ title: "One", spoken: ["Words."] }));
    l.model.answer(() => "garbage");
    const ran = await run(["run"], l.env, { fetchNexus: l.fetchNexus, fetchModel: realFetch });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toBe(`${hushPath("One")}: not linked, left for a later run (The model's answer was not a JSON list.)\n`);
    expect(ran.stdout).toBe("Linked 0 of 1 note taken on.\n1 note could not be linked, left for a later run.\n");
  });

  it("exits 1 with a plain message, and touches nothing, for a missing setting", async () => {
    const l = await lab();
    const { [SETTING.modelName]: _left, ...without } = l.env;
    const calls = l.seen.length;
    const ran = await run(["run"], without, { fetchNexus: l.fetchNexus });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toBe(`Set ${SETTING.modelName} first (see the package's README).\n`);
    expect(ran.stdout).toBe("");
    // Nexus was not called.
    expect(l.seen).toHaveLength(calls);
  });

  it("exits 1 with the agent's own message when the vault cannot be opened", async () => {
    const l = await lab();
    const ran = await run(["run"], { ...l.env, [VAULT_SETTING.approval]: "bm90IGFuIGFwcHJvdmFs" }, { fetchNexus: l.fetchNexus });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/approval/i);
  });

  it("is told its way when it is asked for nothing or for something it does not know, and never prints back what it was given", async () => {
    const help = await run(["--help"], {});
    expect(help.code).toBe(0);
    for (const name of [...Object.values(SETTING), ...Object.values(VAULT_SETTING)]) expect(help.stdout, name).toContain(name);
    expect((await run([], {})).code).toBe(2);
    const odd = await run(["--model-key", "sekret-given-as-an-argument"], {});
    expect(odd.code).toBe(2);
    expect(odd.stderr).not.toContain("sekret-given-as-an-argument");
    expect((await run(["run", "now"], {})).code).toBe(2);
    expect((await run(["link"], {})).code).toBe(2);
  });
});
