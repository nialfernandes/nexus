// The edges of Nexus that the main tests do not reach: what a save refuses, how a clash is resolved
// when more than one waits, what happens to a deleted or moved note when a stale save arrives, and what the routes
// say to a request they cannot use. Through the Nexus Worker, as the owner (see __fixtures__/nexus-world.ts).

import { beforeAll, describe, expect, it } from "vitest";
import worker from "./plugs/cloudflare/worker";
import { API, ORIGIN, appEnv, bodyOf, expectRefusal, send, setUpNexus, signInOwner, vault } from "./__fixtures__/nexus-world";

let owner: ReturnType<typeof vault>;
let cookie: string;

type Entry = { version: number; kind: string; clash: boolean; from?: string; resolves?: number };

beforeAll(async () => {
  await setUpNexus();
  cookie = (await signInOwner()).cookie;
  owner = vault(cookie);
});

describe("a save that starts from a version that cannot be", () => {
  it("is refused when the note is not there, and makes no note", async () => {
    expectRefusal(await owner.save("Edge/never.md", "x\n", { base: 1 }), 404, "a base on a note that does not exist");
    expectRefusal(await owner.note("Edge/never.md"), 404, "the note that was never made");
  });

  it("is refused when the base is not a version of the note, and keeps nothing", async () => {
    bodyOf(await owner.save("Edge/base.md", "one\n"));
    for (const base of [2, 99, 0, -1, 1.5]) {
      expectRefusal(await owner.save("Edge/base.md", "two\n", { base }), 400, `base ${base}`);
    }
    expect(bodyOf(await owner.history("Edge/base.md")).versions).toHaveLength(1);
  });

  it("is refused when the base is a clash version, which is not the note's text", async () => {
    bodyOf(await owner.save("Edge/clash-base.md", "one\ntwo\n"));
    bodyOf(await owner.save("Edge/clash-base.md", "one\nTWO\n", { base: 1 }));
    expect(bodyOf(await owner.save("Edge/clash-base.md", "one\nDEUX\n", { base: 1 }), 409).incoming.version).toBe(3);
    expectRefusal(await owner.save("Edge/clash-base.md", "one\nTRES\n", { base: 3 }), 400, "a base that is a clash version");
  });
});

describe("resolving clashes", () => {
  it("is refused unless it names the latest version as base and a clash version that waits", async () => {
    bodyOf(await owner.save("Edge/resolve.md", "one\ntwo\n"));
    bodyOf(await owner.save("Edge/resolve.md", "one\nTWO\n", { base: 1 }));
    expect(bodyOf(await owner.save("Edge/resolve.md", "one\nDEUX\n", { base: 1 }), 409).result).toBe("clash");

    expectRefusal(await owner.save("Edge/resolve.md", "one\nBOTH\n", { base: 1, resolves: 3 }), 400, "a resolving save from an old base");
    expectRefusal(await owner.save("Edge/resolve.md", "one\nBOTH\n", { resolves: 3 }), 400, "a resolving save with no base");
    expectRefusal(await owner.save("Edge/resolve.md", "one\nBOTH\n", { base: 2, resolves: 2 }), 400, "resolving a version that is no clash");
    expectRefusal(await owner.save("Edge/resolve.md", "one\nBOTH\n", { base: 2, resolves: 9 }), 400, "resolving a version that is not there");
    expect(bodyOf(await owner.note("Edge/resolve.md"))).toMatchObject({ version: 2, clash: true });

    expect(bodyOf(await owner.save("Edge/resolve.md", "one\nBOTH\n", { base: 2, resolves: 3 }))).toMatchObject({ version: 4 });
    expectRefusal(await owner.save("Edge/resolve.md", "one\nAGAIN\n", { base: 4, resolves: 3 }), 400, "resolving the same clash twice");
  });

  it("keeps the note flagged until every clash version has been resolved", async () => {
    bodyOf(await owner.save("Edge/two-clashes.md", "one\ntwo\nthree\n"));
    bodyOf(await owner.save("Edge/two-clashes.md", "one\nTWO\nthree\n", { base: 1 }));
    expect(bodyOf(await owner.save("Edge/two-clashes.md", "one\nDEUX\nthree\n", { base: 1 }), 409).incoming.version).toBe(3);
    expect(bodyOf(await owner.save("Edge/two-clashes.md", "one\nZWEI\nthree\n", { base: 1 }), 409).incoming.version).toBe(4);

    bodyOf(await owner.save("Edge/two-clashes.md", "one\nTWO and DEUX\nthree\n", { base: 2, resolves: 3 }));
    expect(bodyOf(await owner.note("Edge/two-clashes.md")).clash, "one clash still waits").toBe(true);

    bodyOf(await owner.save("Edge/two-clashes.md", "one\nall three\nthree\n", { base: 5, resolves: 4 }));
    expect(bodyOf(await owner.note("Edge/two-clashes.md")).clash, "none waits").toBe(false);

    const history = bodyOf(await owner.history("Edge/two-clashes.md")).versions as Entry[];
    expect(history.map((v) => [v.version, v.resolves ?? null])).toEqual([[1, null], [2, null], [3, null], [4, null], [5, 3], [6, 4]]);
  });

  it("is not needed for a stale save that merges, which leaves a waiting clash waiting", async () => {
    bodyOf(await owner.save("Edge/still-open.md", "a\nb\nc\nd\n"));
    bodyOf(await owner.save("Edge/still-open.md", "a\nB\nc\nd\n", { base: 1 }));
    bodyOf(await owner.save("Edge/still-open.md", "a\nBEE\nc\nd\n", { base: 1 }), 409);
    expect(bodyOf(await owner.save("Edge/still-open.md", "a\nb\nc\nD\n", { base: 1 }))).toMatchObject({ result: "merged", version: 4 });
    expect(bodyOf(await owner.note("Edge/still-open.md"))).toMatchObject({ version: 4, text: "a\nB\nc\nD\n", clash: true });
  });
});

