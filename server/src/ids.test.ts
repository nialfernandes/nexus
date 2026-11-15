// A note is named by an id the device chose (random, or made from a key it keeps), never by its path. The server takes 1 to 128 letters, digits,
// hyphens and underscores (what url-safe base64, hex and a UUID are written in, and the `n-1` of the examples) and
// refuses anything else, so a path, with its slashes and dots and spaces, cannot be used as an id by mistake.
// Through the Nexus Worker, as the owner (see __fixtures__/nexus-world.ts for the routes and the shape of every answer).

import { beforeAll, describe, expect, it } from "vitest";
import { GARDEN_V1 } from "./__fixtures__/device-blobs";
import { API, bodyOf, expectRefusal, send, setUpNexus, signInOwner, vault } from "./__fixtures__/nexus-world";

let owner: ReturnType<typeof vault>;
let cookie: string;

beforeAll(async () => {
  await setUpNexus();
  cookie = (await signInOwner()).cookie;
  owner = vault(cookie);
});

const ACCEPTED = [
  "n-1",
  "a",
  "0123456789abcdef0123456789abcdef",
  "3f2b8c1e-9d4a-4e7b-8a6c-1f0e2d3c4b5a",
  "q3Rk_9-Zx0Y8wV7uT6sR5qP4oN3mL2kJ1iH0gF9eD8c",
  "UPPER_and_lower-123",
  "x".repeat(128),
];

const REFUSED: Array<[unknown, string]> = [
  ["", "an empty id"],
  ["x".repeat(129), "an id of 129 characters"],
  ["Ideas/Podcast names.md", "a path"],
  ["Podcast names", "a name with a space"],
  ["notes.md", "a name with a dot"],
  ["a/b", "an id with a slash"],
  ["..", "two dots"],
  ["a\\b", "a backslash"],
  ["café", "an accent"],
  ["日本語", "letters that are not Latin"],
  ["tab\there", "a control character"],
  ["half \ud83c", "half a character"],
  [42, "a number"],
  [["n-1"], "a list"],
  [null, "null"],
];

describe("ids the server takes", () => {
  it.each(ACCEPTED)("%s goes in and comes back exactly", async (id) => {
    expect(bodyOf(await owner.save({ id, blob: GARDEN_V1.blob }, 0))).toMatchObject({ result: "saved", id, version: 1 });
    expect(bodyOf(await owner.note(id))).toMatchObject({ id, version: 1, blob: GARDEN_V1.blob });
    expect(bodyOf(await owner.history(id)).id).toBe(id);
    expect(bodyOf(await owner.list()).notes.map((n: { id: string }) => n.id)).toContain(id);
  });

  it("keeps the case of an id: Abc and abc are two notes", async () => {
    bodyOf(await owner.save({ id: "Case-Test", blob: GARDEN_V1.blob }, 0));
    expectRefusal(await owner.note("case-test"), 404, "the same letters in lower case");
  });
});

describe("ids the server refuses, because they could be a path or are not an id", () => {
  it.each(REFUSED)("%j (%s)", async (id, what) => {
    expectRefusal(await send("POST", `${API}/save`, cookie, { id, base: 0, kid: 1, blob: GARDEN_V1.blob }), 400, `a save with ${what}`);
    expectRefusal(await send("POST", `${API}/delete`, cookie, { id, base: 1 }), 400, `a delete with ${what}`);
    // A half of a character cannot be written in an address at all, so only the body routes meet it.
    if (typeof id === "string" && !/[\ud800-\udfff]/.test(id)) {
      expectRefusal(await send("GET", `${API}/note?id=${encodeURIComponent(id)}`, cookie), 400, `a read with ${what}`);
      expectRefusal(await send("GET", `${API}/history?id=${encodeURIComponent(id)}`, cookie), 400, `a history read with ${what}`);
    }
  });

  it("keeps nothing of any of them, and a read with no id at all is refused too", async () => {
    expectRefusal(await send("GET", `${API}/note`, cookie), 400, "a read with no id");
    expectRefusal(await send("GET", `${API}/history`, cookie), 400, "a history read with no id");
    const listed = bodyOf(await owner.list()).notes.map((n: { id: string }) => n.id);
    for (const [id] of REFUSED) if (typeof id === "string" && id !== "") expect(listed).not.toContain(id);
  });
});
