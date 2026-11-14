// Saving a note in Nexus: every save is a version, a save names the version it started from, edits on different
// lines are merged, edits on the same lines are a clash that is kept beside the note and never overwrites it, and
// a clash is resolved by an ordinary save. Through the Nexus Worker, as the owner (see __fixtures__/nexus-world.ts for
// the routes and the shape of every answer).

import { beforeAll, describe, expect, it } from "vitest";
import { bodyOf, expectRefusal, setUpNexus, signInOwner, vault } from "./__fixtures__/nexus-world";

let owner: ReturnType<typeof vault>;

type Entry = { version: number; kind: string; merged: boolean; clash: boolean; writer: string; at: number; hash: string };

/** The note's text, from the latest version or the one asked for. */
const textAt = async (path: string, version?: number): Promise<string> => bodyOf(await owner.note(path, version)).text;

beforeAll(async () => {
  await setUpNexus();
  owner = vault((await signInOwner()).cookie);
});

describe("a first save and the saves after it", () => {
  it("makes version 1 of a new note, kept with who saved it, when, and a short hash of the text", async () => {
    const before = Date.now();
    expect(bodyOf(await owner.save("Ideas/first.md", "one\ntwo\nthree\n"))).toMatchObject({
      result: "saved", path: "Ideas/first.md", version: 1,
    });

    const read = bodyOf(await owner.note("Ideas/first.md"));
    expect(read).toMatchObject({ path: "Ideas/first.md", version: 1, text: "one\ntwo\nthree\n", writer: "owner", clash: false });
    expect(read.at).toBeGreaterThanOrEqual(before);
    expect(read.at).toBeLessThanOrEqual(Date.now());
    expect(typeof read.hash).toBe("string");
    expect(read.hash.length).toBeGreaterThanOrEqual(4);
    expect(read.hash.length).toBeLessThanOrEqual(32);
  });

  it("makes the next version when the save starts from the latest one, and never changes an old version", async () => {
    bodyOf(await owner.save("Ideas/second.md", "alpha\n"));
    expect(bodyOf(await owner.save("Ideas/second.md", "alpha\nbeta\n", { base: 1 }))).toMatchObject({
      result: "saved", path: "Ideas/second.md", version: 2,
    });

    expect(bodyOf(await owner.note("Ideas/second.md"))).toMatchObject({ version: 2, text: "alpha\nbeta\n" });
    expect(bodyOf(await owner.note("Ideas/second.md", 1))).toMatchObject({ version: 1, text: "alpha\n" });
    expect(bodyOf(await owner.note("Ideas/second.md", 2))).toMatchObject({ version: 2, text: "alpha\nbeta\n" });

    const history = bodyOf(await owner.history("Ideas/second.md"));
    expect(history.path).toBe("Ideas/second.md");
    expect(history.versions.map((v: Entry) => v.version)).toEqual([1, 2]);
    for (const entry of history.versions) {
      expect(entry).toMatchObject({ kind: "save", writer: "owner", merged: false, clash: false });
      expect(typeof entry.at).toBe("number");
      expect(typeof entry.hash).toBe("string");
    }
  });

  it("gives the same text the same hash and different text a different one", async () => {
    bodyOf(await owner.save("Hash/one.md", "same words\n"));
    bodyOf(await owner.save("Hash/two.md", "same words\n"));
    bodyOf(await owner.save("Hash/three.md", "other words\n"));
    const hashOf = async (path: string): Promise<string> => bodyOf(await owner.note(path)).hash;
    expect(await hashOf("Hash/one.md")).toBe(await hashOf("Hash/two.md"));
    expect(await hashOf("Hash/one.md")).not.toBe(await hashOf("Hash/three.md"));
  });

  it("keeps any UTF-8 text exactly: empty, no final newline, Windows line ends, accents, emoji, a long one", async () => {
    const texts: Record<string, string> = {
      "Text/empty.md": "",
      "Text/no-final-newline.md": "no newline at the end",
      "Text/windows.md": "first\r\nsecond\r\n",
      "Text/unicode.md": "Café résumé naïve 日本語 🎙️ ✨\n",
      "Text/long.md": "a line of text that repeats\n".repeat(4000),
    };
    for (const [path, text] of Object.entries(texts)) {
      bodyOf(await owner.save(path, text));
      expect(await textAt(path), path).toBe(text);
    }
  });

  it("refuses a save with no path, no text or a base that is not a whole number, and keeps nothing", async () => {
    bodyOf(await owner.save("Bad/ok.md", "fine\n"));

    expectRefusal(await owner.save(undefined as never, "x\n"), 400, "a save with no path");
    expectRefusal(await owner.save("Bad/no-text.md", undefined as never), 400, "a save with no text");
    expectRefusal(await owner.save("Bad/ok.md", "changed\n", { base: "one" as never }), 400, "a save with a base that is a word");

    expect(bodyOf(await owner.note("Bad/ok.md"))).toMatchObject({ version: 1, text: "fine\n" });
    expectRefusal(await owner.note("Bad/no-text.md"), 404, "the note that was never made");
  });
});