describe("deleted and moved notes meet saves that did not know", () => {
  it("brings a deleted note back for a save with no base, with its history intact", async () => {
    bodyOf(await owner.save("Edge/gone.md", "first\n"));
    bodyOf(await owner.remove("Edge/gone.md"));
    expect(bodyOf(await owner.save("Edge/gone.md", "back again\n"))).toMatchObject({ result: "saved", version: 3 });
    expect(bodyOf(await owner.note("Edge/gone.md"))).toMatchObject({ version: 3, text: "back again\n" });
    expect(bodyOf(await owner.history("Edge/gone.md")).versions.map((v: Entry) => v.kind)).toEqual(["save", "delete", "save"]);
  });

  it("keeps a stale save to a deleted note as a clash, and does not bring the note back", async () => {
    bodyOf(await owner.save("Edge/deleted-stale.md", "one\ntwo\n"));
    bodyOf(await owner.save("Edge/deleted-stale.md", "one\nTWO\n", { base: 1 }));
    bodyOf(await owner.remove("Edge/deleted-stale.md"));
    const clash = bodyOf(await owner.save("Edge/deleted-stale.md", "ONE\ntwo\n", { base: 1 }), 409);
    expect(clash.incoming).toMatchObject({ version: 4, text: "ONE\ntwo\n" });
    expectRefusal(await owner.note("Edge/deleted-stale.md"), 404, "the note stays deleted");
    expect(bodyOf(await owner.list("Edge")).notes.map((n: { path: string }) => n.path)).not.toContain("Edge/deleted-stale.md");
  });

  it("does not delete a note twice, nor move a deleted one", async () => {
    bodyOf(await owner.save("Edge/once.md", "x\n"));
    bodyOf(await owner.remove("Edge/once.md"));
    expectRefusal(await owner.remove("Edge/once.md"), 404, "a second delete");
    expectRefusal(await owner.move("Edge/once.md", "Edge/twice.md"), 404, "a move of a deleted note");
  });

  it("lets a moved note's old path be used by a new note, whose history starts again", async () => {
    bodyOf(await owner.save("Edge/old place.md", "first life\n"));
    bodyOf(await owner.move("Edge/old place.md", "Edge/new place.md"));
    expect(bodyOf(await owner.save("Edge/old place.md", "second life\n"))).toMatchObject({ result: "saved", version: 1 });
    expect(bodyOf(await owner.note("Edge/old place.md")).text).toBe("second life\n");
    expect(bodyOf(await owner.note("Edge/new place.md")).text).toBe("first life\n");
  });

  it("refuses to move a note onto its own path, and says where a move came from in the history", async () => {
    bodyOf(await owner.save("Edge/self.md", "x\n"));
    expectRefusal(await owner.move("Edge/self.md", "Edge/self.md"), 409, "a move onto itself");
    bodyOf(await owner.move("Edge/self.md", "Edge/elsewhere.md"));
    const history = bodyOf(await owner.history("Edge/elsewhere.md")).versions as Entry[];
    expect(history[1]).toMatchObject({ kind: "move", from: "Edge/self.md" });
  });

  it("keeps the clash flag through a move", async () => {
    bodyOf(await owner.save("Edge/flagged.md", "one\ntwo\n"));
    bodyOf(await owner.save("Edge/flagged.md", "one\nTWO\n", { base: 1 }));
    bodyOf(await owner.save("Edge/flagged.md", "one\nDEUX\n", { base: 1 }), 409);
    bodyOf(await owner.move("Edge/flagged.md", "Edge/flagged too.md"));
    expect(bodyOf(await owner.note("Edge/flagged too.md"))).toMatchObject({ version: 4, text: "one\nTWO\n", clash: true });
  });
});

