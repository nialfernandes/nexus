// An app inside the same Worker does not use a token: it calls Nexus's store through an in-worker function with its
// own identity's name, and what it may do is what a token holder may do.
//
// THE FUNCTION. The Cloudflare plug exports `nexusAsApp(env, identity)` (the Worker's own bindings, and the
// identity's name). It gives back an object of the store's calls, each of which
// resolves with exactly the JSON the matching route sends in a 200 answer, and rejects, for what a route would
// refuse, with an Error whose `status` is the route's status, whose message is the route's `error` and whose
// `details` hold what the route adds beside it (a refused save's `current`):
//
//   save({ id, base, kid, blob })   note(id, version?)   history(id)   list()   changes(after?, limit?)
//   remove(id, base)   wraps()
//
// An identity the function is given that does not exist is refused 403 on every call.

import { beforeAll, describe, expect, it } from "vitest";
import { GARDEN_V1, GARDEN_V2, PODCAST_V1 } from "./__fixtures__/device-blobs";
import { bodyOf, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { issueToken, vaultAs, workerEnv, type Who } from "./__fixtures__/identity-world";
import { nexusAsApp } from "./plugs/cloudflare/app";

interface AppNexus {
  save(input: { id: string; base: number; kid: number; blob: string }): Promise<any>;
  note(id: string, version?: number): Promise<any>;
  history(id: string): Promise<any>;
  list(): Promise<any>;
  changes(after?: string | number, limit?: number): Promise<any>;
  remove(id: string, base: number): Promise<any>;
  wraps(): Promise<any>;
}

const asApp = (identity: string): AppNexus => nexusAsApp(workerEnv(), identity) as unknown as AppNexus;

/** What an in-worker call was refused with. A call that was not refused fails the test. */
async function refusal(call: () => Promise<unknown>): Promise<{ status: number; message: string; details: unknown }> {
  try {
    await call();
  } catch (error) {
    const e = error as { status?: unknown; message?: unknown; details?: unknown };
    if (typeof e.status !== "number") throw error;
    return { status: e.status, message: String(e.message), details: e.details };
  }
  return expect.fail("the call was not refused");
}

let ownerCookie: string;
let owner: Who;

beforeAll(async () => {
  await setUpNexus();
  ownerCookie = (await signInOwner()).cookie;
  owner = { cookie: ownerCookie };
});

describe("recorder, inside the Worker, uses the store with no token", () => {
  it("saves a blob, and the version's writer reads recorder", async () => {
    const recorder = asApp("recorder");
    expect(await recorder.save({ id: "app-1", base: 0, kid: 1, blob: GARDEN_V1.blob })).toEqual({ result: "saved", id: "app-1", version: 1 });
    expect(bodyOf(await vaultAs(owner).note("app-1"))).toMatchObject({ writer: "recorder", blob: GARDEN_V1.blob });
  });

  it("reads, lists, follows the feed and deletes what it or anyone saved", async () => {
    const recorder = asApp("recorder");
    bodyOf(await vaultAs(owner).save(PODCAST_V1, 0));
    expect(await recorder.note(PODCAST_V1.id)).toMatchObject({ version: 1, blob: PODCAST_V1.blob });
    expect((await recorder.history(PODCAST_V1.id)).versions).toHaveLength(1);
    expect((await recorder.list()).notes.map((n: { id: string }) => n.id)).toContain(PODCAST_V1.id);
    expect((await recorder.changes()).changes.map((c: { id: string }) => c.id)).toContain(PODCAST_V1.id);
    expect(await recorder.remove(PODCAST_V1.id, 1)).toMatchObject({ result: "deleted", version: 2 });
    expect((await recorder.wraps()).wraps).toEqual([]);
  });

  it("is refused 409 with the current version, as a route would, for a save from an old version", async () => {
    const agents = asApp("agents");
    await agents.save({ id: "app-stale", base: 0, kid: 1, blob: GARDEN_V1.blob });
    await agents.save({ id: "app-stale", base: 1, kid: 1, blob: GARDEN_V2.blob });
    const refused = await refusal(() => agents.save({ id: "app-stale", base: 1, kid: 1, blob: GARDEN_V1.blob }));
    expect(refused.status).toBe(409);
    expect(refused.details).toEqual({ current: 2 });
  });

  it("is refused 400 for a save that is not a save, as a route would", async () => {
    const recorder = asApp("recorder");
    expect((await refusal(() => recorder.save({ id: "a/b", base: 0, kid: 1, blob: GARDEN_V1.blob }))).status).toBe(400);
    expect((await refusal(() => recorder.save({ id: "app-bad", base: 0, kid: 1, blob: "not base64!" }))).status).toBe(400);
    expect((await refusal(() => recorder.save({ id: "app-bad", base: 0, kid: 1, blob: GARDEN_V1.blob, path: "x" } as never))).status).toBe(400);
  });
});

describe("an app obeys the same answers as a token holder", () => {
  it("gets the same answer as a token for the same identity, call for call", async () => {
    const { token } = await issueToken(ownerCookie, "agents", "app-parity");
    const viaToken = vaultAs({ bearer: token });
    const agents = asApp("agents");

    const a = bodyOf(await viaToken.save({ id: "parity-1", blob: GARDEN_V1.blob }, 0));
    const b = await agents.save({ id: "parity-2", base: 0, kid: 1, blob: GARDEN_V1.blob });
    expect({ ...a, id: "x" }).toEqual({ ...b, id: "x" });

    expect(await agents.note("parity-1")).toEqual(bodyOf(await viaToken.note("parity-1")));
    expect(await agents.history("parity-1")).toEqual(bodyOf(await viaToken.history("parity-1")));
    expect(await agents.list()).toEqual(bodyOf(await viaToken.list()));
    expect(await agents.changes(undefined, 500)).toEqual(bodyOf(await viaToken.changes(undefined, 500)));
    expect(await agents.wraps()).toEqual(bodyOf(await viaToken.wraps()));
  });

  it("holds an identity that does not exist to 403 on every call", async () => {
    const ghost = asApp("nobody-by-this-name");
    for (const call of [
      () => ghost.save({ id: "ghost-1", base: 0, kid: 1, blob: GARDEN_V1.blob }),
      () => ghost.note("parity-1"),
      () => ghost.history("parity-1"),
      () => ghost.list(),
      () => ghost.changes(),
      () => ghost.remove("parity-1", 1),
      () => ghost.wraps(),
    ]) {
      expect((await refusal(call)).status).toBe(403);
    }
    expect((await vaultAs(owner).note("ghost-1")).status, "the ghost saved nothing").toBe(404);
  });
});
