// Serves the device approval page: a plain static page (public/nexus) that the Worker hands out to the owner. Only
// the four files the page is made of are served, each at its own address under /apps/nexus, so no other file in the
// assets (and no folder) can be asked for by name. The page is the same for everyone and needs nothing written into
// it per request: the code it shows is read from its own address by its own script, and everything it asks of Nexus
// goes to the API, which checks the owner again.

import type { NexusEnv } from "./host";

/** The addresses the page is served at, and where each file sits in the assets. The page itself has no extension. */
const FILES: Readonly<Record<string, string>> = {
  "/apps/nexus/approve": "/nexus/approve",
  "/apps/nexus/approve.css": "/nexus/approve.css",
  "/apps/nexus/approve.js": "/nexus/approve.js",
  "/apps/nexus/theme-boot.js": "/nexus/theme-boot.js",
};

/** Whether an address is one of the page's four files. */
export const isNexusAsset = (pathname: string): boolean => Object.hasOwn(FILES, pathname);

const NOT_FOUND = (): Response => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

/** One of the page's files. The caller has already made sure the request is the owner's. */
export async function serveNexusAsset(request: Request, env: NexusEnv): Promise<Response> {
  const url = new URL(request.url);
  const target = Object.hasOwn(FILES, url.pathname) ? FILES[url.pathname] : undefined;
  if (!target || !env.ASSETS) return NOT_FOUND();

  const rewritten = new URL(request.url);
  rewritten.pathname = target;
  rewritten.search = "";
  const upstream = await env.ASSETS.fetch(new Request(rewritten.toString(), { method: "GET" }));
  const headers = new Headers(upstream.headers);
  // The page is for one person at one moment: it is not kept.
  headers.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers });
}
