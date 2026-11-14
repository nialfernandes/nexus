// Who may use Nexus, and how it is wired into the Worker. For now only the owner's own sign-in opens it (the owner's
// secret, in the cookie the Cloudflare plug reads), and everyone else, whether nobody is signed in or someone is, is
// told 401: not sent to a sign-in page and not shown a 404, because what calls these routes is a program that has to
// be told it is not allowed. Through the Nexus Worker (see __fixtures__/nexus-world.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseJsonc } from "./__fixtures__/jsonc";
import { EVERY_ROUTE, appEnv, bodyOf, expectRefusal, nexusMigrations, send, setUpNexus, signInOwner, signInStranger, vault } from "./__fixtures__/nexus-world";

const wrangler = readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8");

let owner: string;
let stranger: string;

beforeAll(async () => {
  await setUpNexus();
  owner = (await signInOwner()).cookie;
  stranger = (await signInStranger()).cookie;
});

describe("without the owner's sign-in every route answers 401", () => {
  it("answers 401 to a request with no cookie, and does not send it to sign in", async () => {
    for (const route of EVERY_ROUTE) {
      const answer = await send(route.method, route.path, null, route.body);
      expect(answer.status, `${route.method} ${route.path} with no cookie`).toBe(401);
      expect(answer.location, route.path).toBeNull();
    }
  });

  it("answers 401 to a cookie that does not hold the owner's secret", async () => {
    for (const route of EVERY_ROUTE) {
      const answer = await send(route.method, route.path, "nexus_owner=not-the-owners-secret", route.body);
      expect(answer.status, `${route.method} ${route.path} with a wrong secret`).toBe(401);
      expect(answer.location, route.path).toBeNull();
    }
  });

  it("answers 401 to someone who is signed in but is not the owner", async () => {
    for (const route of EVERY_ROUTE) {
      const answer = await send(route.method, route.path, stranger, route.body);
      expect(answer.status, `${route.method} ${route.path} as a stranger`).toBe(401);
    }
  });

  it("changes nothing for them: the owner's note is as it was, and a stranger's save left no note behind", async () => {
    bodyOf(await vault(owner).save("Gate/x.md", "x\n"));
    expect(bodyOf(await vault(owner).note("Gate/x.md"))).toMatchObject({ version: 1, text: "x\n" });

    expect((await vault(null).save("Gate/x.md", "overwritten\n", { base: 1 })).status).toBe(401);
    expect((await vault(stranger).save("Gate/new.md", "sneaked in\n")).status).toBe(401);
    expect((await vault(stranger).remove("Gate/x.md")).status).toBe(401);
    expect((await vault(null).move("Gate/x.md", "Gate/y.md")).status).toBe(401);

    expect(bodyOf(await vault(owner).note("Gate/x.md"))).toMatchObject({ version: 1, text: "x\n" });
    expectRefusal(await vault(owner).note("Gate/new.md"), 404, "the note a stranger tried to make");
  });

  it("answers before it touches the database", async () => {
    const database = {
      prepare() {
        throw new Error("an unauthorised request reached the database");
      },
    };
    const env = { ...appEnv(), NEXUS_DB: database as unknown as D1Database };
    for (const route of EVERY_ROUTE) {
      const answer = await send(route.method, route.path, null, route.body, env);
      expect(answer.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it("lets the owner in", async () => {
    for (const route of EVERY_ROUTE.filter((r) => r.name === "list" || r.name === "changes" || r.name === "search")) {
      const answer = await send(route.method, route.path, owner, route.body);
      expect(answer.status, route.path).toBe(200);
    }
  });
});

describe("the database is its own", () => {
  interface D1Entry { binding: string; database_name: string; database_id: string; migrations_dir: string }
  const entry = () => parseJsonc<{ d1_databases: D1Entry[] }>(wrangler).d1_databases.find((d) => d.binding === "NEXUS_DB");

  it("is bound as NEXUS_DB, named nexus, with its migrations in migrations/", () => {
    expect(entry()).toMatchObject({ binding: "NEXUS_DB", database_name: "nexus", migrations_dir: "migrations" });
  });

  it("holds a placeholder for the database_id, not anyone's real id, with a comment saying how to make the database", () => {
    expect(entry()?.database_id).toMatch(/^REPLACE-WITH/);
    const lines = wrangler.split("\n");
    const at = lines.findIndex((l) => l.includes('"NEXUS_DB"'));
    expect(at).toBeGreaterThan(0);
    const above = lines.slice(Math.max(0, at - 12), at);
    expect(above.some((l) => l.trimStart().startsWith("//")), "a comment sits above the binding").toBe(true);
  });

  it("has migrations that build the tables", () => {
    expect(nexusMigrations().length).toBeGreaterThan(0);
  });
});
