// The edges of Nexus that the main tests do not reach: what the routes say to a request they cannot use, what the
// changes feed asks for as a cursor, and a request too big to read. Through the Nexus Worker, as the owner (see
// __fixtures__/nexus-world.ts).

import { beforeAll, describe, expect, it } from "vitest";
import worker from "./plugs/cloudflare/worker";
import { GARDEN_V1, GARDEN_V2 } from "./__fixtures__/device-blobs";
import { API, ORIGIN, appEnv, bodyOf, expectRefusal, send, setUpNexus, signInOwner, vault } from "./__fixtures__/nexus-world";

let owner: ReturnType<typeof vault>;
let cookie: string;

beforeAll(async () => {
  await setUpNexus();
  cookie = (await signInOwner()).cookie;
  owner = vault(cookie);
});

describe("what the routes say to a request they cannot use", () => {
  it("answers 404 to a route it does not have and 405 to the wrong method, as JSON", async () => {
    expectRefusal(await send("GET", `${API}/nothing`, cookie), 404, "an unknown route");
    expectRefusal(await send("GET", `${API}/save`, cookie), 405, "a read of the save route");
    expectRefusal(await send("POST", `${API}/list`, cookie, {}), 405, "a post to the list route");
    expectRefusal(await send("POST", `${API}/wraps`, cookie, {}), 405, "a post to the wraps route");
  });

  it("refuses a body that is not a JSON object", async () => {
    expectRefusal(await send("POST", `${API}/save`, cookie, [1, 2]), 400, "an array");
    expectRefusal(await send("POST", `${API}/save`, cookie, "text"), 400, "a bare string");
    expectRefusal(await send("POST", `${API}/delete`, cookie, {}), 400, "a delete with no id");
  });

  it("refuses a body that is not JSON at all, and says so without repeating it", async () => {
    const answer = await worker.fetch(
      new Request(`${ORIGIN}${API}/save`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{ not json: Projects/Garden plan.md" }),
      appEnv(),
    );
    expect(answer.status).toBe(400);
    expect(await answer.text()).not.toContain("Garden plan");
  });

  it("takes a version a save made as a note's version, and a second blob at the same version is a refusal, not a new note", async () => {
    bodyOf(await owner.save({ id: "edge-same", blob: GARDEN_V1.blob }, 0));
    expectRefusal(await owner.save({ id: "edge-same", blob: GARDEN_V2.blob }, 0), 409, "a second blob at version 0");
    expect(bodyOf(await owner.list()).notes.filter((n: { id: string }) => n.id === "edge-same")).toHaveLength(1);
  });
});

describe("the changes feed asks for a cursor it gave", () => {
  it("refuses a cursor or a limit that is not a number, and accepts the cursor as a number", async () => {
    for (let n = 0; n < 12; n++) bodyOf(await owner.save({ id: `edge-feed-${n}`, blob: GARDEN_V1.blob }, 0));

    expectRefusal(await send("GET", `${API}/changes?after=abc`, cookie), 400, "a cursor that is a word");
    expectRefusal(await send("GET", `${API}/changes?after=-1`, cookie), 400, "a cursor below nothing");
    expectRefusal(await send("GET", `${API}/changes?limit=0`, cookie), 400, "a limit of none");
    expectRefusal(await send("GET", `${API}/changes?limit=lots`, cookie), 400, "a limit that is a word");

    const all = bodyOf(await owner.changes(undefined, 500)).changes;
    expect(all.length).toBeGreaterThan(10);
    const first = bodyOf(await owner.changes(0, 1));
    expect(first.changes).toHaveLength(1);
    expect(bodyOf(await owner.changes(Number(first.next), 500)).changes).toHaveLength(all.length - 1);
  });

  it("gives back the cursor it was given when there is nothing new, so asking again is always safe", async () => {
    const end = bodyOf(await owner.changes(undefined, 500)).next;
    expect(bodyOf(await owner.changes(end, 500))).toEqual({ changes: [], next: end });
  });

  it("carries no blob for a delete, and the blob of a save as it was sent", async () => {
    bodyOf(await owner.save({ id: "edge-del", blob: GARDEN_V2.blob }, 0));
    bodyOf(await owner.remove("edge-del", 1));
    const changes = bodyOf(await owner.changes(undefined, 500)).changes as Array<Record<string, unknown>>;
    const mine = changes.filter((c) => c.id === "edge-del");
    expect(mine.map((c) => c.kind)).toEqual(["save", "delete"]);
    expect(mine[0].blob).toBe(GARDEN_V2.blob);
    expect(mine[1]).not.toHaveProperty("blob");
  });
});

describe("a request too big to read", () => {
  it("is turned away by its declared size before it is read", async () => {
    const huge = await worker.fetch(
      new Request(`${ORIGIN}${API}/save`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "content-length": "9000000" },
        body: JSON.stringify({ id: "edge-too-big", base: 0, kid: 1, blob: GARDEN_V1.blob }),
      }),
      appEnv(),
    );
    expect(huge.status).toBe(413);
    expectRefusal(await owner.note("edge-too-big"), 404, "the note that was turned away");
  });
});
