// `nexus-agent join` when the sign-in does not end well: the owner turns it down, or it runs out. It ends with exit code 1, prints no
// value, and says what Nexus itself said: the words are not the command's own, so the test reads them from the answer Nexus gave and
// looks for them in what the command printed. (sign-in and the owner's commands keep their own fixed sentences.)

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV } from "../src/cli/labels";
import type { FetchLike } from "../src/nexus";
import { ADDRESS, askNexus, bodyOf, fetchOverNexus, openWorld, run, type World } from "./world";

let world: World;
let fetched: ReturnType<typeof fetchOverNexus>;
/** The text of every answer Nexus gave to a poll, in order. */
let polls: string[];

beforeEach(async () => {
  world = await openWorld();
  fetched = fetchOverNexus();
  polls = [];
  bodyOf(await askNexus("POST", "identity", { cookie: world.ownerCookie }, { name: "scribe", kind: "agent" }));
});

/** The agent's fetch, writing down what Nexus said to each poll. */
const listening: FetchLike = async (url, init) => {
  const answer = await fetched.fetch(url, init);
  const text = await answer.text();
  if (url.endsWith("/device/poll")) polls.push(text);
  return { status: answer.status, text: async () => text };
};

const signInCodeIn = (stderr: string): string => /sign-in code: ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(stderr)![1]!;

/** What Nexus said in its last answer to a poll. */
const lastWordsOfNexus = (): string => JSON.parse(polls.at(-1)!).error as string;

describe("nexus-agent join, when it is refused", () => {
  it("ends with Nexus's own words when the owner denies the sign-in, and prints no value", async () => {
    const ran = await run(["join", "scribe"], {
      env: { [ENV.address]: ADDRESS }, fetch: listening,
      onWait: async (printed) => void bodyOf(await askNexus("POST", "device/deny", { cookie: world.ownerCookie }, { code: signInCodeIn(printed.stderr) })),
    });
    expect(ran.code).toBe(1);
    expect(ran.stdout, "nothing was given, so nothing is printed").toBe("");
    expect(lastWordsOfNexus(), "Nexus said something to the poll").toMatch(/\w/);
    expect(ran.stderr.trimEnd().split("\n").at(-1)).toBe(`nexus-agent: ${lastWordsOfNexus()}`);
  });

  it("ends with Nexus's own words when the ten minutes run out, as Nexus counts them, and prints no value", async () => {
    // Nexus reads the clock for its sign-ins: moving the clock past ten minutes is what makes it say the code has run out.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const ran = await run(["join", "scribe"], {
        env: { [ENV.address]: ADDRESS }, fetch: listening,
        onWait: () => void vi.setSystemTime(Date.now() + 11 * 60 * 1000),
      });
      expect(ran.code).toBe(1);
      expect(ran.stdout).toBe("");
      expect(lastWordsOfNexus()).toBe("That code has run out.");
      expect(ran.stderr.trimEnd().split("\n").at(-1)).toBe(`nexus-agent: ${lastWordsOfNexus()}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends with Nexus's own words when the sign-in was already used (the poll after the key was collected)", async () => {
    // The secret never leaves the command, so the test reads it from Nexus's answer to the start, as a person who could see the network would,
    // lets the owner allow the sign-in, and collects the token with that secret before the command's own poll does. The command's next poll
    // is then the one Nexus refuses.
    let secret: string | undefined;
    const spying: FetchLike = async (url, init) => {
      const answer = await listening(url, init);
      if (url.endsWith("/device/start")) secret = JSON.parse(await answer.text()).secret;
      return answer;
    };
    const ran = await run(["join", "scribe"], {
      env: { [ENV.address]: ADDRESS }, fetch: spying,
      onWait: async (printed) => {
        const code = signInCodeIn(printed.stderr);
        bodyOf(await askNexus("POST", "device/approve", { cookie: world.ownerCookie }, { code }));
        bodyOf(await askNexus("POST", "device/poll", null, { secret }));
      },
    });
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe("");
    expect(lastWordsOfNexus()).toBe("That code was already used.");
    expect(ran.stderr.trimEnd().split("\n").at(-1)).toBe(`nexus-agent: ${lastWordsOfNexus()}`);
  });
});
