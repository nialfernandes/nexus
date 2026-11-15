// The built command, as a person runs it: `node dist/cli.js`, a process of its own, with its settings in the environment and its text on
// standard input, talking over HTTP to a server that is the real server code (world.ts). It proves the file that is shipped works, and
// that what is put on its command line is only the words of the command.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCommand } from "../scripts/build.mjs";
import { ENV, LABEL } from "../src/cli/labels";
import { AgentVault } from "../src/index";
import { API } from "../../../plugin/tests/real-nexus";
import { agentCredentials, askNexus, openWorld, setUpVault, shapesOf, valueOf, type SetUp, type World } from "./world";

let directory = "";
let command = "";
let server: Server;
let address = "";
let world: World;
let vault: SetUp;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "nexus-agent-bin-"));
  command = join(directory, "cli.js");
  await buildCommand(command);
  world = await openWorld();
  vault = await setUpVault(world);
  // A server at a real address, answering with the real server code.
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const url = new URL(req.url ?? "/", "http://localhost");
    const authorization = req.headers.authorization;
    const answer = await askNexus(req.method ?? "GET", url.pathname.slice(API.length + 1) + url.search, authorization === undefined ? null : { authorization }, body);
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(answer.text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  address = `http://127.0.0.1:${(server.address() as AddressInfo).port}${API}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (directory) rmSync(directory, { recursive: true });
});

interface Done {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the built command with `env` added to a bare environment (no inherited NEXUS_ settings), `stdin` piped in, and `argv` as its arguments. */
function runCommand(argv: string[], env: Record<string, string>, stdin = ""): Promise<Done> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [command, ...argv], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe("the built command", () => {
  it("is a program that can be run: a shebang line, and the right to run", () => {
    expect(readFileSync(command, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(statSync(command).mode & 0o111).not.toBe(0);
  });

  it("prints how to use it", async () => {
    const done = await runCommand(["--help"], {});
    expect(done.code).toBe(0);
    expect(done.stdout).toContain("keygen");
  });

  it("makes a key pair with no settings at all, and the private key is on one line of its output", async () => {
    const done = await runCommand(["keygen"], {});
    expect(done.code).toBe(0);
    expect(valueOf(done.stdout, LABEL.privateKey)).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(valueOf(done.stdout, LABEL.publicKey)).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it("approves an agent, which then writes, reads and lists over HTTP, with every key in the environment or on standard input and none on the command line", async () => {
    const ownerToken = await world.tokenFor(world.user, "the owner, over http");
    const ownerEnv = { [ENV.address]: address, [ENV.token]: ownerToken };

    const keys = await runCommand(["keygen"], {});
    const privateKey = valueOf(keys.stdout, LABEL.privateKey)!;
    const publicKey = valueOf(keys.stdout, LABEL.publicKey)!;

    const approved = await runCommand(["approve-agent"], ownerEnv, `${publicKey}\n${vault.recoveryKeyText}\n`);
    expect(approved.code, approved.stderr).toBe(0);
    const approval = valueOf(approved.stdout, LABEL.approval)!;
    for (const shape of shapesOf(vault.recoveryKeyText)) expect(approved.stdout + approved.stderr, "the Recovery Key is echoed nowhere").not.toContain(shape);

    const agentEnv = { [ENV.address]: address, [ENV.token]: await world.tokenFor("agents", "the agent, over http"), [ENV.privateKey]: privateKey, [ENV.approval]: approval };
    const text = "# From the built command\n\nwritten through a pipe\n";
    const written = await runCommand(["write", "Agent/over http.md"], agentEnv, text);
    expect(written.code, written.stderr).toBe(0);
    expect(written.stdout).toBe("Saved Agent/over http.md (version 1).\n");
    expect((await runCommand(["read", "Agent/over http.md"], agentEnv)).stdout).toBe(text);
    expect((await runCommand(["list"], agentEnv)).stdout).toBe("Agent/over http.md\n");

    // What the command wrote is the library's note: the library opens the same approval and reads it.
    const library = await AgentVault.open({
      address, token: agentEnv[ENV.token], privateKey, approval,
      fetch: (url, init) => fetch(url, init),
    });
    expect(await library.read("Agent/over http.md")).toBe(text);
    library.close();
  });

  it("is refused with the wrong key by the process too, with a plain line on the error stream and nothing on the output", async () => {
    const credentials = await agentCredentials(world);
    const done = await runCommand(["list"], { [ENV.address]: address, [ENV.token]: credentials.token, [ENV.privateKey]: credentials.publicKey, [ENV.approval]: credentials.approval });
    expect(done.code).toBe(1);
    expect(done.stdout).toBe("");
    expect(done.stderr).toMatch(/^nexus-agent: The approval could not be opened with this private key/);
  });
});
