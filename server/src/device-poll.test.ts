// The one-time hand-over of a device's token, held to its rule at the two places the code keeps it. A poll after an
// allow is handed the token once; the sign-in is marked collected, and nothing may make a second token reach anyone.
//
// The Worker tests (device-approval.test.ts, identity-edges.test.ts) call the poll route one request at a time, or two
// together with the order left to chance. Neither can tell the two guards apart, so a guard could be taken out with
// every one of them still green. This file calls devices.poll itself, on the real database and the real migrations
// the Worker is built on, with the database wrapped so that:
//
//   - two polls are held until both have READ the sign-in as approved, and only then let go to write: the only thing
//     that stops the second is the `status = 'approved'` condition on the write that marks the sign-in collected;
//   - every write is recorded, so a poll of a sign-in that is already collected can be seen to touch nothing: the
//     check that turns it away before it gets as far as writing.

import { beforeAll, describe, expect, it } from "vitest";
import * as devices from "./devices";
import { cloudflareHost } from "./plugs/cloudflare/host";
import type { NexusHost, SqlDb } from "./ports";
import { Refusal } from "./refusal";
import { ORIGIN, appEnv, bodyOf, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { manage } from "./__fixtures__/identity-world";

let host: NexusHost;
let ownerCookie: string;

beforeAll(async () => {
  await setUpNexus();
  ownerCookie = (await signInOwner()).cookie;
  host = cloudflareHost(appEnv());
});

/** A sign-in started and allowed the way a device and the owner do it, through the real functions. */
async function allowedSignin(label: string): Promise<{ secret: string; code: string }> {
  const started = await devices.start(host, ORIGIN, { identity: "agents", label });
  await devices.approve(host, started.code);
  return { secret: started.secret, code: started.code };
}

/** What a poll was refused with, or null when it was not refused. */
async function refusedWith(poll: Promise<unknown>): Promise<number | null> {
  try {
    await poll;
    return null;
  } catch (error) {
    if (error instanceof Refusal) return error.status;
    throw error;
  }
}

/** The same host with its database wrapped. `read` and `write` see every call before it goes on. */
function watched(hooks: { read?: (sql: string) => Promise<void>; write?: (sql: string) => void }): NexusHost {
  const inner: SqlDb = host.sql;
  return {
    ...host,
    sql: {
      first: async (sql, params) => {
        await hooks.read?.(sql);
        return inner.first(sql, params);
      },
      all: (sql, params) => inner.all(sql, params),
      run: (sql, params) => {
        hooks.write?.(sql);
        return inner.run(sql, params);
      },
      batch: (statements) => {
        for (const statement of statements) hooks.write?.(statement.sql);
        return inner.batch(statements);
      },
    },
  };
}

const tokensLabelled = async (label: string) =>
  bodyOf(await manage({ cookie: ownerCookie }).tokens()).tokens.filter((t: { label: string }) => t.label === label);

describe("the token is handed over once", () => {
  it("goes to one of two polls that both found the sign-in approved, and the other is told the code is used", async () => {
    const { secret } = await allowedSignin("poll-both-read-first");

    // Each poll's read of the sign-in waits here until the other has made its own, so both see "approved".
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    // If the poll ever stops reading the sign-in twice over, do not hang: let go and let the assertion below say so.
    const giveUp = setTimeout(release, 2000);
    const racing = watched({
      read: async (sql) => {
        if (!/FROM nexus_signins WHERE secret_hash/.test(sql)) return;
        arrived += 1;
        if (arrived === 2) release();
        await bothRead;
      },
    });

    const results = await Promise.allSettled([devices.poll(racing, secret), devices.poll(racing, secret)]);
    clearTimeout(giveUp);

    expect(arrived, "both polls read the sign-in before either wrote").toBe(2);
    const handed = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ status: string; token?: string }>[];
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(handed.map((r) => r.value.status), "one poll is handed the token").toEqual(["approved"]);
    expect(typeof handed[0].value.token).toBe("string");
    expect(refused.map((r) => (r.reason as Refusal).status), "the other is told the code is used").toEqual([410]);
    expect(await tokensLabelled("poll-both-read-first"), "one sign-in, one token").toHaveLength(1);
  });

  it("turns a poll of a sign-in that is already collected away without writing anything", async () => {
    const { secret } = await allowedSignin("poll-after-collected");
    expect(await devices.poll(host, secret)).toMatchObject({ status: "approved" });

    const writes: string[] = [];
    const later = watched({ write: (sql) => writes.push(sql) });
    expect(await refusedWith(devices.poll(later, secret)), "the second poll").toBe(410);
    expect(await refusedWith(devices.poll(later, secret)), "the third poll").toBe(410);
    expect(writes, "a collected sign-in is not written to again").toEqual([]);
  });
});
