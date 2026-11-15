// Signing in once: the plugin asks Nexus for a device approval for the user named in its settings, labelled with the
// device's name, shows the link and the code and opens the link, polls until that user allows it, denies it or it runs
// out, and keeps the token in its own data. The token is never shown. A token Nexus no longer knows (a 401) leaves the
// plugin signed out, in plain words, with nothing sent after. A plugin that has not been told its address and user name
// sends nothing and says what is missing. Against the in-memory Nexus: the approval is the owner's own session answering
// the routes (see world.ts and real-nexus.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVE_PATH } from "./real-nexus";
import {
  DEVICE_NAME, ORIGIN, bodyOf, deviceRoutes, emptyNexus, forbidFetch, known, loadSignIn, makeDevice, manage, newLog, nexusOver, openWorld, type PluginData, type World,
} from "./world";

let world: World;

beforeAll(async () => {
  world = await openWorld();
});

beforeEach(async () => {
  await emptyNexus();
  forbidFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const TEN_MINUTES = 10 * 60 * 1000;

/** A plugin that has never signed in: its address, and no token. */
async function signedOutPlugin() {
  const { signIn } = await loadSignIn();
  const saved: PluginData[] = [];
  const http = nexusOver(newLog(), { online: true });
  const data: PluginData = { address: world.address, user: world.user, token: null, cursor: null, notes: {} };
  const shown: Array<{ link: string; code: string }> = [];
  const opened: string[] = [];
  return {
    signIn,
    data,
    saved,
    shown,
    opened,
    deps: (wait: (ms: number) => Promise<void>) => ({
      http,
      data,
      persist: async (next?: PluginData) => {
        saved.push(structuredClone(next ?? data));
      },
      device: DEVICE_NAME,
      show: (link: string, code: string) => shown.push({ link, code }),
      open: (link: string) => opened.push(link),
      wait,
    }),
  };
}

describe("signing in", () => {
  it("starts a device approval for the named user with the device's name, shows the link and code, opens the link, and keeps the token", async () => {
    const spoken: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void spoken.push(args.map(String).join(" ")));
    }
    const plugin = await signedOutPlugin();
    const waits: number[] = [];
    let asked: { identity: string; label: string } | undefined;

    const result = await plugin.signIn(
      plugin.deps(async (ms) => {
        waits.push(ms);
        expect(waits.length, "the plugin is still waiting on the user: it polls, it does not give up").toBeLessThan(10);
        expect(plugin.shown, "the person has been shown the link and the code before any waiting").toHaveLength(1);
        const { code } = plugin.shown[0];
        if (waits.length === 1) {
          const pending = bodyOf(await deviceRoutes({ cookie: world.ownerCookie }).pending(code));
          asked = { identity: pending.identity, label: pending.label };
        }
        if (waits.length === 2) bodyOf(await deviceRoutes({ cookie: world.ownerCookie }).approve(code));
      }),
    );

    expect(result).toBe("signed-in");
    expect(asked, "what the user is asked to allow").toEqual({ identity: world.user, label: DEVICE_NAME });
    expect(plugin.shown[0].link).toBe(`${ORIGIN}${APPROVE_PATH}?code=${encodeURIComponent(plugin.shown[0].code)}`);
    expect(plugin.opened, "the link is opened for the user").toEqual([plugin.shown[0].link]);
    expect(waits.every((ms) => ms >= 500 && ms <= 15_000), "polls every few seconds: no tight loop, and no long wait for the user").toBe(true);

    const kept = plugin.saved.at(-1);
    expect(kept?.token, "the token is kept in the plugin's own data").toMatch(/^nx_/);
    const token = kept!.token!;
    expect(kept?.address).toBe(world.address);
    const listed = await world.as({ bearer: token }).list();
    expect(listed.status, "and it is a token Nexus honours, for the named user").toBe(200);
    expect(
      bodyOf(await manage({ cookie: world.ownerCookie }).tokens()).tokens.some((t: { identity: string; label: string }) => t.identity === world.user && t.label === DEVICE_NAME),
    ).toBe(true);

    // It is shown nowhere: not on the screen, not in a notice, not in a log.
    const everythingSaid = JSON.stringify([plugin.shown, plugin.opened, spoken]);
    expect(everythingSaid, "the token is not shown, opened or logged").not.toContain(token);
    expect(everythingSaid, "nor is the device's secret").not.toMatch(/[0-9a-f]{64}/);
  });

  it("keeps no token when the user denies it, and says so", async () => {
    const plugin = await signedOutPlugin();
    let asks = 0;
    const result = await plugin.signIn(
      plugin.deps(async () => {
        if (++asks === 1) bodyOf(await deviceRoutes({ cookie: world.ownerCookie }).deny(plugin.shown[0].code));
        expect(asks, "it stops at the first answer").toBeLessThan(5);
      }),
    );
    expect(result).toBe("denied");
    expect(plugin.saved.at(-1)?.token ?? null).toBeNull();
    expect(plugin.data.token).toBeNull();
  });

  it("gives up when the approval runs out, and keeps no token", async () => {
    const plugin = await signedOutPlugin();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
    const start = Date.now();
    let asks = 0;
    const result = await plugin.signIn(
      plugin.deps(async () => {
        if (++asks === 1) vi.setSystemTime(start + TEN_MINUTES + 1000);
        expect(asks, "it stops once Nexus says the code has expired").toBeLessThan(5);
      }),
    );
    expect(result).toBe("expired");
    expect(plugin.saved.at(-1)?.token ?? null).toBeNull();
  });
});

