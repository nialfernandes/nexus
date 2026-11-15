// What the agent's tests stand on: the plugin's own test world (plugin/tests/world.ts: the real server code over an in-memory
// SQLite database, the plugin's sync engine, a fake Obsidian vault), read here and not changed.
//
// WHERE THINGS COME FROM
//   - Nexus is the server's own code. The agent's `fetch` is `fetchOverNexus`: every call the library or the command makes goes
//     to the server's `runNexus` as a real Request, through the plugin world's `askNexus`, and the answer comes back as the server
//     wrote it. Nothing of the server is written again here.
//   - Tokens are got the way a device gets one: a sign-in is started, the owner approves, the device polls (`world.tokenFor`).
//   - The vault key, the Recovery wrap and the approval are made with @nexus/crypto, the way `create-vault` and `approve-agent`
//     make them. The worked example makes them with the commands themselves.

import { generateDeviceKeyPair, generateRecoveryKey, sealApproval, wrapVaultKeyWithRecoveryKey, formatRecoveryKey } from "@nexus/crypto";
import { PassThrough } from "node:stream";
import { encodeBase64 } from "../src/base64";
import type { Io } from "../src/cli/io";
import type { FetchLike } from "../src/nexus";
import { askNexus, bodyOf, openWorld, type World } from "../../../plugin/tests/world";
import { API, ORIGIN } from "../../../plugin/tests/real-nexus";

export { askNexus, bodyOf, openWorld, type World };

/** The address the agent is given: where Nexus's routes sit. */
export const ADDRESS = ORIGIN + API;

export interface Seen {
  method: string;
  /** The route under the API's base, query included: `save`, `changes?after=3&limit=500`. */
  route: string;
  body: any;
  status: number;
  /** How the call was made, never the credential itself: a bearer token, the owner's cookie, both, or neither. */
  credential: "bearer" | "cookie" | "both" | "none";
}

const credentialOf = (authorization: string | undefined, cookie: string | undefined): Seen["credential"] =>
  authorization !== undefined ? (cookie !== undefined ? "both" : "bearer") : cookie !== undefined ? "cookie" : "none";

/** The agent's `fetch`, over the real server code. `seen` lists every call in order; `before` may do something just before a call goes through. */
export function fetchOverNexus(options: { before?: (seen: Omit<Seen, "status">) => Promise<void> | void } = {}): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const route = parsed.pathname.slice(API.length + 1) + parsed.search;
    const { authorization, cookie } = init.headers;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    await options.before?.({ method: init.method, route, body, credential: credentialOf(authorization, cookie) });
    // Nexus reads a bearer header before a cookie, so a call with both is sent as the bearer one (and `seen` says it carried both).
    const who = authorization !== undefined ? { authorization } : cookie !== undefined ? { cookie } : null;
    const answer = await askNexus(init.method, route, who, body);
    seen.push({ method: init.method, route, body, status: answer.status, credential: credentialOf(authorization, cookie) });
    return { status: answer.status, text: async () => answer.text };
  };
  return { fetch, seen };
}

/** The Recovery Key of a vault set up by `setUpVault`, written as a person writes it down. */
export interface SetUp {
  recoveryKeyText: string;
  recoveryKey: Uint8Array;
}

/** Keeps the world's own vault key under a new Recovery Key on the server, with the world's vault id, as `create-vault` does. */
export async function setUpVault(world: World): Promise<SetUp> {
  const recoveryKey = await generateRecoveryKey();
  const wrap = await wrapVaultKeyWithRecoveryKey(recoveryKey, world.keys.vaultKey, { vaultId: world.keys.vaultId, kid: world.keys.kid });
  bodyOf(await askNexus("POST", "wrap", { cookie: world.ownerCookie }, {
    kid: world.keys.kid, kind: "recovery", wrap: encodeBase64(wrap), vaultId: world.keys.vaultId,
  }));
  return { recoveryKey, recoveryKeyText: await formatRecoveryKey(recoveryKey) };
}

/** What an agent is given to open the vault: a new key pair, and the world's vault key sealed to its public half. */
export interface AgentCredentials {
  address: string;
  token: string;
  privateKey: string;
  publicKey: string;
  approval: string;
}

export async function agentCredentials(world: World, label = "the agent under test"): Promise<AgentCredentials> {
  const pair = await generateDeviceKeyPair();
  const approval = await sealApproval(pair.publicKey, world.keys.vaultKey, { vaultId: world.keys.vaultId, kid: world.keys.kid });
  return {
    address: ADDRESS,
    token: await world.tokenFor("agents", label),
    privateKey: encodeBase64(pair.privateKey),
    publicKey: encodeBase64(pair.publicKey),
    approval: encodeBase64(approval),
  };
}

