// The two checks the release workflow (.github/workflows/release.yml) makes before it makes a release.
//
//   node check-release.mjs tag <tag>              the tag has to be the plugin's version, and versions.json has to know it
//   node check-release.mjs assets <dist> <tag>    <dist> has to hold the three files a release carries, and nothing else;
//                                                 prints their paths, one to a line, which are what the release is given
//
// Both exit 1 and say why in plain words. Nothing here writes a file.
//
// Why the tag has to be the version: BRAT installs from a GitHub release and takes the plugin's manifest.json from the
// release's own files. Obsidian wants the release's tag, its name and the version in that manifest.json to be one and the
// same, and BRAT, when they are not, overrides the manifest's version with the tag and warns. So a release whose tag is not
// the manifest's version is stopped here, before it exists. The tag has no `v` in front, as Obsidian asks.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The plugin's folder in this repository: where manifest.json, versions.json and the README are. */
export const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin");

/** The three files a release carries, as the plugin's build writes them into its dist folder. Nothing else is attached. */
export const RELEASE_ASSETS = ["main.js", "manifest.json", "styles.css"];

/** A version Obsidian can read: three numbers and dots, no `v`, no suffix. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * What is wrong with releasing `tag` from the plugin folder `pluginDir`: a list of plain sentences, empty when nothing is.
 * It reads manifest.json and versions.json there.
 */
export function tagProblems(tag, pluginDir = PLUGIN_DIR) {
  const problems = [];
  if (typeof tag !== "string" || tag === "") {
    return ["no tag was given, so there is nothing to compare with the plugin's version."];
  }
  const manifestFile = path.join(pluginDir, "manifest.json");
  if (!existsSync(manifestFile)) return [`${manifestFile} is missing.`];
  const manifest = readJson(manifestFile);

  if (!VERSION_PATTERN.test(tag)) {
    problems.push(`the tag "${tag}" is not three numbers with dots, such as 0.3.1 (no "v" in front, as Obsidian asks).`);
  }
  if (tag !== manifest.version) {
    problems.push(`the tag "${tag}" is not the version in plugin/manifest.json, "${manifest.version}". Nothing was released.`);
  }

  const versionsFile = path.join(pluginDir, "versions.json");
  if (!existsSync(versionsFile)) {
    problems.push(`${versionsFile} is missing.`);
  } else {
    const versions = readJson(versionsFile);
    if (!Object.hasOwn(versions, manifest.version)) {
      problems.push(`plugin/versions.json has no entry for ${manifest.version}, the manifest's version.`);
    } else if (versions[manifest.version] !== manifest.minAppVersion) {
      problems.push(
        `plugin/versions.json says ${manifest.version} needs Obsidian ${versions[manifest.version]}, but plugin/manifest.json says ${manifest.minAppVersion}.`,
      );
    }
  }
  return problems;
}

/**
 * What is wrong with the build in `dist` as the files of the release of `tag`: a list of plain sentences, empty when nothing is.
 * The folder has to hold exactly the three release files, each with something in it, and the manifest among them has to be
 * the one the release is named after.
 */
export function assetProblems(dist, tag) {
  if (!existsSync(dist) || !statSync(dist).isDirectory()) return [`${dist} is not a folder: the plugin was not built.`];
  const problems = [];
  const found = readdirSync(dist).sort();
  for (const name of RELEASE_ASSETS) {
    if (!found.includes(name)) problems.push(`${name} is not in ${dist}.`);
    else if (statSync(path.join(dist, name)).size === 0) problems.push(`${name} in ${dist} is empty.`);
  }
  for (const name of found) {
    if (!RELEASE_ASSETS.includes(name)) problems.push(`${name} is in ${dist} but is not one of the release's files (${RELEASE_ASSETS.join(", ")}).`);
  }
  const built = path.join(dist, "manifest.json");
  if (problems.length === 0 && readJson(built).version !== tag) {
    problems.push(`the built manifest.json says version ${readJson(built).version}, not the tag "${tag}".`);
  }
  return problems;
}

function main(argv) {
  const [command, ...rest] = argv;
  let problems;
  if (command === "tag" && rest.length === 1) {
    problems = tagProblems(rest[0]);
  } else if (command === "assets" && rest.length === 2) {
    problems = assetProblems(path.resolve(rest[0]), rest[1]);
    if (problems.length === 0) {
      for (const name of RELEASE_ASSETS) console.log(path.join(path.resolve(rest[0]), name));
      return 0;
    }
  } else {
    console.error("usage: check-release.mjs tag <tag> | check-release.mjs assets <dist folder> <tag>");
    return 2;
  }
  if (problems.length === 0) {
    console.log(`ok: the tag ${rest[0]} is the plugin's version.`);
    return 0;
  }
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
