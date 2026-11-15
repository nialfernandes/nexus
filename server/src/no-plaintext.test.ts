// The promise of this server: whoever runs it cannot read a note. Two notes are stored, every route is called, and then
// every row of every table, every line the server logged and every answer it gave is searched for the notes' paths,
// folders, names and texts, in the plain and in the ways they could be written down (escaped for JSON or an address,
// or as base64). None may be found.
//
// The notes are the encrypted blobs in __fixtures__/device-blobs.ts, made by the real @nexus/crypto, so what is stored is
// what a device really sends. The calls include the ones a device that is not updated yet would make, in the old shape with
// the path and the text in plain, and one that puts a path where an id goes: those are refused, and nothing of them may
// be kept, echoed or logged either. One call is made with the database failing, so that the log line a fault writes is
// among the lines searched.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GARDEN_V1, GARDEN_V2, PASSWORD_WRAP, PODCAST_V1, RECOVERY_WRAP, VAULT_ID } from "./__fixtures__/device-blobs";
import { everythingStored, issueToken, sendAs, type Who } from "./__fixtures__/identity-world";
import { API, appEnv, bodyOf, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { ROUTE_NAMES } from "./routes";

const NOTES = [GARDEN_V1, GARDEN_V2, PODCAST_V1];

/** Every answer the server gave, whole. */
const answers: string[] = [];
/** Every route the calls reached. */
const reached = new Set<string>();
/** Every line the server logged, however it was logged. */
const logged: string[] = [];

let owner: Who;
let agent: Who;

/** One call through the Worker, as `who`: what comes back is kept to be searched. */
async function call(method: string, path: string, who: Who, body?: unknown, env = appEnv()) {
  const answer = await sendAs(method, `${API}/${path}`, who, body, env);
  answers.push(`${answer.status} ${answer.text}`);
  reached.add(path.split("?")[0]);
  return answer;
}

/** A thing a log call was given, as text. An Error is its name, message and stack, so a fault's own words are searched. */
const written = (value: unknown): string =>
  value instanceof Error ? `${value.name}: ${value.message}\n${value.stack ?? ""}` : typeof value === "string" ? value : JSON.stringify(value) ?? String(value);

const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
  logged.push(args.map(written).join(" "));
}));

/** The ways a text could be written down that a search for it must also look for. */
function shapesOf(text: string): string[] {
  const utf8 = Buffer.from(text, "utf8");
  return [
    text,
    JSON.stringify(text).slice(1, -1),
    encodeURIComponent(text),
    utf8.toString("base64"),
    utf8.toString("base64").replace(/=+$/, ""),
    utf8.toString("hex"),
  ];
}

/** What must be nowhere: each note's path, its folder, its file name and each line of its text, each in every shape. */
function needles(): string[] {
  const found: string[] = [];
  for (const note of [GARDEN_V1, PODCAST_V1]) {
    const folder = note.path.slice(0, note.path.lastIndexOf("/"));
    const file = note.path.slice(note.path.lastIndexOf("/") + 1);
    const name = file.replace(/\.md$/, "");
    found.push(...[note.path, folder, file, name].flatMap(shapesOf));
    found.push(...note.text.split("\n").filter((line) => line.length > 6).flatMap(shapesOf));
    found.push(...shapesOf(note.text), ...shapesOf(JSON.stringify({ path: note.path, text: note.text })));
  }
  found.push(...shapesOf(GARDEN_V2.text));
  return [...new Set(found)];
}

/** The needles found in a text, so a failure says which. */
const foundIn = (haystack: string): string[] => needles().filter((needle) => haystack.includes(needle));

