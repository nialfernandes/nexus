// Two things a stranger or a forgotten approval must not be able to do to the device sign-in (card #707, #706):
//
//   1. Fill the waiting list. Starting a sign-in needs no credential, so besides the count of all sign-ins waiting (200) there is a
//      count per caller: at most MAX_WAITING_PER_CALLER from one address at a time, a 429 in plain words, while another address can
//      still start one. The address comes from the host (ports.ts `network`, the Cloudflare plug reads `cf-connecting-ip`); where a
//      host gives none, only the count of all applies.
//   2. Leave a working token behind. Allowing a sign-in makes its token at once. A sign-in that was allowed and then ran out with
//      its device never collecting it has that token revoked, unless it was used, wherever old sign-ins are swept.
//
// All of it through the real Worker, the real migrations and the real routes (a clock moved with Date only, as the other device tests do).

import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_WAITING, MAX_WAITING_PER_CALLER } from "./devices";
import { cloudflareHost } from "./plugs/cloudflare/host";
import worker from "./plugs/cloudflare/worker";
import { runNexus } from "./routes";
import { API, ORIGIN, appEnv, bodyOf, expectRefusal, nexusEnv, send, setUpNexus, signInOwner, type Answer } from "./__fixtures__/nexus-world";
import { device, issueToken, manage, vaultAs, type Who } from "./__fixtures__/identity-world";

const TEN_MINUTES = 10 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

let ownerCookie: string;
let owner: Who;

beforeAll(async () => {
  await setUpNexus();
  ownerCookie = (await signInOwner()).cookie;
  owner = { cookie: ownerCookie };
});

afterEach(() => {
  vi.useRealTimers();
});

/** A device starting a sign-in as Cloudflare would hand it over: from `address` (the header the Cloudflare plug reads), or from none. */
async function startFrom(address: string | null, label: string): Promise<Answer> {
  const res = await worker.fetch(
    new Request(`${ORIGIN}${API}/device/start`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(address === null ? {} : { "cf-connecting-ip": address }) },
      body: JSON.stringify({ identity: "agents", label }),
    }),
    appEnv(),
  );
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text, location: null };
}

/** The labels of the tokens that work, as the owner sees them. */
async function liveTokens(...labels: string[]): Promise<string[]> {
  const all = bodyOf(await manage(owner).tokens()).tokens as Array<{ label: string }>;
  return all.map((t) => t.label).filter((label) => labels.includes(label));
}

/** A sign-in the owner allowed and its device never collected: started, then allowed, and never polled. */
async function allowedAndLeft(label: string): Promise<{ code: string; secret: string }> {
  const started = bodyOf(await device().start("agents", label));
  bodyOf(await device(owner).approve(started.code));
  return started;
}

describe("one caller cannot fill the waiting list", () => {
  it("lets one address start sign-ins up to the cap, refuses the next with a 429 in plain words, and still lets a second address start one", async () => {
    for (let i = 1; i <= MAX_WAITING_PER_CALLER; i++) bodyOf(await startFrom("203.0.113.7", `lab-cap-${i}`));
    const refused = await startFrom("203.0.113.7", "lab-cap-over");
    expectRefusal(refused, 429, "the sign-in over the cap");
    expect(refused.body.error).toMatch(/already have \d+ sign-ins waiting/);
    expect(refused.body.error, "it names no address").not.toContain("203.0.113.7");
    expect(bodyOf(await startFrom("203.0.113.8", "lab-cap-other")), "a second address is not held back by the first").toHaveProperty("code");
  });

  it("counts only sign-ins that are still waiting: an answered one or one that ran out gives its place back", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const mine: Array<{ code: string }> = [];
    for (let i = 1; i <= MAX_WAITING_PER_CALLER; i++) mine.push(bodyOf(await startFrom("203.0.113.20", `lab-free-${i}`)));
    expectRefusal(await startFrom("203.0.113.20", "lab-free-over"), 429);

    bodyOf(await device(owner).deny(mine[0]!.code));
    bodyOf(await startFrom("203.0.113.20", "lab-free-after-deny"));
    expectRefusal(await startFrom("203.0.113.20", "lab-free-over-again"), 429);

    bodyOf(await device(owner).approve(mine[1]!.code));
    bodyOf(await startFrom("203.0.113.20", "lab-free-after-approve"));
    expectRefusal(await startFrom("203.0.113.20", "lab-free-over-once-more"), 429);

    vi.setSystemTime(now + TEN_MINUTES + 1000);
    bodyOf(await startFrom("203.0.113.20", "lab-free-after-expiry"));
  });

  it("tells an IPv6 caller by its /64: changing the end of the address does not make a new caller, another /64 is one", async () => {
    for (let i = 1; i <= MAX_WAITING_PER_CALLER; i++) bodyOf(await startFrom(`2001:db8:1:2:${i}::${i}`, `lab-v6-${i}`));
    expectRefusal(await startFrom("2001:db8:1:2:ffff:ffff:ffff:ffff", "lab-v6-over"), 429);
    bodyOf(await startFrom("2001:db8:1:3::1", "lab-v6-next-64"));
  });

  it("keeps no address: only a hash of it is kept beside the sign-in", async () => {
    bodyOf(await startFrom("198.51.100.99", "lab-no-plain-address"));
    const rows = await appEnv().NEXUS_DB!.prepare("SELECT * FROM nexus_signins WHERE label = 'lab-no-plain-address'").all<{ caller: string }>();
    expect(rows.results).toHaveLength(1);
    expect(JSON.stringify(rows.results)).not.toContain("198.51.100.99");
    expect(rows.results[0]!.caller).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a host that gives no caller address", () => {
  it("still starts sign-ins up to the count of all waiting, and the next one is refused for that count, whoever sends it", async () => {
    // A world of its own: this fills the waiting list, which the other tests in this file must not meet full.
    const env = await nexusEnv();
    expect((await send("POST", `${API}/identity`, ownerCookie, { name: "agents", kind: "agent" }, env)).status).toBe(200);
    // The request carries an address header, as it would on Cloudflare, but this host's network plug says it cannot tell who called:
    // devices.ts must not look at the header itself, and nothing but the count of all sign-ins applies.
    const host = { ...cloudflareHost(env), network: { callerAddress: () => null } };
    const startOnHost = async (label: string) => {
      const res = await runNexus(
        new Request(`${ORIGIN}${API}/device/start`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
          body: JSON.stringify({ identity: "agents", label }),
        }),
        host,
      );
      return { status: res.status, body: await res.json() as { error?: string } };
    };

    for (let i = 0; i < MAX_WAITING; i++) {
      const answer = await startOnHost(`lab-open-${i}`);
      if (answer.status !== 200) throw new Error(`sign-in ${i + 1} of ${MAX_WAITING} was refused: ${answer.status} ${answer.body.error}`);
    }
    const over = await startOnHost("lab-open-over");
    expect(over.status).toBe(429);
    expect(over.body.error, "refused for the count of all, not for a caller").toMatch(/Too many sign-ins are waiting/);
  });
});

