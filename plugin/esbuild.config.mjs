// Builds src/main.ts into main.js, the file Obsidian loads beside manifest.json.
//
//   node esbuild.config.mjs          one build
//   node esbuild.config.mjs watch    rebuild when a source file changes
//
// The bundle is CommonJS and asks for nothing but `obsidian` (and the editor's own packages, which the plugin does not
// use): a phone has no Node and no Electron, so nothing from either may end up in it. Obsidian hands `obsidian` to every
// plugin, so it is left out of the bundle.

import esbuild from "esbuild";

const watching = process.argv[2] === "watch";

const options = {
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  external: ["obsidian", "@codemirror/*", "@lezer/*"],
  logLevel: "info",
  sourcemap: watching ? "inline" : false,
  treeShaking: true,
};

if (watching) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
