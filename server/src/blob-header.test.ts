// The server keeps only what a device has encrypted, and checks that by the header alone (docs/FORMAT.md sections 6 and 7):
// the first byte is the format's version, the next four are the kid, and a blob is at least the smallest note blob long.
// A device that forgot to encrypt is told so, with a 400 and a `reason`, and nothing is kept. The check never reads
// further than the header, so a valid header followed by random bytes is accepted: the server still cannot tell a
// note from noise, and does not try.
//
// The blobs and wraps are the ones in __fixtures__/device-blobs.ts, made by the real @nexus/crypto. The tests that need
// bytes that are not a real blob (plain text, a cut-off blob, a header and random bytes) make them here from those.

import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { GARDEN_V1, PASSWORD_WRAP, PODCAST_KID_7, PODCAST_KID_MAX, RECOVERY_WRAP } from "./__fixtures__/device-blobs";
import { API, bodyOf, expectRefusal, send, setUpNexus, signInOwner, vault } from "./__fixtures__/nexus-world";
import { manage, type Who } from "./__fixtures__/identity-world";
import { checkNoteBlob, checkWrap, MIN_NOTE_BLOB_BYTES, WRAP_HEADERS } from "./header";

let cookie: string;
let owner: ReturnType<typeof vault>;
let ownerWho: Who;

beforeAll(async () => {
  await setUpNexus();
  cookie = (await signInOwner()).cookie;
  owner = vault(cookie);
  ownerWho = { cookie };
});

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const bytesOfBlob = (blob: string): Buffer => Buffer.from(blob, "base64");

/** A save as the device would write it, for a blob that is not one of the fixtures. */
const save = (id: string, blob: Uint8Array, kid = 1) => send("POST", `${API}/save`, cookie, { id, base: 0, kid, blob: base64(blob) });

/** A header the format's way (version 1, then the kid, big-endian) followed by `rest`. */
const withHeader = (kid: number, rest: Uint8Array): Buffer => {
  const header = Buffer.alloc(5);
  header[0] = 1;
  header.writeUInt32BE(kid, 1);
  return Buffer.concat([header, rest]);
};

/** The reason a refusal gave, after checking it is a 400 that says nothing but the words and the reason. */
function reasonOf(answer: Awaited<ReturnType<typeof save>>, what: string): string {
  expectRefusal(answer, 400, what);
  expect(Object.keys(answer.body).sort(), `${what}: the refusal holds the words and the reason, nothing sent`).toEqual(["error", "reason"]);
  return answer.body.reason;
}

const NOTHING_KEPT = async (id: string) => expect((await owner.note(id)).status, `nothing was kept for ${id}`).toBe(404);

describe("a save: the worked example", () => {
  it("keeps a blob made by @nexus/crypto, and turns the plain bytes of hello away as not an encrypted blob", async () => {
    expect(bodyOf(await owner.save(GARDEN_V1, 0))).toEqual({ result: "saved", id: "n-1", version: 1 });

    const plain = await save("hello-1", Buffer.from("hello"));
    expect(reasonOf(plain, "the plain bytes of hello")).toBe("not-an-encrypted-blob");
    await NOTHING_KEPT("hello-1");
  });

  it("turns away a valid header whose kid is 7 in a save whose kid is 3, as a kid mismatch", async () => {
    const answer = await owner.save({ id: "kid-seven", blob: PODCAST_KID_7.blob }, 0, 3);
    expect(reasonOf(answer, "kid 7 in the blob, kid 3 in the save")).toBe("kid-mismatch");
    await NOTHING_KEPT("kid-seven");
  });

  it("turns away fewer bytes than the smallest blob, as too short", async () => {
    const answer = await save("too-short", withHeader(1, randomBytes(MIN_NOTE_BLOB_BYTES - 5 - 1)));
    expect(reasonOf(answer, "one byte under the smallest blob")).toBe("blob-too-short");
    await NOTHING_KEPT("too-short");
  });
});

describe("the smallest blob", () => {
  it("is 301 bytes: the header (29), the record padded to 256 bytes, and the tag (16), the size of a real blob", () => {
    expect(MIN_NOTE_BLOB_BYTES).toBe(1 + 4 + 24 + 256 + 16);
    expect(MIN_NOTE_BLOB_BYTES).toBe(301);
    expect(bytesOfBlob(GARDEN_V1.blob).length, "a real note, as short as a note can be, is already this long").toBe(MIN_NOTE_BLOB_BYTES);
  });

  it("is kept at 301 bytes and refused at 300, even when it is a real blob cut short", async () => {
    expect((await save("exactly-smallest", withHeader(1, randomBytes(296)))).status).toBe(200);
    const cut = bytesOfBlob(GARDEN_V1.blob).subarray(0, 300);
    expect(reasonOf(await save("cut-short", cut), "a real blob cut by a byte")).toBe("blob-too-short");
    await NOTHING_KEPT("cut-short");
  });
});

