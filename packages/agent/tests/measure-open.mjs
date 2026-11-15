// Run by tests/open-memory.test.ts in a process of its own: opens a vault with a BUILT library and says how much memory the open took.
// `node --expose-gc tests/measure-open.mjs <the built nexus-agent.js> [live]`, with the agent's address, token, private key and approval in
// the environment (NEXUS_ADDRESS, NEXUS_TOKEN, NEXUS_AGENT_PRIVATE_KEY, NEXUS_AGENT_APPROVAL). Prints one line of JSON.
//
// What it measures is what a Worker's memory limit counts: the JavaScript heap and the memory outside it that JavaScript holds (the
// buffers), `heapUsed + external`. The library's own WebAssembly (libsodium's memory, which a Worker counts too) is inside `external`, so
// the starting point is taken after the library has started it (a library that has no `connect` starts it inside the open, so there it
// is part of what is measured). The memory is looked at after every call to Nexus and every 2 milliseconds between, and the highest is kept.
//
// Two ways to look. By default the memory is read as it is, which holds garbage that has not been collected yet: that is what a process
// takes when nothing presses it. With `live` every look is first preceded by a full collection, so only what is still held counts: that
// is what a process that is pressed, as a Worker is at its limit, needs, and it is the figure that says whether the open fits.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MB = 1024 * 1024;
const live = process.argv[3] === "live";
const used = () => {
  if (live) globalThis.gc();
  const { heapUsed, external } = process.memoryUsage();
  return heapUsed + external;
};
const env = (name) => process.env[name] ?? "";

/** The most memory this process has had resident, from the operating system (Linux only). Node itself is in it. */
function highWaterMB() {
  try {
    const found = /^VmHWM:\s+(\d+) kB/m.exec(readFileSync("/proc/self/status", "utf8"));
    return found === null ? null : +(Number(found[1]) / 1024).toFixed(1);
  } catch {
    return null;
  }
}

const { AgentVault } = await import(pathToFileURL(process.argv[2]).href);
const options = { address: env("NEXUS_ADDRESS"), token: env("NEXUS_TOKEN"), privateKey: env("NEXUS_AGENT_PRIVATE_KEY"), approval: env("NEXUS_AGENT_APPROVAL") };

// A library with `connect` starts libsodium and checks the vault id without looking at a note.
const started = typeof AgentVault.connect === "function" ? await AgentVault.connect(options) : null;
started?.close();

globalThis.gc();
const base = used();
let peak = base;
const sample = () => {
  const now = used();
  if (now > peak) peak = now;
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  sample();
  const answer = await realFetch(...args);
  sample();
  return answer;
};
const timer = setInterval(sample, 2);

const began = performance.now();
const vault = await AgentVault.open(options);
const milliseconds = performance.now() - began;
clearInterval(timer);
sample();

globalThis.gc();
const kept = used() - base;

const rows = typeof vault.listNotes === "function" ? await vault.listNotes() : (await vault.list()).map((path) => ({ path }));
const hash = (text) => createHash("sha256").update(text).digest("hex");
console.log(JSON.stringify({
  mode: live ? "live" : "as it is",
  notes: rows.length,
  pathsSha256: hash(rows.map((row) => row.path).join("\n")),
  idsAndVersionsSha256: typeof vault.listNotes === "function" ? hash(rows.map((row) => `${row.path}\t${row.id}\t${row.version}`).join("\n")) : null,
  startMB: +(base / MB).toFixed(1),
  peakMB: +((peak - base) / MB).toFixed(1),
  keptMB: +(kept / MB).toFixed(1),
  processHighWaterMB: highWaterMB(),
  milliseconds: Math.round(milliseconds),
}));
vault.close();
