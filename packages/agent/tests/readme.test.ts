// The README names the environment variables and the commands the code reads and has, taken from the code's own constants, so a
// variable that is renamed in the code cannot stay in the README under its old name.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JOIN_LABEL } from "../src/cli/join";
import { ENV } from "../src/cli/labels";
import { AgentVault } from "../src/index";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const WORDS = README.replace(/\s+/g, " ");

describe("the package README", () => {
  it("says the encryption is not yet audited before its first section, and links the threat model", () => {
    const notice = README.search(/not yet been independently audited/i);
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(README.indexOf("\n## "));
    expect(README).toContain("(../../docs/THREAT-MODEL.md)");
  });

  it("names every environment variable the commands read, in the table of them", () => {
    for (const name of Object.values(ENV)) expect(README, name).toMatch(new RegExp(`\\| \`${name}\` \\|`));
  });

  it("names every command", () => {
    for (const command of ["keygen", "sign-in", "create-vault", "approve-agent", "read", "write", "list", "make-identity", "allow", "deny", "owner-sign-in", "set-up-agent", "join"]) expect(README, command).toContain(`nexus-agent ${command}`);
  });

  it("says how an agent joins: one command run on the agent, two codes printed, the owner types the agent code in Obsidian, and the four values go to standard output only", () => {
    expect(README).toContain("## An agent joins with one command");
    expect(WORDS).toMatch(/nexus-agent join scribe > scribe\.env/);
    expect(WORDS).toMatch(/prints two codes \*\*on the error stream\*\*/);
    expect(WORDS).toContain(`**${JOIN_LABEL.agentCode}**`);
    expect(WORDS).toContain(`**${JOIN_LABEL.signInCode}**`);
    expect(WORDS).toMatch(/opens \*\*Approve a device\*\* and types the agent code|opens \*\*Approve a device\*\*, sees .* and types the agent code/);
    expect(WORDS).toMatch(/No Recovery Key is typed anywhere/);
    expect(WORDS).toMatch(/only the four values go to standard output/);
    expect(WORDS).toMatch(/Nexus's own words/);
    expect(WORDS).toMatch(/The command itself writes no file/);
  });

  it("says a key is never an argument, and that the Recovery Key is typed at a hidden prompt", () => {
    expect(WORDS).toMatch(/A key is never an argument to any command/);
    expect(WORDS).toMatch(/Recovery Key at a \*\*hidden\*\* prompt/);
  });

  it("says the owner secret is typed at a hidden prompt or read from the environment, and is never an argument", () => {
    expect(WORDS).toMatch(/owner secret .*\*\*hidden\*\* prompt/);
    expect(WORDS).toMatch(/it is never an argument and never printed/);
  });

  it("names the four values set-up-agent prints, and says they are shown once", () => {
    for (const name of [ENV.address, ENV.token, ENV.privateKey, ENV.approval]) expect(README, name).toMatch(new RegExp(`^\\s*${name}=`, "m"));
    expect(WORDS).toMatch(/Save them in your secrets manager now: they are shown once/);
  });

  it("prints the checksum lines the build prints, one for each file it makes", () => {
    for (const file of ["nexus-agent.js", "nexus-agent.wasm", "cli.js"]) expect(README).toContain(`<64 hex characters>  ${file}`);
  });

  it("names every call the library has for a note by its id, and for the vault by path, and the option that takes the WebAssembly", () => {
    const methods = Object.entries(Object.getOwnPropertyDescriptors(AgentVault.prototype)).filter(([name, d]) => name !== "constructor" && typeof d.value === "function").map(([name]) => name);
    expect(methods.sort(), "the library's calls").toEqual(["close", "createNote", "list", "listNotes", "noteIdForKey", "read", "readNote", "remove", "unreadableNotes", "updateNote", "write"]);
    for (const name of methods) expect(README, name).toContain(name);
    for (const name of ["open", "connect"]) expect(typeof AgentVault[name as "open" | "connect"], name).toBe("function");
    expect(README).toContain("AgentVault.connect(");
    expect(WORDS).toMatch(/`wasm`/);
    expect(WORDS).toMatch(/Wasm code generation disallowed by embedder/);
  });

  it("says a create can be repeated safely with a key the caller keeps, what is answered, and when it is refused", () => {
    expect(README).toContain("createNote(path, text, { key })");
    expect(WORDS).toMatch(/at the same path with the same text/);
    expect(WORDS).toMatch(/answers it .* and saves nothing/);
    expect(WORDS).toMatch(/`AgentError` with the code `key-taken`/);
    expect(WORDS, "the operator sees an id, so the id is not the key").toMatch(/Nexus sees every note's id, so the id is \*\*not\*\* the key: it is 16 bytes of an HMAC of the key, under a key derived from the vault key/);
    expect(WORDS).toContain("[docs/FORMAT.md](../../docs/FORMAT.md) section 7.6");
    expect(WORDS).toMatch(/an option other than `key` is refused/);
  });

  it("says how a writer that lost a note's id finds it again from its key, and that the refusal carries the id", () => {
    expect(README).toContain("noteIdForKey(key)");
    expect(WORDS).toMatch(/`readNote\(await vault\.noteIdForKey\(key\)\)` and then `updateNote` at the version that read tells/);
    expect(WORDS).toMatch(/The error's `id` field is the note's id/);
    expect(WORDS).toMatch(/with no request to Nexus/);
  });

  it("says how the first look at a vault is made and what it keeps, and that a stale update changes nothing", () => {
    expect(WORDS).toMatch(/GET \/heads/);
    expect(WORDS).toMatch(/keeps only its id, its version and its path: the note's text is not kept/);
    expect(WORDS).toMatch(/changed-since/);
    expect(WORDS).toMatch(/nothing is changed, merged or overwritten/);
  });
});