describe("edits on different lines are merged", () => {
  it("keeps both edits as the next version, and says merged", async () => {
    expect(bodyOf(await owner.save("Ideas/a.md", "one\ntwo\nthree\n"))).toMatchObject({ result: "saved", version: 1 });
    expect(bodyOf(await owner.save("Ideas/a.md", "ONE\ntwo\nthree\n", { base: 1 }))).toMatchObject({ result: "saved", version: 2 });

    const merged = await owner.save("Ideas/a.md", "one\ntwo\nTHREE\n", { base: 1 });
    expect(bodyOf(merged)).toMatchObject({ result: "merged", path: "Ideas/a.md", version: 3 });

    expect(bodyOf(await owner.note("Ideas/a.md"))).toMatchObject({ version: 3, text: "ONE\ntwo\nTHREE\n", clash: false });

    const history = bodyOf(await owner.history("Ideas/a.md"));
    expect(history.versions.map((v: Entry) => [v.version, v.merged, v.clash])).toEqual([
      [1, false, false],
      [2, false, false],
      [3, true, false],
    ]);
  });

  it("merges a line added at the end with an edit to the first line", async () => {
    bodyOf(await owner.save("Merge/append.md", "one\ntwo\nthree\n"));
    bodyOf(await owner.save("Merge/append.md", "ONE\ntwo\nthree\n", { base: 1 }));
    const appended = await owner.save("Merge/append.md", "one\ntwo\nthree\nfour\n", { base: 1 });
    expect(bodyOf(appended)).toMatchObject({ result: "merged", version: 3 });
    expect(await textAt("Merge/append.md")).toBe("ONE\ntwo\nthree\nfour\n");
  });

  it("merges against the version the save started from, not the first one", async () => {
    bodyOf(await owner.save("Merge/from-two.md", "a\nb\nc\nd\ne\n"));
    bodyOf(await owner.save("Merge/from-two.md", "A\nb\nc\nd\ne\n", { base: 1 }));
    bodyOf(await owner.save("Merge/from-two.md", "A\nb\nc\nd\nE\n", { base: 2 }));
    const middle = await owner.save("Merge/from-two.md", "A\nb\nC\nd\ne\n", { base: 2 });
    expect(bodyOf(middle)).toMatchObject({ result: "merged", version: 4 });
    expect(await textAt("Merge/from-two.md")).toBe("A\nb\nC\nd\nE\n");
  });
});

