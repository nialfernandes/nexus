// Builds src/main.ts into dist/main.js, and puts manifest.json and styles.css beside it: the three files a person copies into a vault's
// `.obsidian/plugins/nexus/` folder, and the three Obsidian loads.
//
//   node esbuild.config.mjs          one build
//   node esbuild.config.mjs watch    rebuild when a source file changes
//
// The bundle is CommonJS and asks for nothing but `obsidian` (and the editor's own packages, which the plugin does not
// use): a phone has no Node and no Electron, so nothing from either may end up in it. Obsidian hands `obsidian` to every
// plugin, so it is left out of the bundle.

import { copyFileSync, mkdirSync } from "node:fs";
import esbuild from "esbuild";

/** Where the three files are written. */
const OUT_DIR = "dist";
/** The files that are copied as they are, beside the built main.js. */
const COPIED = ["manifest.json", "styles.css"];

const watching = process.argv[2] === "watch";

const options = {
  entryPoints: ["src/main.ts"],
  outfile: `${OUT_DIR}/main.js`,
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  // The encryption library (libsodium, inside @nexus/crypto's build) reads `import.meta.url` in a try block; a plugin file has no
  // module address, so it is given an empty one, as the probe does.
  define: { "import.meta.url": '""' },
  external: ["obsidian", "@codemirror/*", "@lezer/*"],
  logLevel: "info",
  sourcemap: watching ? "inline" : false,
  treeShaking: true,
};

mkdirSync(OUT_DIR, { recursive: true });
for (const file of COPIED) copyFileSync(file, `${OUT_DIR}/${file}`);

if (watching) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
