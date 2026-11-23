// Serves the device approval page and the Nexus page: plain static pages (public/nexus) that the Worker hands out to whoever opens their
// link. Only the files the pages are made of are served (the pages, their stylesheets and scripts, the three typefaces the stylesheets
// ask for, and the app icon the pages' heads name), each at its own address under /nexus, so no other file in the assets (and no folder) can be asked for by
// name. The page is the same for everyone and needs nothing written into it per request: the code it shows is read
// from its own address by its own script, and everything it asks of Nexus goes to the API, which checks the owner on every call.
// Nothing in a file is private, so none is held back from a browser that is not signed in: the page is where the owner
// signs in with the owner secret for a first device.
//
// The files sit in the assets under /nexus, the same address the page is served at, so the asset server would hand
// them out before the Worker ran. wrangler.jsonc's `run_worker_first` makes the Worker see /nexus/* first, so that
// only the files named here are served and a folder or any other file in the assets is a 404.

import { NEXUS_PAGE_PATH, NEXUS_PREFIX } from "../../addresses";
import type { NexusEnv } from "./host";

/** The files after the prefix, and where each sits in the assets. The approval page itself has no extension. */
const FILE_NAMES = [
  "approve", "approve.css", "approve.js",
  "nexus.css", "nexus.js",
  "fonts/unbounded-var.woff2", "fonts/instrument-sans-var.woff2", "fonts/jetbrains-mono-var.woff2",
  "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png",
] as const;

/**
 * Every address a file is served at, and where that file sits in the assets (the same address). The Nexus page is the folder's own
 * address, `/nexus/`, which the asset server answers with the folder's index.html.
 */
const FILES: Readonly<Record<string, string>> = Object.fromEntries(
  [NEXUS_PAGE_PATH, ...FILE_NAMES.map((name) => `${NEXUS_PREFIX}/${name}`)].map((address) => [address, address]),
);

/** Whether an address is one of the page's files. */
export const isNexusAsset = (pathname: string): boolean => Object.hasOwn(FILES, pathname);

const NOT_FOUND = (): Response => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

/** One of the pages' files, for anyone. */
export async function serveNexusAsset(request: Request, env: NexusEnv): Promise<Response> {
  const url = new URL(request.url);
  const target = Object.hasOwn(FILES, url.pathname) ? FILES[url.pathname] : undefined;
  if (!target || !env.ASSETS) return NOT_FOUND();

  const rewritten = new URL(request.url);
  rewritten.pathname = target;
  rewritten.search = "";
  const upstream = await env.ASSETS.fetch(new Request(rewritten.toString(), { method: "GET" }));
  const headers = new Headers(upstream.headers);
  // A page is for one person at one moment: it is not kept.
  headers.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers });
}