beforeAll(async () => {
  await setUpNexus();
  const cookie = (await signInOwner()).cookie;
  owner = { cookie };
  agent = { bearer: (await issueToken(cookie, "agents", "no-plaintext agent")).token };

  // Two notes, saved, read, saved again, merged by the device (here: saved from the version it was told), and deleted.
  await call("POST", "save", owner, { id: GARDEN_V1.id, base: 0, kid: 1, blob: GARDEN_V1.blob });
  await call("POST", "save", agent, { id: PODCAST_V1.id, base: 0, kid: 1, blob: PODCAST_V1.blob });
  await call("POST", "save", owner, { id: GARDEN_V2.id, base: 1, kid: 1, blob: GARDEN_V2.blob });
  await call("POST", "save", agent, { id: GARDEN_V2.id, base: 1, kid: 1, blob: GARDEN_V2.blob });
  await call("GET", `note?id=${GARDEN_V1.id}`, owner);
  await call("GET", `note?id=${GARDEN_V1.id}&version=1`, agent);
  await call("GET", `history?id=${GARDEN_V1.id}`, owner);
  await call("GET", "list", owner);
  await call("GET", "changes", agent);
  await call("GET", "changes?after=1&limit=1", owner);
  await call("POST", "delete", owner, { id: PODCAST_V1.id, base: 1 });
  await call("POST", "save", owner, { id: PODCAST_V1.id, base: 2, kid: 1, blob: PODCAST_V1.blob });
  await call("GET", "changes", owner);
  await call("GET", "heads", agent);
  await call("GET", "heads", owner);

  // The wraps, and the owner's other routes.
  await call("POST", "wrap", owner, { kid: 1, kind: "recovery", wrap: RECOVERY_WRAP, vaultId: VAULT_ID });
  await call("POST", "wrap", owner, { kid: 1, kind: "password", wrap: PASSWORD_WRAP, vaultId: VAULT_ID });
  await call("GET", "wraps", agent);
  await call("POST", "wrap/delete", owner, { kid: 1, kind: "password" });
  await call("POST", "identity", owner, { name: "another", kind: "agent" });
  await call("GET", "tokens", owner);
  await call("POST", "token/revoke", owner, { id: "no-such-token" });
  const started = bodyOf(await call("POST", "device/start", null, { identity: "agents", label: "no-plaintext device" }));
  await call("GET", `device/pending?code=${started.code}`, owner);
  await call("POST", "device/approve", owner, { code: started.code });
  await call("POST", "device/poll", null, { secret: started.secret });
  const refused = bodyOf(await call("POST", "device/start", null, { identity: "agents", label: "to deny" }));
  await call("POST", "device/deny", owner, { code: refused.code });

  // Refusals that carry the notes' own words, as a device that is not updated would send them.
  await call("POST", "save", owner, { path: GARDEN_V1.path, text: GARDEN_V1.text, base: 0 });
  await call("POST", "save", owner, { id: "legacy-1", base: 0, kid: 1, blob: GARDEN_V1.blob, path: GARDEN_V1.path, text: GARDEN_V1.text });
  await call("POST", "save", owner, { id: GARDEN_V1.path, base: 0, kid: 1, blob: GARDEN_V1.blob });
  await call("POST", "save", owner, { id: "legacy-2", base: 0, kid: 1, blob: Buffer.from(GARDEN_V1.text).toString("base64") + "!" });
  // A device that forgot to encrypt, and sends the note's own text as a well-formed blob, or as a wrap: refused by the header, and kept nowhere.
  await call("POST", "save", owner, { id: "legacy-3", base: 0, kid: 1, blob: Buffer.from(GARDEN_V1.text.repeat(8)).toString("base64") });
  await call("POST", "save", owner, { id: "legacy-4", base: 0, kid: 1, blob: Buffer.from(JSON.stringify({ path: GARDEN_V1.path, text: GARDEN_V1.text })).toString("base64") });
  await call("POST", "wrap", owner, { kid: 1, kind: "recovery", wrap: Buffer.from(GARDEN_V1.text).toString("base64"), vaultId: VAULT_ID });
  await call("POST", "delete", owner, { path: GARDEN_V1.path });
  await call("POST", "identity", owner, { name: "wide", kind: "agent", rights: [{ path: `${GARDEN_V1.path.split("/")[0]}/`, access: "read" }] });
  await call("GET", `note?id=${encodeURIComponent(GARDEN_V1.path)}`, owner);
  await call("GET", `history?id=${encodeURIComponent(PODCAST_V1.path)}`, owner);
  await call("GET", `list?folder=${encodeURIComponent(GARDEN_V1.path.split("/")[0])}`, owner);
  await call("GET", `search?q=${encodeURIComponent(GARDEN_V1.text.slice(0, 12))}`, owner);
  await call("POST", "move", owner, { from: GARDEN_V1.path, to: PODCAST_V1.path });
  await call("POST", "rights", owner, { identity: "agents", rights: [{ path: `${PODCAST_V1.path.split("/")[0]}/`, access: "write" }] });
  await call("POST", "save", owner, { id: GARDEN_V1.id, base: 0, kid: 1, blob: GARDEN_V2.blob });

  // A fault: the database fails while a save is being answered. The server logs it, and what it logs is searched.
  const failing = { ...appEnv(), NEXUS_DB: { prepare: () => { throw new Error("the database is not there"); } } as unknown as D1Database };
  const fault = await call("POST", "save", owner, { id: "fault-1", base: 0, kid: 1, blob: GARDEN_V1.blob }, failing);
  expect(fault.status, "the save made while the database failed").toBe(503);
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

describe("the two notes are stored, and the server cannot read them", () => {
  it("holds the notes as the blobs that were sent, and as nothing else", async () => {
    expect(bodyOf(await sendAs("GET", `${API}/note?id=${GARDEN_V1.id}&version=1`, owner))).toMatchObject({ blob: GARDEN_V1.blob });
    expect(bodyOf(await sendAs("GET", `${API}/note?id=${PODCAST_V1.id}`, owner))).toMatchObject({ blob: PODCAST_V1.blob });
  });

  it("is searching for words that really are in what the notes hold: the search finds a note's path in its own text", () => {
    // A search that could never find anything proves nothing, so the needles are held to finding what they are made from.
    expect(foundIn(`x ${GARDEN_V1.path} x`)).toContain(GARDEN_V1.path);
    expect(foundIn(JSON.stringify({ text: PODCAST_V1.text }))).toContain(shapesOf(PODCAST_V1.text)[1]);
    expect(foundIn(`/note?id=${encodeURIComponent(PODCAST_V1.path)}`)).toContain(encodeURIComponent(PODCAST_V1.path));
    expect(foundIn(Buffer.from(GARDEN_V1.text).toString("base64"))).toContain(Buffer.from(GARDEN_V1.text).toString("base64"));
    expect(needles().length).toBeGreaterThan(40);
  });

  it("calls every route the server has, and the three it no longer has", () => {
    expect([...reached].sort()).toEqual([...ROUTE_NAMES, "move", "rights", "search"].sort());
  });
});

describe("no path, name, folder or text is anywhere", () => {
  it("is in no row of any table", async () => {
    const rows = await everythingStored();
    expect(rows).toContain("nexus_versions");
    expect(foundIn(rows)).toEqual([]);
  });

  it("is in no line the server logged", () => {
    expect(logged.length, "the fault wrote a log line, so there is a log to search").toBeGreaterThan(0);
    expect(logged.join("\n")).toMatch(/nexus: a request failed/);
    expect(foundIn(logged.join("\n"))).toEqual([]);
  });

  it("is in no answer the server gave, the refusals included", () => {
    expect(answers.length).toBeGreaterThanOrEqual(40);
    expect(foundIn(answers.join("\n"))).toEqual([]);
  });

  it("is in no answer to a request that has a path or a text in it: nothing is repeated back", () => {
    const refusals = answers.filter((a) => a.startsWith("400 "));
    expect(refusals.length, "the old-shape and path-as-id calls were refused").toBeGreaterThanOrEqual(8);
    for (const refusal of refusals) expect(refusal).toMatch(/^400 \{"error":"[^"]*"(,"reason":"[a-z-]+")?\}$/);
  });

  it("is refused by its header when a device sends a note's own text as the blob or the wrap, and the refusal names only the reason", () => {
    const byHeader = answers.filter((a) => a.startsWith("400 ") && a.includes('"reason"'));
    expect(byHeader.map((a) => /"reason":"([a-z-]+)"/.exec(a)?.[1])).toEqual(["not-an-encrypted-blob", "not-an-encrypted-blob", "not-an-encrypted-wrap"]);
  });
});