describe("a save that is not an encrypted blob", () => {
  it("is refused when the first byte is not 1, whatever the length: plain text, a note's whole text, another version", async () => {
    const note = GARDEN_V1.text.repeat(20);
    expect(Buffer.byteLength(note), "a note longer than the smallest blob").toBeGreaterThan(MIN_NOTE_BLOB_BYTES);
    const another = bytesOfBlob(GARDEN_V1.blob);
    another[0] = 2;
    const zero = bytesOfBlob(GARDEN_V1.blob);
    zero[0] = 0;
    for (const [bytes, what] of [
      [Buffer.from(note), "a note's text, longer than the smallest blob"],
      [Buffer.from(GARDEN_V1.text), "a note's text, shorter than the smallest blob"],
      [Buffer.from(JSON.stringify({ path: GARDEN_V1.path, text: GARDEN_V1.text })), "the note's record as JSON"],
      [Buffer.from([0x68]), "a single byte"],
      [another, "a real blob that says it is version 2"],
      [zero, "a real blob that says it is version 0"],
    ] as const) {
      const id = `plain-${bytes.length}-${bytes[0]}`;
      const answer = await save(id, bytes);
      expect(reasonOf(answer, what), what).toBe("not-an-encrypted-blob");
      expect(answer.text, `${what}: nothing of the note is repeated`).not.toContain("Garden");
      await NOTHING_KEPT(id);
    }
  });

  it("is told it is not an encrypted blob before it is told it is short, because the version comes first", async () => {
    expect(reasonOf(await save("order-1", Buffer.from("hello")), "five plain bytes")).toBe("not-an-encrypted-blob");
    expect(reasonOf(await save("order-2", withHeader(1, Buffer.alloc(0))), "a version and a kid and nothing more")).toBe("blob-too-short");
  });

  it("is refused for a kid other than the save's, by any amount, and the kid is read as an unsigned number", async () => {
    const real = bytesOfBlob(GARDEN_V1.blob);
    expect(reasonOf(await save("kid-0", real, 0), "kid 0 for a kid 1 blob")).toBe("kid-mismatch");
    expect(reasonOf(await save("kid-2", real, 2), "kid 2 for a kid 1 blob")).toBe("kid-mismatch");
    expect(reasonOf(await save("kid-big", real, 4294967295), "the largest kid for a kid 1 blob")).toBe("kid-mismatch");
    const top = bytesOfBlob(PODCAST_KID_MAX.blob);
    expect(reasonOf(await save("kid-max-1", top, 1), "kid 1 for a blob that names the largest kid")).toBe("kid-mismatch");
    expect(reasonOf(await save("kid-max-2", top, 4294967294), "one under the largest kid")).toBe("kid-mismatch");
    expect(reasonOf(await save("kid-low-byte", withHeader(0x01020304, randomBytes(296)), 0x01020305), "a kid that differs in the last byte")).toBe("kid-mismatch");
    expect((await save("kid-max-ok", top, 4294967295)).status, "the largest kid, when the save says so").toBe(200);
    expect((await save("kid-bytes-ok", withHeader(0x01020304, randomBytes(296)), 0x01020304)).status, "four different bytes, written big-endian").toBe(200);
  });
});

describe("the check reads the header and no further", () => {
  it("accepts a valid header followed by random bytes, and keeps them as sent", async () => {
    const noise = withHeader(1, randomBytes(296));
    expect((await save("noise-1", noise)).status).toBe(200);
    expect(bodyOf(await owner.note("noise-1")).blob).toBe(base64(noise));

    const long = withHeader(7, randomBytes(5000));
    expect((await save("noise-2", long, 7)).status).toBe(200);
    expect(bodyOf(await owner.note("noise-2")).blob).toBe(base64(long));
  });

  // The spy lists every place the check looks at a blob. A blob whose reads are all in the header proves the check does not
  // look further, whatever it would find there.
  const spy = (bytes: Uint8Array) => {
    const read: string[] = [];
    const proxy = new Proxy(bytes, {
      get(target, key) {
        read.push(String(key));
        return Reflect.get(target, key);
      },
    });
    return { proxy, read };
  };

  it("is held to the five header bytes and the length by a spy that would see any other read", () => {
    const noise = withHeader(1, randomBytes(400));
    const probe = spy(noise);
    expect(probe.proxy[5], "the spy records a read of a byte past the header").toBe(noise[5]);
    expect(probe.read).toEqual(["5"]);

    const passing = spy(noise);
    checkNoteBlob(passing.proxy, 1);
    expect(passing.read.length).toBeGreaterThan(0);
    for (const key of passing.read) expect(["0", "1", "2", "3", "4", "length"], `a blob that passes: it read ${key}`).toContain(key);

    for (const [bytes, kid] of [[noise, 2], [withHeader(1, randomBytes(10)), 1], [Buffer.from("hello world, this is not encrypted at all"), 1]] as const) {
      const refused = spy(bytes);
      expect(() => checkNoteBlob(refused.proxy, kid)).toThrow();
      for (const key of refused.read) expect(["0", "1", "2", "3", "4", "length"], `a blob that is refused: it read ${key}`).toContain(key);
    }
  });

  it("is held to the first two bytes and the length for a wrap", () => {
    const wrap = Buffer.concat([Buffer.from([1, WRAP_HEADERS.password.kindByte]), randomBytes(WRAP_HEADERS.password.bytes - 2 + 50)]);
    const passing = spy(wrap);
    checkWrap(passing.proxy, "password");
    expect(passing.read.length).toBeGreaterThan(0);
    for (const key of passing.read) expect(["0", "1", "length"], `a wrap that passes: it read ${key}`).toContain(key);

    const refused = spy(wrap);
    expect(() => checkWrap(refused.proxy, "recovery")).toThrow();
    for (const key of refused.read) expect(["0", "1", "length"], `a wrap that is refused: it read ${key}`).toContain(key);
  });
});

