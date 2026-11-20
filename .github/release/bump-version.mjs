// Gives the plugin its next version in every place that holds it, in one go, so a release is this command and then a tag.
//
//   node .github/release/bump-version.mjs 0.3.1                      the version to be
//   node .github/release/bump-version.mjs patch | minor | major      the next one after the manifest's
//   node .github/release/bump-version.mjs 0.4.0 --min-app 1.9.0      and the oldest Obsidian it runs on, when that has changed
//
// It writes, in plugin/ and at the repository root:
//   plugin/manifest.json    the version (and minAppVersion, with --min-app). This is the version a release is tagged with.
//   plugin/versions.json    Obsidian's map from each plugin version to the oldest Obsidian it runs on: one line more.
//   plugin/package.json     the version. plugin/tests/bundle.test.ts wants it to be the manifest's.
//   package-lock.json       the plugin's version in the lockfile, so `npm ci` and the lockfile agree.
//   plugin/README.md        the two places that name the version (the tag example and "the manifest's version is"), which
//                           plugin/tests/readme.test.ts wants to be the manifest's.
// It makes every new text first and writes nothing unless all of them could be made, so a half bump cannot be left behind.
// It never makes a commit or a tag: the person reads the diff, commits it and tags the commit with the version.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_DIR, VERSION_PATTERN } from "./check-release.mjs";

/** The two sentences of plugin/README.md that name the version. The version is the first group. */
const README_TAG_EXAMPLE = /\(for example `(\d+\.\d+\.\d+)`\)/;
const README_MANIFEST_VERSION = /The manifest's version\s+is `(\d+\.\d+\.\d+)`/;

function parts(version) {
  return version.split(".").map(Number);
}

/** Positive when a is a later version than b. */
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The version a request asks for: `patch`, `minor`, `major`, or a version itself. Throws, in plain words, when it is none of them. */
export function nextVersion(current, request) {
  const [major, minor, patch] = parts(current);
  if (request === "patch") return `${major}.${minor}.${patch + 1}`;
  if (request === "minor") return `${major}.${minor + 1}.0`;
  if (request === "major") return `${major + 1}.0.0`;
  if (!VERSION_PATTERN.test(request ?? "")) {
    throw new Error(`"${request}" is not a version (three numbers with dots, such as 0.3.1, with no "v") or patch, minor or major.`);
  }
  return request;
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Replaces the one version a README sentence names, and throws when the sentence is not there to be changed. */
function replaceInReadme(text, pattern, next, what) {
  const found = pattern.exec(text);
  if (!found) throw new Error(`plugin/README.md has no ${what}, so it cannot be kept true. Nothing was changed.`);
  return text.replace(pattern, (whole, old) => whole.replace(old, next));
}

/**
 * Makes the bump in `pluginDir` (and the lockfile in its parent folder). `request` is what the command line was given;
 * `minApp` is the new oldest Obsidian, or nothing to leave it. Returns the files it wrote, as paths below the repository.
 * Throws, and writes nothing, when the version cannot be had.
 */
export function bump(request, { pluginDir = PLUGIN_DIR, minApp } = {}) {
  const rootDir = path.dirname(pluginDir);
  const manifestFile = path.join(pluginDir, "manifest.json");
  const versionsFile = path.join(pluginDir, "versions.json");
  const packageFile = path.join(pluginDir, "package.json");
  const readmeFile = path.join(pluginDir, "README.md");
  const lockFile = path.join(rootDir, "package-lock.json");

  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const next = nextVersion(manifest.version, request);
  if (compareVersions(next, manifest.version) <= 0) {
    throw new Error(`${next} is not later than the manifest's version, ${manifest.version}. Nothing was changed.`);
  }
  if (minApp !== undefined && !VERSION_PATTERN.test(minApp)) {
    throw new Error(`"${minApp}" is not an Obsidian version (three numbers with dots, such as 1.9.0). Nothing was changed.`);
  }

  const versions = existsSync(versionsFile) ? JSON.parse(readFileSync(versionsFile, "utf8")) : {};
  if (Object.hasOwn(versions, next)) throw new Error(`plugin/versions.json already has ${next}. Nothing was changed.`);

  const nextManifest = { ...manifest, version: next, ...(minApp === undefined ? {} : { minAppVersion: minApp }) };
  const nextVersions = { ...versions, [next]: nextManifest.minAppVersion };

  const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
  const nextPackage = { ...pkg, version: next };

  let readme = readFileSync(readmeFile, "utf8");
  readme = replaceInReadme(readme, README_TAG_EXAMPLE, next, "tag example, \"(for example `x.y.z`)\"");
  readme = replaceInReadme(readme, README_MANIFEST_VERSION, next, "sentence \"The manifest's version is `x.y.z`\"");

  const writes = [
    [manifestFile, json(nextManifest)],
    [versionsFile, json(nextVersions)],
    [packageFile, json(nextPackage)],
    [readmeFile, readme],
  ];
  if (existsSync(lockFile)) {
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    if (lock.packages?.plugin) {
      lock.packages.plugin.version = next;
      writes.push([lockFile, json(lock)]);
    }
  }

  for (const [file, text] of writes) writeFileSync(file, text);
  return { version: next, files: writes.map(([file]) => path.relative(rootDir, file)) };
}

function main(argv) {
  const args = [];
  let minApp;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--min-app") minApp = argv[++i];
    else args.push(argv[i]);
  }
  if (args.length !== 1) {
    console.error("usage: bump-version.mjs <x.y.z | patch | minor | major> [--min-app <x.y.z>]");
    return 2;
  }
  try {
    const { version, files } = bump(args[0], { minApp });
    console.log(`The plugin is now version ${version}. Changed: ${files.join(", ")}.`);
    console.log(`Next: read the diff, commit it, then tag that commit ${version} and push the tag. The release workflow does the rest.`);
    return 0;
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
