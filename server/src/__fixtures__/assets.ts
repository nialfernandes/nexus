// A stand-in for Cloudflare's static asset server (the `ASSETS` binding that wrangler.jsonc's `assets` setting makes),
// reading the files in public/. It does what the real one does for the files Nexus asks for: a path that names a file
// gives the file, a path with no extension gives the `.html` file of that name (`/nexus/approve` is
// `nexus/approve.html`), and a path that ends in a slash gives the folder's `index.html` (`/nexus/` is `nexus/index.html`).
// Anything else is a plain 404.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const PUBLIC = join(import.meta.dirname, "../../public");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};

export function staticAssets(): Fetcher {
  const assets = {
    async fetch(request: Request): Promise<Response> {
      const wanted = normalize(new URL(request.url).pathname);
      const candidates = wanted.endsWith("/") ? [join(PUBLIC, wanted, "index.html")] : [join(PUBLIC, wanted), `${join(PUBLIC, wanted)}.html`];
      const found = candidates.find((path) => path.startsWith(PUBLIC) && existsSync(path) && statSync(path).isFile());
      if (!found) return new Response("Not found", { status: 404 });
      return new Response(readFileSync(found), { status: 200, headers: { "content-type": TYPES[extname(found)] ?? "application/octet-stream" } });
    },
  };
  return assets as unknown as Fetcher;
}
