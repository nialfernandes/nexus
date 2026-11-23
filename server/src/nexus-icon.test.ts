// The Nexus app icon (nialfernandes #826): four files in public/nexus (icon.svg, icon-192.png, icon-512.png, apple-touch-icon.png) that the
// Worker serves to anyone beside the pages, as it serves the stylesheets, and that the head of both pages (the Nexus page and the approval page)
// names: the tab's icon, the sized PNGs, and the one a phone's home screen takes. The top bar's mark on the drawn boards is the word "nexus" in
// type, not the icon, so the page does not draw the icon there. Through the Nexus Worker with the stand-in for the asset server
// (__fixtures__/assets.ts), the page's own files being the real ones.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "./plugs/cloudflare/worker";
import { ORIGIN, appEnv, setUpNexus, signInOwner, signInStranger } from "./__fixtures__/nexus-world";

const FOLDER = join(import.meta.dirname, "../public/nexus");

/** The four files, where each is served, what it is served as, and (for a picture) how many pixels it is on each side. */
const ICONS = [
  { file: "icon.svg", type: "image/svg+xml", pixels: null },
  { file: "icon-192.png", type: "image/png", pixels: 192 },
  { file: "icon-512.png", type: "image/png", pixels: 512 },
  { file: "apple-touch-icon.png", type: "image/png", pixels: 180 },
] as const;

/** The two pages whose heads name the icon. */
const PAGES = [{ name: "the Nexus page", path: "/nexus/" }, { name: "the approval page", path: "/nexus/approve" }] as const;

let owner: string;
let stranger: string;

beforeAll(async () => {
  await setUpNexus();
  owner = (await signInOwner()).cookie;
  stranger = (await signInStranger()).cookie;
});

const get = (path: string, cookie?: string): Promise<Response> =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" }), appEnv());

/** The width and height written in a PNG's header (its first chunk), or null when the bytes are not a PNG. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, at) => bytes[at] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Every <link> in a page's head: its rel, href, type and sizes. */
function linksOf(html: string): Array<{ rel: string; href: string; type?: string; sizes?: string }> {
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1];
  return (html.match(/<link\b[^>]*>/gi) ?? []).map((tag) => ({ rel: attr(tag, "rel") ?? "", href: attr(tag, "href") ?? "", type: attr(tag, "type"), sizes: attr(tag, "sizes") }));
}

describe("the four icon files", () => {
  it("are in the app: a picture that draws and does nothing else, and three PNGs of the sizes they are named for", () => {
    const svg = readFileSync(join(FOLDER, "icon.svg"), "utf8");
    expect(svg, "an SVG").toMatch(/^<svg\b[^>]*\bxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg, "served from Nexus's own address, so it holds no script, no event handler and nothing that fetches").not.toMatch(/<script|<foreignObject|<image|<use\b|\son[a-z]+\s*=|href\s*=|url\(\s*["']?https?:/i);
    for (const { file, pixels } of ICONS.filter((icon) => icon.pixels !== null)) {
      expect(pngSize(readFileSync(join(FOLDER, file))), `${file} is a PNG, ${pixels} px on each side`).toEqual({ width: pixels, height: pixels });
    }
  });
});

describe("the Worker serves them", () => {
  it("to the owner, to a stranger and to nobody, byte for byte as the files are, as the type each is, and not kept by a browser", async () => {
    for (const { file, type } of ICONS) {
      const onDisk = readFileSync(join(FOLDER, file));
      for (const [who, cookie] of [["the owner", owner], ["a stranger", stranger], ["nobody", undefined]] as const) {
        const res = await get(`/nexus/${file}`, cookie);
        expect(res.status, `${file} for ${who}`).toBe(200);
        expect(res.headers.get("content-type"), `${file} for ${who}`).toBe(type);
        expect(res.headers.get("cache-control"), `${file} is served as the pages' files are`).toBe("no-store");
        expect(Buffer.from(await res.arrayBuffer()).equals(onDisk), `${file} for ${who} is the file, unchanged`).toBe(true);
      }
    }
  });

  it("and no other picture, name or folder beside them, and none of them at the old prefix", async () => {
    for (const path of ["/nexus/icon.png", "/nexus/icon", "/nexus/favicon.ico", "/nexus/icon-180.png", "/nexus/icons/icon.svg", "/nexus/icon.svg/", "/nexus/icon.svg/x"]) {
      expect((await get(path, owner)).status, path).toBe(404);
    }
    for (const { file } of ICONS) {
      expect((await get(`/apps/nexus/${file}`, owner)).status, `${file} at the old prefix`).toBe(404);
      expect((await get(`/apps/nexus/${file}`)).status, `${file} at the old prefix, signed out`).toBe(404);
    }
  });
});

describe("the head of both pages names the icon", () => {
  for (const page of PAGES) {
    it(`on ${page.name}: the SVG icon, the two sized PNG icons and the home screen icon, each a file the Worker serves as the type the link says`, async () => {
      const links = linksOf(await (await get(page.path)).text());
      const icons = links.filter((link) => link.rel === "icon");
      expect(icons.map((link) => [link.href, link.type, link.sizes]), "the icons").toEqual([
        ["/nexus/icon.svg", "image/svg+xml", undefined],
        ["/nexus/icon-192.png", "image/png", "192x192"],
        ["/nexus/icon-512.png", "image/png", "512x512"],
      ]);
      const touch = links.filter((link) => link.rel === "apple-touch-icon");
      expect(touch.map((link) => link.href), "the home screen icon").toEqual(["/nexus/apple-touch-icon.png"]);

      for (const link of [...icons, ...touch]) {
        const res = await get(link.href);
        expect(res.status, `${link.href} is served`).toBe(200);
        if (link.type) expect(res.headers.get("content-type"), `${link.href} is the type its link says`).toBe(link.type);
        if (link.sizes) {
          const side = Number(link.sizes.split("x")[0]);
          expect(pngSize(new Uint8Array(await res.arrayBuffer())), `${link.href} is as big as its link says`).toEqual({ width: side, height: side });
        }
      }
    });
  }

  it("and the top bar's mark stays the word nexus in type, as the boards draw it: no picture is put in the page", async () => {
    const html = await (await get("/nexus/")).text();
    expect(html).toMatch(/<span class="slab__mark">nexus<\/span>/);
    for (const page of PAGES) expect(await (await get(page.path)).text(), `${page.name} draws no picture`).not.toMatch(/<img\b/i);
    expect(await (await get("/nexus/nexus.css")).text(), "and its stylesheet loads no picture").not.toMatch(/url\(/i);
  });
});
