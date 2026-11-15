import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askModel, INSTRUCTIONS, ITEMS_MAX, mentionsSpoken, ModelFailure, partsOf, readAnswer, type ModelFetch, type ModelSettings } from "../src/model";
import { startModelServer, type ModelServer } from "./model-server";

const realFetch: ModelFetch = (url, init) => fetch(url, init);

describe("partsOf: a transcript in parts that fit the window", () => {
  it("is one part when it fits, and none when there is nothing", () => {
    expect(partsOf("short text", 100)).toEqual(["short text"]);
    expect(partsOf("", 100)).toEqual([]);
  });

  it("is cut between paragraphs, and joined again it is the transcript", () => {
    const paragraphs = Array.from({ length: 5 }, (_, at) => `${at}`.repeat(100));
    const parts = partsOf(paragraphs.join("\n\n"), 250);
    expect(parts).toHaveLength(3);
    expect(parts.every((part) => part.length <= 250)).toBe(true);
    expect(parts.join("\n\n")).toBe(paragraphs.join("\n\n"));
  });

  it("cuts a paragraph longer than the window at a space, and keeps every word", () => {
    const words = Array.from({ length: 200 }, (_, at) => `w${at}`);
    const parts = partsOf(words.join(" "), 250);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 250)).toBe(true);
    expect(parts.join(" ").split(" ")).toEqual(words);
  });

  it("cuts a paragraph with no space in it where it must", () => {
    const parts = partsOf("x".repeat(1000), 300);
    expect(parts.map((part) => part.length)).toEqual([300, 300, 300, 100]);
  });
});

describe("readAnswer: what an answer says, checked", () => {
  const ok = { type: "book", title: "Atomic Habits", author: "James Clear" };

  it("reads a list of items", () => {
    expect(readAnswer(JSON.stringify([ok, { type: "website", title: "Hacker News", url: "https://news.ycombinator.com/" }]))).toEqual({
      mentions: [{ type: "book", title: "Atomic Habits", author: "James Clear" }, { type: "website", title: "Hacker News", url: "https://news.ycombinator.com/" }],
      dropped: 0,
    });
  });

  it("reads a list a model put in a code fence, in prose, or inside an object", () => {
    const list = JSON.stringify([ok]);
    for (const answer of [`\`\`\`json\n${list}\n\`\`\``, `Here is the list: ${list} Hope that helps.`, JSON.stringify({ mentions: [ok] })]) {
      expect(readAnswer(answer).mentions).toEqual([ok]);
    }
  });

  it("is an empty list for []", () => {
    expect(readAnswer("[]")).toEqual({ mentions: [], dropped: 0 });
  });

  it("drops each item that does not fit the shape, and keeps the rest", () => {
    const answer = readAnswer(
      JSON.stringify([
        ok,
        { type: "movie", title: "Heat" },
        { type: "book", title: "" },
        { type: "book", title: 7 },
        { type: "book" },
        { type: "person", title: "Ada", author: 3 },
        { type: "website", title: "x", url: "https://not an address" },
        { type: "website", title: "y".repeat(500) },
        "a string",
        null,
        ["a", "list"],
      ]),
    );
    expect(answer.mentions).toEqual([ok]);
    expect(answer.dropped).toBe(10);
  });

  it("takes a null or blank author or address as left out, and a bare host as a web address", () => {
    expect(readAnswer(JSON.stringify([{ type: "book", title: "A", author: null, url: " " }, { type: "website", title: "B", url: "example.org/page" }])).mentions).toEqual([
      { type: "book", title: "A" },
      { type: "website", title: "B", url: "https://example.org/page" },
    ]);
  });

  it("allows a quote to be longer than a title", () => {
    const words = "word ".repeat(100).trim();
    expect(readAnswer(JSON.stringify([{ type: "quote", title: words, author: "Someone" }])).mentions).toHaveLength(1);
  });

  it("keeps no more than ITEMS_MAX items", () => {
    const many = Array.from({ length: ITEMS_MAX + 5 }, (_, at) => ({ type: "person", title: `Person ${at}` }));
    const answer = readAnswer(JSON.stringify(many));
    expect(answer.mentions).toHaveLength(ITEMS_MAX);
    expect(answer.dropped).toBe(5);
  });

  it("is a failure, not a list of nothing, when the answer is no list", () => {
    for (const answer of ["I cannot help with that.", "", "{}", '{"a": 1}', "42", "null", "[unclosed", '"[]"']) {
      expect(() => readAnswer(answer), answer).toThrow(ModelFailure);
    }
  });
});

