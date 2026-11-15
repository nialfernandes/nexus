// Opening a large vault takes a Worker's memory, so it is measured. A vault of 2,000 notes the size of a transcript, each saved five times as it
// grew, is made through the server's own routes (every version is a version Nexus holds). The built library then opens it in a process of its
// own (tests/measure-open.mjs), over a real socket to the server's code, and says how much memory the open took: as it is, with the garbage
// that has not been collected yet, and live, which is what the open has to hold at once and what a Worker at its limit has to find room for.
// A Worker has 128 MB for all it holds; the open has to hold under half of that.
//
// To measure another build of the library, say an older one: NEXUS_MEASURE_LIBRARY=/path/to/nexus-agent.js npx vitest run tests/open-memory.test.ts
// prints that build's figures and checks only what an older library can answer.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blobFor } from "../../../plugin/tests/world";
import { agentCredentials, openWorld, serveNexus, setUpVault } from "./world";

const NOTES = 2_000;
const VERSIONS = 5;
/** Half of a Worker's 128 MB: what the open may hold at once, above what the library held before it looked at the vault. */
const LIMIT_MB = 64;

let directory = "";
let library = "";

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "nexus-agent-memory-"));
  execFileSync("node", [join(import.meta.dirname, "../scripts/build.mjs"), directory], { cwd: join(import.meta.dirname, ".."), stdio: "pipe" });
  library = process.env.NEXUS_MEASURE_LIBRARY ?? join(directory, "nexus-agent.js");
}, 120_000);

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true });
});

/** A small fixed generator, so every run makes the same notes. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = "so then we talked about the plan for next week and whether the numbers from the last review still hold because the team had some questions about how it was measured and who would write it up before the call on friday".split(" ");

/** A transcript of about 20 KB: timed lines with a speaker. Version `version` of 5 holds the first `version / 5` of the lines, as a transcript grows while it is written. */
function transcript(note: number, version: number): string {
  const next = random(note + 1);
  const lines: string[] = [];
  for (let line = 0; line < 250; line++) {
    const words = Array.from({ length: 10 + Math.floor(next() * 8) }, () => WORDS[Math.floor(next() * WORDS.length)]);
    lines.push(`[${String(Math.floor(line / 60)).padStart(2, "0")}:${String(line % 60).padStart(2, "0")}:00] Speaker ${1 + Math.floor(next() * 3)}: ${words.join(" ")}.`);
  }
  return `${lines.slice(0, Math.ceil((lines.length * version) / VERSIONS)).join("\n")}\n`;
}

describe("opening a vault of 2,000 notes the size of a transcript", () => {
  it("takes less than 64 MB above the library's own, and learns every path, id and version", async () => {
    const world = await openWorld();
    await setUpVault(world);
    const credentials = await agentCredentials(world);

    // The vault: 2,000 notes, each saved five times. The texts are what a transcript writer saves; the blobs are encrypted as the plugin's are.
    const expected: Array<{ path: string; id: string; version: number }> = [];
    let base64Held = 0;
    for (let note = 0; note < NOTES; note++) {
      const id = `transcript-${String(note).padStart(5, "0")}`;
      const path = `Transcripts/2026-11-15 call ${String(note).padStart(4, "0")}.md`;
      for (let version = 1; version <= VERSIONS; version++) {
        const blob = await blobFor(world.keys, id, path, transcript(note, version));
        const saved = await world.agents.save(id, blob, { base: version - 1, kid: world.keys.kid });
        expect(saved.status, saved.text.slice(0, 100)).toBe(200);
        base64Held += blob.length;
      }
      expected.push({ path, id, version: VERSIONS });
    }
    expected.sort((a, b) => (a.path < b.path ? -1 : 1));
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");

    const server = await serveNexus();
    const measure = async (mode: "as it is" | "live"): Promise<Record<string, number | string | null>> => {
      const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", join(import.meta.dirname, "measure-open.mjs"), library, ...(mode === "live" ? ["live"] : [])], {
        env: { ...process.env, NEXUS_ADDRESS: server.address, NEXUS_TOKEN: credentials.token, NEXUS_AGENT_PRIVATE_KEY: credentials.privateKey, NEXUS_AGENT_APPROVAL: credentials.approval },
        maxBuffer: 1024 * 1024,
      });
      const measured = JSON.parse(stdout.trim().split("\n").pop()!) as Record<string, number | string | null>;
      console.log(`open of ${NOTES} notes of ${VERSIONS} versions (${(base64Held / 1024 / 1024).toFixed(0)} MB of base64 in the changes feed), measured ${mode}: ${JSON.stringify(measured)}`);
      return measured;
    };
    try {
      const asItIs = await measure("as it is");
      const live = await measure("live");
      const pinned = process.env.NEXUS_MEASURE_LIBRARY === undefined;

      for (const measured of [asItIs, live]) {
        expect(measured.notes).toBe(NOTES);
        expect(measured.pathsSha256, "the paths").toBe(sha(expected.map((row) => row.path).join("\n")));
        if (pinned) expect(measured.idsAndVersionsSha256, "the paths, ids and versions").toBe(sha(expected.map((row) => `${row.path}\t${row.id}\t${row.version}`).join("\n")));
      }
      if (pinned) {
        expect(live.peakMB as number, "the most the open has to hold at once, above what the library held before it").toBeLessThan(LIMIT_MB);
        expect(live.keptMB as number, "what the vault holds once it has opened").toBeLessThan(8);
      }
    } finally {
      await server.close();
    }
  }, 600_000);
});