describe("edits to the same lines are a clash, kept beside the note and never an overwrite", () => {
  it("saves the first, answers clash with both texts, flags the note, and keeps the second as a clash version", async () => {
    bodyOf(await owner.save("Clash/line.md", "one\ntwo\nthree\n"));
    const first = await owner.save("Clash/line.md", "one\nTWO\nthree\n", { base: 1 });
    expect(bodyOf(first)).toMatchObject({ result: "saved", version: 2 });

    const second = bodyOf(await owner.save("Clash/line.md", "one\nDEUX\nthree\n", { base: 1 }), 409);
    expect(second.result).toBe("clash");
    expect(second.path).toBe("Clash/line.md");
    expect(second.latest).toMatchObject({ version: 2, text: "one\nTWO\nthree\n" });
    expect(second.incoming).toMatchObject({ version: 3, text: "one\nDEUX\nthree\n" });

    // The note still reads the first save, and is flagged on a read and in a list.
    expect(bodyOf(await owner.note("Clash/line.md"))).toMatchObject({ version: 2, text: "one\nTWO\nthree\n", clash: true });
    const listed = bodyOf(await owner.list("Clash")).notes.find((n: { path: string }) => n.path === "Clash/line.md");
    expect(listed).toMatchObject({ version: 2, clash: true });

    // History shows the clash version, and it holds the second text. Nothing before it changed.
    const history = bodyOf(await owner.history("Clash/line.md"));
    expect(history.versions.map((v: Entry) => [v.version, v.clash, v.merged])).toEqual([
      [1, false, false],
      [2, false, false],
      [3, true, false],
    ]);
    expect(await textAt("Clash/line.md", 3)).toBe("one\nDEUX\nthree\n");
    expect(await textAt("Clash/line.md", 2)).toBe("one\nTWO\nthree\n");
    expect(await textAt("Clash/line.md", 1)).toBe("one\ntwo\nthree\n");
  });

  it("is cleared by a save that names the latest version as base and resolves the clash version", async () => {
    bodyOf(await owner.save("Clash/resolve.md", "one\ntwo\nthree\n"));
    bodyOf(await owner.save("Clash/resolve.md", "one\nTWO\nthree\n", { base: 1 }));
    const clash = bodyOf(await owner.save("Clash/resolve.md", "one\nDEUX\nthree\n", { base: 1 }), 409);
    expect(clash.result).toBe("clash");
    expect(bodyOf(await owner.note("Clash/resolve.md")).clash).toBe(true);

    const resolved = await owner.save("Clash/resolve.md", "one\nTWO and DEUX\nthree\n", {
      base: clash.latest.version,
      resolves: clash.incoming.version,
    });
    expect(bodyOf(resolved)).toMatchObject({ result: "saved", version: 4 });

    expect(bodyOf(await owner.note("Clash/resolve.md"))).toMatchObject({ version: 4, text: "one\nTWO and DEUX\nthree\n", clash: false });
    const listed = bodyOf(await owner.list("Clash")).notes.find((n: { path: string }) => n.path === "Clash/resolve.md");
    expect(listed).toMatchObject({ version: 4, clash: false });

    // The clash version is still there, with the text it held.
    expect(await textAt("Clash/resolve.md", 3)).toBe("one\nDEUX\nthree\n");
    const history = bodyOf(await owner.history("Clash/resolve.md"));
    expect(history.versions.map((v: Entry) => v.version)).toEqual([1, 2, 3, 4]);
  });

  it("is what a save with no base on a note that exists becomes: never an overwrite", async () => {
    bodyOf(await owner.save("Clash/no-base.md", "the original\n"));
    const blind = bodyOf(await owner.save("Clash/no-base.md", "written without looking\n"), 409);
    expect(blind.result).toBe("clash");
    expect(blind.latest).toMatchObject({ version: 1, text: "the original\n" });
    expect(blind.incoming).toMatchObject({ version: 2, text: "written without looking\n" });

    expect(bodyOf(await owner.note("Clash/no-base.md"))).toMatchObject({ version: 1, text: "the original\n", clash: true });
    expect(await textAt("Clash/no-base.md", 2)).toBe("written without looking\n");
    const history = bodyOf(await owner.history("Clash/no-base.md"));
    expect(history.versions.map((v: Entry) => [v.version, v.clash])).toEqual([
      [1, false],
      [2, true],
    ]);
  });
});

describe("two saves at the same moment", () => {
  it("both survive when they change different lines: one saved, one merged, no edit lost", async () => {
    bodyOf(await owner.save("Same moment/lines.md", "one\ntwo\nthree\n"));
    const [a, b] = await Promise.all([
      owner.save("Same moment/lines.md", "ONE\ntwo\nthree\n", { base: 1 }),
      owner.save("Same moment/lines.md", "one\ntwo\nTHREE\n", { base: 1 }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.result, b.body.result].sort()).toEqual(["merged", "saved"]);
    expect(bodyOf(await owner.note("Same moment/lines.md"))).toMatchObject({ version: 3, text: "ONE\ntwo\nTHREE\n", clash: false });
  });

  it("lose nothing when they change the same line: one saved, one clash, both texts kept", async () => {
    bodyOf(await owner.save("Same moment/clash.md", "one\ntwo\nthree\n"));
    const [a, b] = await Promise.all([
      owner.save("Same moment/clash.md", "one\nTWO\nthree\n", { base: 1 }),
      owner.save("Same moment/clash.md", "one\nDEUX\nthree\n", { base: 1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.body.result, b.body.result].sort()).toEqual(["clash", "saved"]);

    const history = bodyOf(await owner.history("Same moment/clash.md"));
    expect(history.versions).toHaveLength(3);
    const held: string[] = [];
    for (const v of history.versions as Entry[]) held.push(await textAt("Same moment/clash.md", v.version));
    expect(held.sort()).toEqual(["one\nDEUX\nthree\n", "one\nTWO\nthree\n", "one\ntwo\nthree\n"]);
    expect(bodyOf(await owner.note("Same moment/clash.md")).clash).toBe(true);
  });
});