describe("an allowed sign-in that nobody collects has its token revoked when it runs out", () => {
  it("revokes it at the next start once the sign-in has run out, and not before; a token that was collected and used stays", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);

    // A token the way a device gets one, and used.
    const used = await issueToken(ownerCookie, "agents", "lab-revoke-collected-and-used");
    expect((await vaultAs({ bearer: used.token }).list()).status).toBe(200);
    // One that was collected and never used.
    await issueToken(ownerCookie, "agents", "lab-revoke-collected-unused");
    // One that was allowed and never polled.
    await allowedAndLeft("lab-revoke-uncollected");
    const all = ["lab-revoke-collected-and-used", "lab-revoke-collected-unused", "lab-revoke-uncollected"];

    // Still inside its ten minutes: another device's start sweeps and leaves it, the owner may yet see it collected.
    vi.setSystemTime(now + TEN_MINUTES - 1000);
    bodyOf(await device().start("agents", "lab-revoke-start-early"));
    expect(await liveTokens(...all)).toEqual(expect.arrayContaining(all));

    vi.setSystemTime(now + TEN_MINUTES + 1000);
    bodyOf(await device().start("agents", "lab-revoke-start-late"));
    expect(await liveTokens(...all)).toEqual(expect.arrayContaining(["lab-revoke-collected-and-used", "lab-revoke-collected-unused"]));
    expect(await liveTokens(...all), "the uncollected token is no longer listed").not.toContain("lab-revoke-uncollected");
    expect((await vaultAs({ bearer: used.token }).list()).status, "the token that was used still works").toBe(200);
  });

  it("revokes it when the next start is long after, more than an hour, when the sign-in itself is swept away in the same batch", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await allowedAndLeft("lab-revoke-hour-later");
    vi.setSystemTime(now + TEN_MINUTES + ONE_HOUR + 1000);
    bodyOf(await device().start("agents", "lab-revoke-hour-later-start"));
    expect(await liveTokens("lab-revoke-hour-later")).toEqual([]);
  });

  it("revokes it at the next allow, which sweeps as a start does", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await allowedAndLeft("lab-revoke-by-allow");
    // Another sign-in is started a second before the first runs out (that start sweeps nothing yet), and allowed a second after.
    vi.setSystemTime(now + TEN_MINUTES - 1000);
    const later = bodyOf(await device().start("agents", "lab-revoke-by-allow-later"));
    vi.setSystemTime(now + TEN_MINUTES + 1000);
    expect(await liveTokens("lab-revoke-by-allow"), "nothing has swept yet").toEqual(["lab-revoke-by-allow"]);
    bodyOf(await device(owner).approve(later.code));
    expect(await liveTokens("lab-revoke-by-allow"), "the allow swept it").toEqual([]);
    expect(await liveTokens("lab-revoke-by-allow-later"), "and left the sign-in it allowed").toEqual(["lab-revoke-by-allow-later"]);
  });

  it("revokes it when its own device polls after it ran out, and the device is told it ran out", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const left = await allowedAndLeft("lab-revoke-by-poll");
    vi.setSystemTime(now + TEN_MINUTES + 1000);
    expect(await liveTokens("lab-revoke-by-poll"), "nothing has swept yet").toEqual(["lab-revoke-by-poll"]);
    const polled = await device().poll(left.secret);
    expect(polled.status).toBe(410);
    expect(polled.body.reason).toBe("expired");
    expect(await liveTokens("lab-revoke-by-poll")).toEqual([]);
  });

  it("leaves a token alone that its device worked out from its secret and used without ever polling", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const left = await allowedAndLeft("lab-revoke-used-unpolled");
    // The device knows its secret, so it can work the token out itself (devices.ts `tokenOf`) and use it without a poll.
    const token = "nx_" + createHash("sha256").update(`nexus device token:${left.secret}`).digest("hex");
    expect((await vaultAs({ bearer: token }).list()).status).toBe(200);
    vi.setSystemTime(now + TEN_MINUTES + 1000);
    bodyOf(await device().start("agents", "lab-revoke-used-unpolled-start"));
    expect(await liveTokens("lab-revoke-used-unpolled")).toEqual(["lab-revoke-used-unpolled"]);
    expect((await vaultAs({ bearer: token }).list()).status).toBe(200);
  });
});