describe("askModel: one call to the endpoint", () => {
  let server: ModelServer;
  const settings = (over: Partial<ModelSettings> = {}): ModelSettings => ({ address: server.address, key: "k-1234-secret", name: "any-model-name", windowChars: 1000, timeoutMs: 5000, ...over });

  beforeAll(async () => {
    server = await startModelServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it("sends the transcript part and the instructions to <address>/chat/completions with the key and the model name it was given", async () => {
    server.asked.length = 0;
    server.answer(() => JSON.stringify([{ type: "book", title: "Atomic Habits", author: "James Clear" }]));
    const mentions = await askModel(settings({ address: `${server.address}/` }), realFetch, "He said Atomic Habits.");
    expect(mentions).toEqual([{ type: "book", title: "Atomic Habits", author: "James Clear" }]);
    expect(server.asked).toHaveLength(1);
    const [asked] = server.asked;
    expect(asked!.path).toBe("/v1/chat/completions");
    expect(asked!.authorization).toBe("Bearer k-1234-secret");
    expect(asked!.body.model).toBe("any-model-name");
    expect(asked!.body.messages).toEqual([
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: "He said Atomic Habits." },
    ]);
  });

  it("is a failure for each way a model can let it down, and the reason names no key and no address", async () => {
    const cases: Array<[string, Parameters<ModelServer["answer"]>[0], Partial<ModelSettings>, RegExp]> = [
      ["a server error", () => ({ status: 500 }), {}, /status 500/],
      ["a refusal of the key", () => ({ status: 401 }), {}, /status 401/],
      ["garbage", () => "Sure! Atomic Habits is a book.", {}, /not a JSON list/],
      ["a reply that is not JSON", () => ({ raw: "<html>gateway</html>" }), {}, /not JSON/],
      ["a reply with no answer in it", () => ({ raw: JSON.stringify({ choices: [] }) }), {}, /no answer/],
      ["a reply whose answer is not text", () => ({ raw: JSON.stringify({ choices: [{ message: { content: ["x"] } }] }) }), {}, /no answer/],
      ["no answer in time", () => ({ delayMs: 1500 }), { timeoutMs: 200 }, /did not answer within/],
      ["a server that is not there", () => "[]", { address: "http://127.0.0.1:1/v1" }, /could not be reached/],
    ];
    for (const [what, handler, over, reason] of cases) {
      server.answer(handler);
      const failure = await askModel(settings(over), realFetch, "words").then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure, what).toBeInstanceOf(ModelFailure);
      expect((failure as ModelFailure).message, what).toMatch(reason);
      expect((failure as ModelFailure).message, what).not.toContain("k-1234-secret");
      expect((failure as ModelFailure).message, what).not.toContain("127.0.0.1");
    }
  });

  it("is one call for a transcript that fits the window, and one for each part of one that does not, the lists joined", async () => {
    server.asked.length = 0;
    server.answer((transcript) => JSON.stringify([{ type: "person", title: transcript.slice(0, 3) }]));
    const one = await mentionsSpoken(settings(), realFetch, "aaa short");
    expect(one).toEqual([{ type: "person", title: "aaa" }]);
    expect(server.asked).toHaveLength(1);

    server.asked.length = 0;
    const long = ["aaa " + "x".repeat(300), "bbb " + "y".repeat(300), "ccc " + "z".repeat(300)].join("\n\n");
    const joined = await mentionsSpoken(settings({ windowChars: 500 }), realFetch, long);
    expect(server.asked).toHaveLength(3);
    expect(joined.map((mention) => mention.title)).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("makes no call for a transcript with nothing in it", async () => {
    server.asked.length = 0;
    expect(await mentionsSpoken(settings(), realFetch, "")).toEqual([]);
    expect(server.asked).toEqual([]);
  });

  it("fails the whole transcript when one of its parts fails", async () => {
    server.answer((_, call) => (call === 2 ? "not a list" : "[]"));
    server.asked.length = 0;
    await expect(mentionsSpoken(settings({ windowChars: 500 }), realFetch, ["a".repeat(400), "b".repeat(400), "c".repeat(400)].join("\n\n"))).rejects.toThrow(ModelFailure);
  });
});
