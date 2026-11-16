// Where Nexus answers: every address is under `/nexus` (the API at `/nexus/api/...`, the device approval page at
// `/nexus/approve`), and nothing is under the old prefix `/apps/nexus`: it answers 404, for the owner, for a token and for
// nobody, so a request that still goes there is told plainly it has no Nexus. `/search` is gone too. The page's files sit
// in the assets at the address the Worker serves them at, so the Worker has to run first for them (wrangler.jsonc).
// Through the Nexus Worker (see __fixtures__/nexus-world.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseJsonc } from "./__fixtures__/jsonc";
import { staticAssets } from "./__fixtures__/assets";
import { GARDEN_V1 } from "./__fixtures__/device-blobs";
import { bodyOf, expectRefusal, nexusEnv, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { sendAs, tokenFor, vaultAs, type Who } from "./__fixtures__/identity-world";
import * as addresses from "./addresses";
import { ROUTE_NAMES } from "./routes";

const API = "/nexus/api";
const OLD = "/apps/nexus/api";

let owner: Who;

beforeAll(async () => {
  await setUpNexus();
  owner = { cookie: (await signInOwner()).cookie };
});

describe("the API answers at /nexus/api", () => {
  it("saves and reads a note there", async () => {
    expect(bodyOf(await vaultAs(owner).save({ id: "prefix-1", blob: GARDEN_V1.blob }, 0))).toMatchObject({ result: "saved", version: 1 });
    expect(bodyOf(await sendAs("GET", `${API}/note?id=prefix-1`, owner))).toMatchObject({ version: 1, blob: GARDEN_V1.blob });
    expect(bodyOf(await sendAs("GET", `${API}/list`, owner)).notes.map((n: { id: string }) => n.id)).toContain("prefix-1");
  });

  it("has no search, and answers a route it does not have 404 for the owner and 401 for nobody", async () => {
    expectRefusal(await sendAs("GET", `${API}/search?q=garden`, owner), 404, "search");
    expectRefusal(await sendAs("GET", `${API}/search?q=garden`, null), 401, "search signed out");
    expect(ROUTE_NAMES).not.toContain("search");
  });
});

describe("the old /apps/nexus prefix answers nothing", () => {
  it("is a 404 for every route, whatever the method and whoever asks: the owner, a token or nobody", async () => {
    const token = tokenFor(() => (owner as { cookie: string }).cookie, "agents", "an agent that still uses the old prefix");
    for (const name of ROUTE_NAMES) {
      for (const method of ["GET", "POST"]) {
        for (const [who, what] of [[null, "nobody"], [owner, "the owner"], [token, "a token"]] as const) {
          const answer = await sendAs(method, `${OLD}/${name}`, who, method === "POST" ? {} : undefined);
          expect(answer.status, `${method} ${OLD}/${name} as ${what}`).toBe(404);
        }
      }
    }
  });

  it("does not read what a save to the old prefix sent", async () => {
    const answer = await sendAs("POST", `${OLD}/save`, owner, { id: "old-prefix-1", base: 0, kid: 1, blob: GARDEN_V1.blob });
    expect(answer.status).toBe(404);
    expectRefusal(await sendAs("GET", `${API}/note?id=old-prefix-1`, owner), 404, "the note the old prefix was asked to save");
  });

  it("is no longer written in the server's addresses", () => {
    expect(Object.keys(addresses).sort()).toEqual(["APPROVE_PATH", "NEXUS_BASE", "NEXUS_PREFIX", "routeName"]);
    expect(addresses.routeName(`${OLD}/save`)).toBeNull();
    expect(addresses.routeName(`${API}/save`)).toBe("save");
  });

  it("serves no address that is not /nexus/api/<route>: not /nexus without api, not /apps, not /api", async () => {
    for (const path of ["/api/list", "/nexus/list", "/apps/nexus/list", "/apps/api/list", "/nexusapi/list"]) {
      expect((await sendAs("GET", path, owner)).status, path).toBe(404);
    }
  });
});

describe("the device approval page is at /nexus/approve", () => {
  const FILES = [
    "approve", "approve.css", "approve.js",
    "fonts/unbounded-var.woff2", "fonts/instrument-sans-var.woff2", "fonts/jetbrains-mono-var.woff2",
  ];

  it("serves the page, its stylesheet, its script and its three typefaces to the owner only, and none of them under the old prefix", async () => {
    for (const file of FILES) {
      expect((await sendAs("GET", `/nexus/${file}`, owner)).status, file).toBe(200);
      expect((await sendAs("GET", `/nexus/${file}`, null)).status, `${file} signed out`).toBe(401);
      expect((await sendAs("GET", `/apps/nexus/${file}`, owner)).status, `${file} at the old prefix`).toBe(404);
      expect((await sendAs("GET", `/apps/nexus/${file}`, null)).status, `${file} at the old prefix, signed out`).toBe(404);
    }
  });

  it("hands a device a link under /nexus", async () => {
    const started = bodyOf(await sendAs("POST", `${API}/device/start`, null, { identity: "agents", label: "prefix device" }));
    expect(started.link).toBe(`https://nexus.example.test/nexus/approve?code=${encodeURIComponent(started.code)}`);
  });

  it("refuses the page's files to anyone else without asking the asset server for them", async () => {
    const asked: string[] = [];
    const assets = staticAssets();
    const watching = { fetch: (request: Request) => { asked.push(new URL(request.url).pathname); return assets.fetch(request); } } as unknown as Fetcher;
    const env = await nexusEnv({ ASSETS: watching });

    expect((await sendAs("GET", "/nexus/approve.js", null, undefined, env)).status).toBe(401);
    expect((await sendAs("GET", "/nexus/approve.js", { cookie: "nexus_owner=wrong" }, undefined, env)).status).toBe(401);
    expect(asked, "the asset server was not asked").toEqual([]);

    expect((await sendAs("GET", "/apps/nexus/approve.js", owner, undefined, env)).status).toBe(404);
    expect(asked, "the old prefix is never passed on to the asset server").toEqual([]);

    expect((await sendAs("GET", "/nexus/approve.js", owner, undefined, env)).status).toBe(200);
    expect(asked, "the file is asked for at its own address in the assets").toEqual(["/nexus/approve.js"]);
  });
});

describe("the Worker runs before the asset server for /nexus", () => {
  const wrangler = parseJsonc<{ assets: { directory: string; binding: string; run_worker_first?: unknown } }>(
    readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8"),
  );

  it("says so in wrangler.jsonc, because the page's files sit at the address it is served at", () => {
    expect(wrangler.assets.binding).toBe("ASSETS");
    expect(wrangler.assets.run_worker_first).toEqual(["/nexus/*"]);
  });

  it("has the page's files in the assets under /nexus, the address the Worker asks for", () => {
    for (const file of [
      "approve.html", "approve.css", "approve.js",
      "fonts/unbounded-var.woff2", "fonts/instrument-sans-var.woff2", "fonts/jetbrains-mono-var.woff2",
    ]) {
      expect(readFileSync(join(import.meta.dirname, "../public/nexus", file), "utf8").length, file).toBeGreaterThan(0);
    }
    expect(wrangler.assets.directory).toBe("./public");
  });
});

describe("a device can call the device routes without a credential", () => {
  it("answers start and poll for nobody", async () => {
    const started = await sendAs("POST", `${API}/device/start`, null, { identity: "agents", label: "prefix open" });
    expect(started.status).toBe(200);
    expect((await sendAs("POST", `${API}/device/poll`, null, { secret: bodyOf(started).secret })).status).toBe(200);
  });
});