describe("a wrap", () => {
  const setWrap = (kid: number, kind: string, wrap: Uint8Array) => manage(ownerWho).setWrap(kid, kind as "recovery", base64(wrap));
  const real = { recovery: bytesOfBlob(RECOVERY_WRAP), password: bytesOfBlob(PASSWORD_WRAP) };

  it("is kept when it is a Recovery wrap or a password wrap made by @nexus/crypto, as the kind it is", async () => {
    expect(real.recovery.length).toBe(WRAP_HEADERS.recovery.bytes);
    expect(real.password.length).toBe(WRAP_HEADERS.password.bytes);
    expect(bodyOf(await setWrap(1, "recovery", real.recovery))).toMatchObject({ result: "saved", kind: "recovery" });
    expect(bodyOf(await setWrap(1, "password", real.password))).toMatchObject({ result: "saved", kind: "password" });
  });

  it("is refused as not an encrypted wrap when its first byte is not 1, plain text included, and nothing is kept", async () => {
    for (const kind of ["recovery", "password"]) {
      expect(reasonOf(await setWrap(5, kind, Buffer.from("correct horse battery staple, my recovery key")), `plain text as a ${kind} wrap`)).toBe("not-an-encrypted-wrap");
      expect(reasonOf(await setWrap(5, kind, Buffer.from("x".repeat(300))), `longer plain text as a ${kind} wrap`)).toBe("not-an-encrypted-wrap");
    }
    expect(bodyOf(await owner.wraps()).wraps.map((w: { kid: number }) => w.kid), "no wrap for kid 5").not.toContain(5);
  });

  it("is refused as the wrong kind when its second byte is not the kind it is saved as", async () => {
    expect(reasonOf(await setWrap(6, "password", real.recovery), "a Recovery wrap saved as a password wrap")).toBe("kind-mismatch");
    expect(reasonOf(await setWrap(6, "recovery", real.password), "a password wrap saved as a Recovery wrap")).toBe("kind-mismatch");
    expect(reasonOf(await setWrap(6, "recovery", bytesOfBlob(GARDEN_V1.blob)), "a note blob saved as a wrap")).toBe("kind-mismatch");
    expect(reasonOf(await setWrap(6, "recovery", Buffer.from([1])), "a version byte and nothing more")).toBe("kind-mismatch");
  });

  it("is refused as too short a byte under the smallest of its kind, and kept at it", async () => {
    expect(reasonOf(await setWrap(6, "recovery", real.recovery.subarray(0, 73)), "a Recovery wrap cut by a byte")).toBe("wrap-too-short");
    expect(reasonOf(await setWrap(6, "password", real.password.subarray(0, 101)), "a password wrap cut by a byte")).toBe("wrap-too-short");
    expect(bodyOf(await owner.wraps()).wraps.map((w: { kid: number }) => w.kid), "no wrap for kid 6").not.toContain(6);
  });

  it("accepts a valid header followed by random bytes: the server does not open a wrap", async () => {
    const recovery = Buffer.concat([Buffer.from([1, 2]), randomBytes(72)]);
    const password = Buffer.concat([Buffer.from([1, 3]), randomBytes(100)]);
    expect(bodyOf(await setWrap(7, "recovery", recovery))).toMatchObject({ result: "saved", kid: 7, kind: "recovery" });
    expect(bodyOf(await setWrap(7, "password", password))).toMatchObject({ result: "saved", kid: 7, kind: "password" });
    const kept = bodyOf(await owner.wraps()).wraps.filter((w: { kid: number }) => w.kid === 7);
    expect(kept.map((w: { kind: string; wrap: string }) => [w.kind, w.wrap])).toEqual([["password", base64(password)], ["recovery", base64(recovery)]]);
  });
});
