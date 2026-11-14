// Where Nexus answers. Every address is under `/nexus` (the API at `/nexus/api/...`, the device approval page at
// `/nexus/approve`). The old prefix `/apps/nexus` keeps answering for one release, with the same handlers, so a device
// that has not been updated still reaches the server; server/README.md says so. `/search` is gone under both. The page's
// files sit in the assets at the address the Worker serves them at, so the Worker has to run first for them (wrangler.jsonc).
// Through the Nexus Worker (see __fixtures__/nexus-world.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseJsonc } from "./__fixtures__/jsonc";
import { staticAssets } from "./__fixtures__/assets";
import { GARDEN_V1, GARDEN_V2 } from "./__fixtures__/device-blobs";
import { bodyOf, expectRefusal, nexusEnv, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { sendAs, vaultAs, type Who } from "./__fixtures__/identity-world";
import { ROUTE_NAMES } from "./routes";

const NEW = "/nexus/api";
const OLD = "/apps/nexus/api";

let owner: Who;

beforeAll(async () => {
  await setUpNexus();
  owner = { cookie: (await signInOwner()).cookie };
});

describe("the API answers at /nexus/api and, for one release, at /apps/nexus/api", () => {
  it("holds one set of notes: a save at one prefix is read at the other", async () => {
    const save = (prefix: string, id: string, base: number, blob: string) =>
      sendAs("POST", `${prefix}/save`, owner, { id, base, kid: 1, blob });
    expect(bodyOf(await save(NEW, "prefix-1", 0, GARDEN_V1.blob))).toMatchObject({ result: "saved", version: 1 });
    expect(bodyOf(await save(OLD, "prefix-1", 1, GARDEN_V2.blob))).toMatchObject({ result: "saved", version: 2 });

    for (const prefix of [NEW, OLD]) {
      expect(bodyOf(await sendAs("GET", `${prefix}/note?id=prefix-1`, owner)), prefix).toMatchObject({ version: 2, blob: GARDEN_V2.blob });
      expect(bodyOf(await sendAs("GET", `${prefix}/history?id=prefix-1`, owner)).versions, prefix).toHaveLength(2);
      expect(bodyOf(await sendAs("GET", `${prefix}/list`, owner)).notes.map((n: { id: string }) => n.id), prefix).toContain("prefix-1");
    }
    const stale = await save(OLD, "prefix-1", 1, GARDEN_V1.blob);
    expectRefusal(stale, 409, "a stale save at the old prefix");
    expect(stale.body.current).toBe(2);
  });

  it("gives the same answer from the same handler for every route, signed in or not, whatever the method", async () => {
    for (const name of ROUTE_NAMES) {
      for (const method of ["GET", "POST"]) {
        for (const [who, what] of [[null, "nobody"], [owner, "the owner"]] as const) {
          const now = await sendAs(method, `${NEW}/${name}`, who, method === "POST" ? {} : undefined);
          const before = await sendAs(method, `${OLD}/${name}`, who, method === "POST" ? {} : undefined);
          expect(before.status, `${method} ${name} as ${what}`).toBe(now.status);
          expect(before.text, `${method} ${name} as ${what}`).toBe(now.text);
        }
      }
    }
  });

  it("has no search at either prefix, and answers a route it does not have 404 for the owner and 401 for nobody", async () => {
    for (const prefix of [NEW, OLD]) {
      expectRefusal(await sendAs("GET", `${prefix}/search?q=garden`, owner), 404, `search at ${prefix}`);
      expectRefusal(await sendAs("GET", `${prefix}/search?q=garden`, null), 401, `search at ${prefix} signed out`);
    }
    expect(ROUTE_NAMES).not.toContain("search");
  });

  it("serves no address that is neither prefix: not /nexus without api, not /apps, not /api", async () => {
    for (const path of ["/api/list", "/nexus/list", "/apps/nexus/list", "/apps/api/list", "/nexusapi/list"]) {
      expect((await sendAs("GET", path, owner)).status, path).toBe(404);
    }
  });
});

describe("the device approval page is at /nexus/approve and, for one release, at /apps/nexus/approve", () => {
  const FILES = ["approve", "approve.css", "approve.js", "theme-boot.js"];

  it("serves the same four files at both prefixes, to the owner only", async () => {
    for (const file of FILES) {
      const now = await sendAs("GET", `/nexus/${file}`, owner);
      const before = await sendAs("GET", `/apps/nexus/${file}`, owner);
      expect(now.status, file).toBe(200);
      expect(before.status, file).toBe(200);
      expect(before.text, file).toBe(now.text);
      expect((await sendAs("GET", `/nexus/${file}`, null)).status, `${file} signed out`).toBe(401);
      expect((await sendAs("GET", `/apps/nexus/${file}`, null)).status, `${file} signed out at the old prefix`).toBe(401);
    }
  });

  it("hands a device a link under /nexus, whichever prefix the device asked at", async () => {
    for (const path of [`${NEW}/device/start`, `${OLD}/device/start`]) {
      const started = bodyOf(await sendAs("POST", path, null, { identity: "agents", label: "prefix device" }));
      expect(started.link).toBe(`https://nexus.example.test/nexus/approve?code=${encodeURIComponent(started.code)}`);
    }
    // And the device's own two calls, and the owner's answer, work through the old prefix as well.
    const started = bodyOf(await sendAs("POST", `${OLD}/device/start`, null, { identity: "agents", label: "old prefix device" }));
    expect(bodyOf(await sendAs("GET", `${OLD}/device/pending?code=${started.code}`, owner)).label).toBe("old prefix device");
    bodyOf(await sendAs("POST", `${OLD}/device/approve`, owner, { code: started.code }));
    const polled = bodyOf(await sendAs("POST", `${OLD}/device/poll`, null, { secret: started.secret }));
    expect(polled.status).toBe("approved");
    expect(bodyOf(await vaultAs({ bearer: polled.token }).list()).notes).toBeInstanceOf(Array);
  });

  it("refuses the page's files to anyone else without asking the asset server for them", async () => {
    const asked: string[] = [];
    const assets = staticAssets();
    const watching = { fetch: (request: Request) => { asked.push(new URL(request.url).pathname); return assets.fetch(request); } } as unknown as Fetcher;
    const env = await nexusEnv({ ASSETS: watching });

    expect((await sendAs("GET", "/nexus/approve.js", null, undefined, env)).status).toBe(401);
    expect((await sendAs("GET", "/apps/nexus/approve.js", { cookie: "nexus_owner=wrong" }, undefined, env)).status).toBe(401);
    expect(asked, "the asset server was not asked").toEqual([]);

    expect((await sendAs("GET", "/apps/nexus/approve.js", owner, undefined, env)).status).toBe(200);
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

  it("has the four files in the assets under /nexus, the address the Worker asks for", () => {
    for (const file of ["approve.html", "approve.css", "approve.js", "theme-boot.js"]) {
      expect(readFileSync(join(import.meta.dirname, "../public/nexus", file), "utf8").length, file).toBeGreaterThan(0);
    }
    expect(wrangler.assets.directory).toBe("./public");
  });
});

describe("a device can still call the device routes without a credential at either prefix", () => {
  it("answers start and poll for nobody", async () => {
    for (const prefix of [NEW, OLD]) {
      const started = await sendAs("POST", `${prefix}/device/start`, null, { identity: "agents", label: `prefix open ${prefix}` });
      expect(started.status, prefix).toBe(200);
      expect((await sendAs("POST", `${prefix}/device/poll`, null, { secret: bodyOf(started).secret })).status, prefix).toBe(200);
    }
  });
});