// ── the command, run over streams of its own ─────────────────────────────────

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: Record<string, string>;
  /** What is piped in before the command starts. */
  stdin?: string;
  /** Called after everything the command prints; a string it answers is typed in, the way a person answers a prompt they have just read. */
  reply?: (printed: { stdout: string; stderr: string }) => string | undefined;
  /** True for a screen: create-vault shows its key only on one. */
  screen?: boolean;
  /** True when the command's input is a terminal (nothing was piped in). */
  stdinIsTTY?: boolean;
  /** True for a real terminal's input: keys arrive as typed, with the terminal's echo off while a hidden answer is typed. `rawModes` is filled with each change of it. */
  terminal?: { rawModes: boolean[] };
  fetch?: FetchLike;
  /** Called each time the command pauses between polls, with what it has printed so far. */
  onWait?: (printed: { stdout: string; stderr: string }) => Promise<void> | void;
}

/** Runs `nexus-agent <argv>` in this process, the same `main` the built command runs, over a stdin of the text given and a stdout and stderr that are kept. */
export async function run(argv: string[], options: RunOptions = {}): Promise<Ran> {
  const { main } = await import("../src/cli/main");
  const printed = { stdout: "", stderr: "" };
  const terminal = options.terminal === undefined ? undefined : fakeTerminal();
  const stdin = (terminal?.input ?? new PassThrough()) as unknown as Io["stdin"] & PassThrough;
  if (terminal !== undefined && options.terminal !== undefined) options.terminal.rawModes = terminal.rawModes;
  if (options.stdinIsTTY === true) (stdin as { isTTY?: boolean }).isTTY = true;
  if (options.stdin !== undefined) stdin.write(options.stdin);
  if (options.reply === undefined) stdin.end();
  const typedIn = () => {
    const answer = options.reply?.(printed);
    if (answer !== undefined) stdin.write(answer);
  };
  const io: Io = {
    env: options.env ?? {},
    stdin,
    stdout: { write: (text) => ((printed.stdout += text), typedIn(), true), isTTY: options.screen === true },
    stderr: { write: (text) => ((printed.stderr += text), typedIn(), true) },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    wait: async () => options.onWait?.(printed),
    now: () => new Date(Date.UTC(2026, 10, 15, 12, 0, 0)),
  };
  const code = await main(argv, io);
  stdin.end();
  return { code, ...printed };
}

/** A stdin that is a terminal: the keys typed arrive one chunk at a time, and raw mode can be asked for and is noted. */
export function fakeTerminal(): { input: PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void }; rawModes: boolean[] } {
  const rawModes: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (on: boolean) => {
      rawModes.push(on);
    },
  });
  return { input, rawModes };
}

// ── reading what the commands print ──────────────────────────────────────────

/** The value on the line that starts with `label`, or undefined. */
export function valueOf(output: string, label: string): string | undefined {
  const line = output.split("\n").find((candidate) => candidate.startsWith(`${label}: `));
  return line?.slice(label.length + 2);
}

/** Every way a secret could be written down that a search of an output must look for: as given, without its hyphens, lower case, and as hex when it is base64. */
export function shapesOf(secret: string): string[] {
  const shapes = new Set([secret, secret.replace(/-/g, ""), secret.toLowerCase(), secret.replace(/-/g, "").toLowerCase(), secret.replace(/=+$/, "")]);
  const bytes = /^[A-Za-z0-9+/]+={0,2}$/.test(secret) ? Buffer.from(secret, "base64") : null;
  if (bytes !== null && bytes.length > 0) shapes.add(bytes.toString("hex"));
  return [...shapes];
}

/** How many times `secret`, in any of its shapes, appears in `text`. A shape that is the start of another is the same appearance, counted once. */
export function timesIn(text: string, secret: string): number {
  const lowered = text.toLowerCase();
  const starts = new Set<number>();
  for (const shape of new Set(shapesOf(secret).map((s) => s.toLowerCase()))) {
    for (let at = lowered.indexOf(shape); at !== -1; at = lowered.indexOf(shape, at + shape.length)) starts.add(at);
  }
  return starts.size;
}

// ── the server over a real socket ────────────────────────────────────────────

/**
 * The server's own code on a port of this machine, for a client that runs in another process (the memory test's): each request that
 * arrives is handed to `askNexus` as it came, with the Authorization header it carried, and the answer is sent back as the server wrote it.
 */
export async function serveNexus(): Promise<{ address: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const text = Buffer.concat(chunks).toString("utf8");
      const authorization = request.headers.authorization;
      const answer = await askNexus(request.method ?? "GET", url.pathname.slice(API.length + 1) + url.search, authorization === undefined ? null : { authorization }, text === "" ? undefined : JSON.parse(text));
      response.writeHead(answer.status, { "content-type": "application/json; charset=utf-8" });
      response.end(answer.text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    address: `http://127.0.0.1:${port}${API}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