describe("a sign-in belongs to the address it began against", () => {
  it("is dropped, with no token kept, when the address is changed while it waits for the person", async () => {
    const plugin = await signedOutPlugin();
    let asks = 0;
    const result = await plugin.signIn(
      plugin.deps(async () => {
        if (++asks === 1) bodyOf(await deviceRoutes({ cookie: world.ownerCookie }).approve(plugin.shown[0].code));
        plugin.data.address = "https://another-nexus.example.test/nexus/api";
        expect(asks, "it stops as soon as it sees the change").toBeLessThan(3);
      }),
    );
    expect(result).toBe("changed");
    expect(plugin.data.token, "no token for the server it did not ask").toBeNull();
    expect(plugin.saved, "nothing was saved").toEqual([]);
    expect(
      bodyOf(await manage({ cookie: world.ownerCookie }).tokens()).tokens.filter((t: { label: string }) => t.label === DEVICE_NAME).length,
      "the owner's server did make the token: it was allowed, and nothing here took it",
    ).toBeGreaterThan(0);
  });

  it("is dropped when the address changes while the poll that would hand over the token is on its way", async () => {
    const plugin = await signedOutPlugin();
    const inner = plugin.deps(async () => {
      bodyOf(await deviceRoutes({ cookie: world.ownerCookie }).approve(plugin.shown[0].code));
    });
    const result = await plugin.signIn({
      ...inner,
      // The person changes the address as the answer comes back: the token is in it, and it is for the old address.
      http: async (request) => {
        const answer = await inner.http(request);
        if (request.url.endsWith("device/poll")) plugin.data.address = "https://another-nexus.example.test/nexus/api";
        return answer;
      },
    });
    expect(result).toBe("changed");
    expect(plugin.data.token).toBeNull();
    expect(plugin.saved).toEqual([]);
  });

  it("is dropped when the user name changes, for the same reason", async () => {
    const plugin = await signedOutPlugin();
    const result = await plugin.signIn(
      plugin.deps(async () => {
        bodyOf(await deviceRoutes({ cookie: world.ownerCookie }).approve(plugin.shown[0].code));
        plugin.data.user = "someone-else";
      }),
    );
    expect(result).toBe("changed");
    expect(plugin.data.token).toBeNull();
  });

  it("sends every call of a sign-in to the address it began with", async () => {
    const plugin = await signedOutPlugin();
    const urls: string[] = [];
    const inner = plugin.deps(async () => {
      bodyOf(await deviceRoutes({ cookie: world.ownerCookie }).approve(plugin.shown[0].code));
    });
    const result = await plugin.signIn({ ...inner, http: (request) => (urls.push(request.url), inner.http(request)) });
    expect(result).toBe("signed-in");
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls.every((url) => url.startsWith(`${world.address}/device/`))).toBe(true);
  });
});

describe("a token Nexus does not know", () => {
  /** A token made for this test alone, revoked through the route as the owner. */
  async function revokedToken(label: string): Promise<string> {
    const token = await world.tokenFor(world.user, label);
    const tokens = bodyOf(await manage({ cookie: world.ownerCookie }).tokens()).tokens as Array<{ id: string; label: string }>;
    const id = tokens.find((t) => t.label === label)!.id;
    bodyOf(await manage({ cookie: world.ownerCookie }).revoke(id));
    return token;
  }

  it("leaves the plugin signed out, in plain words, with its token forgotten and the vault untouched", async () => {
    const token = await revokedToken("a token that will be revoked");
    const device = await makeDevice(world, { files: { "Ideas/a.md": "my edit\n" }, notes: { "Ideas/a.md": known("Ideas/a.md", "the text it matched\n") }, cursor: "0", token });

    await expect(device.engine.push("Ideas/a.md")).resolves.toBeUndefined();

    expect(device.log.to("POST save")[0].status, "Nexus refused the token").toBe(401);
    expect(device.engine.status(), "the status line says it").toMatch(/signed out/i);
    expect(device.engine.status(), "in plain words").not.toMatch(/\b(401|403|409|http|status code)\b/i);
    expect(device.engine.status(), "never with the token in it").not.toContain(token);
    expect(device.data().token, "the dead token is forgotten").toBeNull();
    expect(device.vault.texts(), "nothing in the vault changed").toEqual({ "Ideas/a.md": "my edit\n" });
    expect(device.data().notes["Ideas/a.md"].version, "and it still stands on the version it had").toBe(1);
  });

  it("sends nothing more until the person signs in again", async () => {
    const token = await revokedToken("a second token that will be revoked");
    const device = await makeDevice(world, { files: { "Ideas/b.md": "my edit\n" }, notes: { "Ideas/b.md": known("Ideas/b.md", "the text it matched\n") }, cursor: "0", token });
    await device.engine.sync();
    expect(device.engine.status()).toMatch(/signed out/i);
    const sent = device.log.requests().length;

    await device.engine.sync();
    await device.engine.push("Ideas/b.md");
    await device.engine.renamed("Ideas/b.md", "Ideas/c.md");
    await device.engine.deleted("Ideas/c.md");
    await device.engine.cameToFront();

    expect(device.log.requests().length, "a signed-out plugin makes no calls").toBe(sent);
    expect(device.engine.status()).toMatch(/signed out/i);
  });

  it("is also how a plugin that never signed in starts out: no calls, and it says it is signed out", async () => {
    const device = await makeDevice(world, { files: { "Ideas/d.md": "a note\n" }, token: null });
    await device.engine.sync();
    await device.engine.push("Ideas/d.md");

    expect(device.log.requests(), "there is no token to send, so nothing is sent").toEqual([]);
    expect(device.engine.status()).toMatch(/signed out/i);
  });
});
