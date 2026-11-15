// The README names the environment variables and the commands the code reads and has, taken from the code's own constants, so a
// variable that is renamed in the code cannot stay in the README under its old name.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
    for (const command of ["keygen", "sign-in", "create-vault", "approve-agent", "read", "write", "list", "make-identity", "allow", "deny", "owner-sign-in", "set-up-agent"]) expect(README, command).toContain(`nexus-agent ${command}`);
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
    expect(methods.sort(), "the library's calls").toEqual(["close", "createNote", "list", "listNotes", "read", "readNote", "remove", "unreadableNotes", "updateNote", "write"]);
    for (const name of methods) expect(README, name).toContain(name);
    for (const name of ["open", "connect"]) expect(typeof AgentVault[name as "open" | "connect"], name).toBe("function");
    expect(README).toContain("AgentVault.connect(");
    expect(WORDS).toMatch(/`wasm`/);
    expect(WORDS).toMatch(/Wasm code generation disallowed by embedder/);
  });

  it("says a create can be repeated safely with an id the caller chose, what is answered, and when it is refused", () => {
    expect(README).toContain("createNote(path, text, { id })");
    expect(WORDS).toMatch(/at the same path with the same text/);
    expect(WORDS).toMatch(/answers it .* and saves nothing/);
    expect(WORDS).toMatch(/`AgentError` with the code `id-taken`/);
    expect(WORDS, "the operator sees an id, so the README says to make it from a hash").toMatch(/Nexus sees a note's id, so make it from a hash/);
  });

  it("says how the first look at a vault is made and what it keeps, and that a stale update changes nothing", () => {
    expect(WORDS).toMatch(/GET \/heads/);
    expect(WORDS).toMatch(/keeps only its id, its version and its path: the note's text is not kept/);
    expect(WORDS).toMatch(/changed-since/);
    expect(WORDS).toMatch(/nothing is changed, merged or overwritten/);
  });
});