describe("saves at the same moment to a note that is not there yet", () => {
  it("make one note: one save is version 1 and the other is kept as a clash beside it", async () => {
    const [a, b] = await Promise.all([owner.save("Edge/born.md", "from a\n"), owner.save("Edge/born.md", "from b\n")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const history = bodyOf(await owner.history("Edge/born.md")).versions as Entry[];
    expect(history.map((v) => [v.version, v.clash])).toEqual([[1, false], [2, true]]);
    expect(bodyOf(await owner.note("Edge/born.md")).clash).toBe(true);
  });
});

describe("what the routes say to a request they cannot use", () => {
  it("refuses text that is too long, or cannot be kept as UTF-8, and keeps nothing", async () => {
    expectRefusal(await owner.save("Edge/huge.md", "x".repeat(1_000_001)), 413, "a note over the limit");
    expectRefusal(await owner.save("Edge/lone.md", "half an emoji \ud83c"), 400, "text with half a character");
    expectRefusal(await owner.save("Edge/lone \ud83c.md", "fine\n"), 400, "a path with half a character");
    expectRefusal(await owner.note("Edge/huge.md"), 404, "the note that was refused");
  });

  it("refuses paths with an empty step, a backslash or a control character", async () => {
    for (const path of ["Edge//twice.md", "Edge/trailing/", "Edge\\windows.md", "Edge/tab\there.md", "./Edge/dot.md"]) {
      expectRefusal(await owner.save(path, "x\n"), 400, JSON.stringify(path));
    }
  });

  it("answers 404 to a route it does not have and 405 to the wrong method, as JSON", async () => {
    expectRefusal(await send("GET", `${API}/nothing`, cookie), 404, "an unknown route");
    expectRefusal(await send("GET", `${API}/save`, cookie), 405, "a read of the save route");
    expectRefusal(await send("POST", `${API}/list`, cookie, {}), 405, "a post to the list route");
  });

  it("refuses a body that is not a JSON object", async () => {
    expectRefusal(await send("POST", `${API}/save`, cookie, [1, 2]), 400, "an array");
    expectRefusal(await send("POST", `${API}/save`, cookie, "text"), 400, "a bare string");
    expectRefusal(await send("POST", `${API}/delete`, cookie, {}), 400, "a delete with no path");
  });

  it("refuses a search with nothing to look for, and a folder outside the vault", async () => {
    expectRefusal(await owner.search(""), 400, "an empty search");
    expectRefusal(await owner.list("../elsewhere"), 400, "a folder outside the vault");
    expectRefusal(await owner.list("/absolute"), 400, "an absolute folder");
  });

  it("lists a folder given with a trailing slash the same as without", async () => {
    bodyOf(await owner.save("Edge/slash/in.md", "x\n"));
    const plain = bodyOf(await owner.list("Edge/slash")).notes;
    expect(bodyOf(await owner.list("Edge/slash/")).notes).toEqual(plain);
    expect(plain).toHaveLength(1);
  });

  it("refuses a version that is not a whole number", async () => {
    bodyOf(await owner.save("Edge/version.md", "x\n"));
    const asked = await send("GET", `${API}/note?path=${encodeURIComponent("Edge/version.md")}&version=one`, cookie);
    expectRefusal(asked, 400, "a version that is a word");
  });
});

describe("the changes feed asks for a cursor it gave", () => {
  it("refuses a cursor or a limit that is not a number, and accepts the cursor as a number", async () => {
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

  it("carries a move's old path, a resolving save's clash, and no text for a move or a delete", async () => {
    const changes = bodyOf(await owner.changes(undefined, 500)).changes as Array<Record<string, unknown>>;
    const move = changes.find((c) => c.kind === "move" && c.from === "Edge/self.md");
    expect(move).toMatchObject({ path: "Edge/elsewhere.md", version: 2 });
    expect(move).not.toHaveProperty("text");
    const del = changes.find((c) => c.kind === "delete");
    expect(del).not.toHaveProperty("text");
    expect(changes.find((c) => c.resolves === 3)).toMatchObject({ kind: "save", clash: false });
  });
});

describe("a request too big to read", () => {
  it("is turned away by its declared size before it is read", async () => {
    const huge = await worker.fetch(
      new Request(`${ORIGIN}${API}/save`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "content-length": "9000000" },
        body: JSON.stringify({ path: "Edge/too big.md", text: "x\n" }),
      }),
      appEnv(),
    );
    expect(huge.status).toBe(413);
    expectRefusal(await owner.note("Edge/too big.md"), 404, "the note that was turned away");
  });
});
