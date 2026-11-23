// Tests the two scripts the plugin's release stands on, check-release.mjs and bump-version.mjs, by running the real ones
// on copies of the real plugin folder (its manifest.json, versions.json, package.json and README, and the root lockfile), and
// reads the release workflow and the README for what they have to say. Run with:  node --test .github/release/release.test.mjs
//
// The dist folder a build writes is made here from the real manifest.json and styles.css, which plugin/esbuild.config.mjs
// copies as they are (its line 38), with a stand-in main.js, which that build makes from src/. The real build is run by hand
// and by the release workflow itself; a test of the asset list does not need the whole bundle.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { RELEASE_ASSETS, assetProblems, tagProblems } from "./check-release.mjs";
import { bump, compareVersions, nextVersion } from "./bump-version.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const REAL_PLUGIN = path.join(REPO, "plugin");
const CHECK = path.join(HERE, "check-release.mjs");
const BUMP = path.join(HERE, "bump-version.mjs");
const WORKFLOW = path.join(REPO, ".github", "workflows", "release.yml");

const scratch = mkdtempSync(path.join(os.tmpdir(), "nexus-release-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;

/** A copy of the files the scripts read and write, laid out as in the repository: <root>/plugin/... and <root>/package-lock.json. */
function repoCopy() {
  const root = path.join(scratch, `repo-${++count}`);
  const plugin = path.join(root, "plugin");
  mkdirSync(plugin, { recursive: true });
  for (const name of ["manifest.json", "versions.json", "package.json", "README.md", "styles.css"]) {
    cpSync(path.join(REAL_PLUGIN, name), path.join(plugin, name));
  }
  cpSync(path.join(REPO, "package-lock.json"), path.join(root, "package-lock.json"));
  return { root, plugin };
}

/** The folder a build writes, as plugin/esbuild.config.mjs does: manifest.json and styles.css copied, main.js built. */
function distCopy(plugin) {
  const dist = path.join(path.dirname(plugin), `dist-${++count}`);
  mkdirSync(dist);
  cpSync(path.join(plugin, "manifest.json"), path.join(dist, "manifest.json"));
  cpSync(path.join(plugin, "styles.css"), path.join(dist, "styles.css"));
  writeFileSync(path.join(dist, "main.js"), '"use strict";\nmodule.exports = {};\n');
  return dist;
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const readAll = (root) => ({
  manifest: readJson(path.join(root, "plugin", "manifest.json")),
  versions: readJson(path.join(root, "plugin", "versions.json")),
  pkg: readJson(path.join(root, "plugin", "package.json")),
  lock: readJson(path.join(root, "package-lock.json")),
  readme: readFileSync(path.join(root, "plugin", "README.md"), "utf8"),
});
const snapshot = (root) => JSON.stringify(readAll(root));

// The plugin's version as it is committed, and the versions after it that the tests bump a copy to. They are worked out from the manifest,
// so a release (which moves the manifest) does not break a test that bumps "the next version".
const CURRENT = readJson(path.join(REAL_PLUGIN, "manifest.json")).version;
const NEXT = nextVersion(CURRENT, "patch");
const AFTER_NEXT = nextVersion(NEXT, "patch");
const NEXT_MINOR = nextVersion(CURRENT, "minor");
const NEXT_MAJOR = nextVersion(CURRENT, "major");
/** A version as text to put in a pattern: its dots are dots. */
const literally = (version) => version.replaceAll(".", "\\.");

/** Runs a script the way the workflow and a person do, and says what it exited with and printed. */
function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("the tag has to be the plugin's version", () => {
  it("passes for the tag of the next version on a commit whose manifest says that version: the worked example", () => {
    const { root, plugin } = repoCopy();
    bump(NEXT, { pluginDir: plugin });
    assert.equal(readAll(root).manifest.version, NEXT);
    assert.deepEqual(tagProblems(NEXT, plugin), []);
  });

  it("stops a tag that is not the manifest's version, and names both", () => {
    const { plugin } = repoCopy();
    const manifestVersion = readJson(path.join(plugin, "manifest.json")).version;
    const problems = tagProblems("9.9.9", plugin);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /"9\.9\.9"/);
    assert.ok(problems[0].includes(`"${manifestVersion}"`), "it names the manifest's version too");
    assert.match(problems[0], /Nothing was released/);
  });

  it("stops at the command line with exit 1 and a FAIL line, and passes the plugin's own version as it is committed", () => {
    const own = readJson(path.join(REAL_PLUGIN, "manifest.json")).version;
    const wrong = run(CHECK, ["tag", `${own}1`]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /^FAIL: /m);
    const right = run(CHECK, ["tag", own]);
    assert.equal(right.code, 0, right.err);
    assert.match(right.out, /^ok: /);
  });

  it("stops a tag with a v in front, a suffix, or nothing at all, even when the rest is the version", () => {
    const { plugin } = repoCopy();
    const own = readJson(path.join(plugin, "manifest.json")).version;
    for (const tag of [`v${own}`, `${own}-beta.1`, `${own}.0`, "", undefined]) {
      assert.notDeepEqual(tagProblems(tag, plugin), [], `"${tag}" was accepted`);
    }
    assert.equal(run(CHECK, ["tag"]).code, 2, "no tag given is a wrong use, not a pass");
  });

  it("stops when versions.json has no line for the manifest's version, or a different oldest Obsidian", () => {
    const { plugin } = repoCopy();
    const manifest = readJson(path.join(plugin, "manifest.json"));
    writeFileSync(path.join(plugin, "versions.json"), "{}\n");
    assert.match(tagProblems(manifest.version, plugin).join("\n"), /versions\.json has no entry for/);
    writeFileSync(path.join(plugin, "versions.json"), JSON.stringify({ [manifest.version]: "0.0.1" }));
    assert.match(tagProblems(manifest.version, plugin).join("\n"), /needs Obsidian 0\.0\.1/);
  });

  it("is satisfied by the plugin folder as it is committed: versions.json knows the manifest's version", () => {
    const own = readJson(path.join(REAL_PLUGIN, "manifest.json")).version;
    assert.deepEqual(tagProblems(own, REAL_PLUGIN), []);
  });
});

describe("the files a release carries", () => {
  it("are main.js, manifest.json and styles.css and the script prints exactly those three paths", () => {
    assert.deepEqual(RELEASE_ASSETS, ["main.js", "manifest.json", "styles.css"]);
    const { plugin } = repoCopy();
    const dist = distCopy(plugin);
    const tag = readJson(path.join(plugin, "manifest.json")).version;
    assert.deepEqual(assetProblems(dist, tag), []);
    const cli = run(CHECK, ["assets", dist, tag]);
    assert.equal(cli.code, 0, cli.err);
    assert.deepEqual(
      cli.out.trim().split("\n").map((file) => path.basename(file)),
      ["main.js", "manifest.json", "styles.css"],
    );
    for (const file of cli.out.trim().split("\n")) assert.ok(existsSync(file), `${file} exists`);
  });

  it("are refused when one is missing, empty or joined by another file, or the built manifest is of another version", () => {
    const { plugin } = repoCopy();
    const tag = readJson(path.join(plugin, "manifest.json")).version;

    const missing = distCopy(plugin);
    rmSync(path.join(missing, "styles.css"));
    assert.match(assetProblems(missing, tag).join("\n"), /styles\.css is not in/);

    const empty = distCopy(plugin);
    writeFileSync(path.join(empty, "main.js"), "");
    assert.match(assetProblems(empty, tag).join("\n"), /main\.js in .* is empty/);

    const extra = distCopy(plugin);
    writeFileSync(path.join(extra, "main.js.map"), "{}");
    assert.match(assetProblems(extra, tag).join("\n"), /main\.js\.map is in .* but is not one of the release's files/);

    const other = distCopy(plugin);
    assert.match(assetProblems(other, "9.9.9").join("\n"), /says version .*, not the tag "9\.9\.9"/);

    assert.match(assetProblems(path.join(scratch, "no-such-folder"), tag).join("\n"), /was not built/);
    assert.equal(run(CHECK, ["assets", extra, tag]).code, 1);
  });
});

describe("the version bump", () => {
  it("changes manifest.json and versions.json together, and the package, the lockfile and the README with them", () => {
    const { root, plugin } = repoCopy();
    const before = readAll(root);
    const result = bump(NEXT, { pluginDir: plugin });
    const after = readAll(root);

    assert.equal(result.version, NEXT);
    assert.equal(after.manifest.version, NEXT);
    assert.deepEqual(after.versions, { ...before.versions, [NEXT]: before.manifest.minAppVersion });
    assert.equal(after.pkg.version, NEXT);
    assert.equal(after.lock.packages.plugin.version, NEXT);
    assert.ok(after.readme.includes(`(for example \`${NEXT}\`)`));
    assert.match(after.readme, new RegExp(`The manifest's version\\s+is \`${literally(NEXT)}\``));
    assert.ok(!after.readme.includes(`\`${CURRENT}\``), "no old version is left in the README");
    // Nothing else moved: the manifest is the same but for its version, the lockfile but for the plugin's line.
    assert.deepEqual({ ...after.manifest, version: before.manifest.version }, before.manifest);
    assert.deepEqual({ ...after.pkg, version: before.pkg.version }, before.pkg);
    const lockBefore = structuredClone(before.lock);
    lockBefore.packages.plugin.version = NEXT;
    assert.deepEqual(after.lock, lockBefore);
    assert.deepEqual(result.files.sort(), ["package-lock.json", "plugin/README.md", "plugin/manifest.json", "plugin/package.json", "plugin/versions.json"]);
  });

  it("leaves a plugin that the release check then accepts for the new tag, and not for the old one", () => {
    const { plugin } = repoCopy();
    bump("minor", { pluginDir: plugin });
    assert.deepEqual(tagProblems(NEXT_MINOR, plugin), []);
    assert.notDeepEqual(tagProblems(CURRENT, plugin), []);
  });

  it("keeps every old line of versions.json and writes each file the way it was written", () => {
    const { root, plugin } = repoCopy();
    const lines = Object.keys(readAll(root).versions);
    bump(NEXT, { pluginDir: plugin });
    bump(AFTER_NEXT, { pluginDir: plugin });
    assert.deepEqual(Object.keys(readAll(root).versions), [...lines, NEXT, AFTER_NEXT]);
    for (const name of ["manifest.json", "versions.json", "package.json"]) {
      const text = readFileSync(path.join(plugin, name), "utf8");
      assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`, `${name} keeps its two-space layout and last newline`);
    }
  });

  it("takes patch, minor and major, and a new oldest Obsidian with --min-app, which versions.json then records", () => {
    assert.equal(nextVersion("0.3.9", "patch"), "0.3.10");
    assert.equal(nextVersion("0.3.9", "minor"), "0.4.0");
    assert.equal(nextVersion("0.3.9", "major"), "1.0.0");
    assert.ok(compareVersions("0.3.10", "0.3.9") > 0, "versions compare as numbers, not as words");

    const { root, plugin } = repoCopy();
    const result = run(BUMP, []);
    assert.equal(result.code, 2, "no version given is a wrong use");
    const older = readAll(root).versions;
    bump(NEXT_MAJOR, { pluginDir: plugin, minApp: "1.9.2" });
    const after = readAll(root);
    assert.equal(after.manifest.minAppVersion, "1.9.2");
    assert.equal(after.versions[NEXT_MAJOR], "1.9.2");
    assert.deepEqual({ ...after.versions, [NEXT_MAJOR]: undefined }, { ...older, [NEXT_MAJOR]: undefined }, "every older line still says what its version needed");
    assert.deepEqual(tagProblems(NEXT_MAJOR, plugin), []);
  });

  it("refuses a version that is not later, not a version, or already in versions.json, and writes nothing", () => {
    const { root, plugin } = repoCopy();
    const before = snapshot(root);
    for (const request of [CURRENT, "0.0.1", `v${NEXT}`, "0.3", `${NEXT}-beta`, "next", ""]) {
      assert.throws(() => bump(request, { pluginDir: plugin }), Error, `"${request}" was taken`);
    }
    assert.throws(() => bump(NEXT, { pluginDir: plugin, minApp: "1.9" }), /not an Obsidian version/);
    assert.equal(snapshot(root), before, "every file is as it was");

    const versions = readJson(path.join(plugin, "versions.json"));
    writeFileSync(path.join(plugin, "versions.json"), JSON.stringify({ ...versions, [NEXT]: "1.8.7" }));
    const withLine = snapshot(root);
    assert.throws(() => bump(NEXT, { pluginDir: plugin }), new RegExp(`already has ${literally(NEXT)}`));
    assert.equal(snapshot(root), withLine);
  });

  it("writes nothing when the README no longer has the sentence that names the version", () => {
    const { root, plugin } = repoCopy();
    const readme = readFileSync(path.join(plugin, "README.md"), "utf8").replace(/\(for example `\d+\.\d+\.\d+`\)/, "(for example a tag)");
    writeFileSync(path.join(plugin, "README.md"), readme);
    const before = snapshot(root);
    assert.throws(() => bump(NEXT, { pluginDir: plugin }), /README\.md has no tag example/);
    assert.equal(snapshot(root), before, "the manifest is not changed ahead of the README");
  });

  it("works as a command: prints the new version and what to do next, and exits 1 with a FAIL line when it cannot", () => {
    // The command works on the repository's own folder, so only the refusals are run here: they change nothing.
    const own = readJson(path.join(REAL_PLUGIN, "manifest.json")).version;
    const same = run(BUMP, [own]);
    assert.equal(same.code, 1);
    assert.match(same.err, /^FAIL: .* is not later than the manifest's version/m);
    const bad = run(BUMP, ["banana"]);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /^FAIL: "banana" is not a version/m);
    assert.equal(readJson(path.join(REAL_PLUGIN, "manifest.json")).version, own, "the real manifest is untouched");
  });
});

describe("the release workflow", () => {
  const text = readFileSync(WORKFLOW, "utf8");
  const at = (needle) => {
    const index = text.indexOf(needle);
    assert.ok(index >= 0, `release.yml has "${needle}"`);
    return index;
  };

  it("runs on a pushed tag of three numbers and on nothing else", () => {
    assert.match(text, /^on:\n {2}push:\n {4}tags:\n {6}- '\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\n/m);
    assert.doesNotMatch(text, /pull_request|branches:|workflow_dispatch|schedule:/);
  });

  it("checks the tag before it builds, builds with the repository's own build, checks the files, and only then makes the release", () => {
    const tag = at("check-release.mjs tag");
    const build = at("npm run build");
    const assets = at("check-release.mjs assets");
    const release = at("gh release create");
    assert.ok(tag < build && build < assets && assets < release, "tag check, build, file check, release: in that order");
    assert.ok(text.indexOf("gh release create") === text.lastIndexOf("gh release create"), "one place makes a release");
  });

  it("gives the release the files the script printed, and names none of them itself", () => {
    assert.match(text, /check-release\.mjs assets plugin\/dist/);
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ""), /main\.js|styles\.css|manifest\.json/, "the list of three is in check-release.mjs and nowhere else");
  });

  it("may write to the repository in the release job only, and gives the tag to the script through the environment", () => {
    assert.match(text, /^permissions:\n {2}contents: read\n/m);
    assert.equal(text.match(/contents: write/g)?.length, 1, "one grant of write");
    assert.ok(at("contents: write") > at("\njobs:"), "and it is below jobs:, on the job");
    const outsideEnv = text.split("\n").filter((line) => !/^\s*(TAG|GH_TOKEN):|^\s*#/.test(line)).join("\n");
    assert.doesNotMatch(outsideEnv, /\$\{\{/, "an expression is used only to fill an environment variable, never pasted into a command");
  });

  it("is pinned: every action is named by a full commit hash, as .github/check-pinned-actions.sh asks", () => {
    const out = execFileSync("bash", [path.join(REPO, ".github", "check-pinned-actions.sh")], { encoding: "utf8" });
    assert.match(out, /^ok: \d+ uses: line\(s\) are pinned/);
    assert.ok((text.match(/^\s*- uses:/gm) ?? []).length >= 2, "and the release workflow has its own uses: lines");
  });
});

describe("the README's install steps", () => {
  const readme = readFileSync(path.join(REAL_PLUGIN, "README.md"), "utf8");
  /** The sections whose heading starts with "Install": a section runs to the next "## ". */
  const installSections = readme
    .split(/^## /m)
    .slice(1)
    .filter((section) => /^Install/.test(section))
    .map((section) => ({ heading: section.split("\n")[0], body: section }));

  it("are there: through BRAT, and by copying the files", () => {
    assert.deepEqual(
      installSections.map((s) => s.heading),
      ["Install through BRAT", "Install by copying the files"],
    );
  });

  it("name no Terminal command: no code block, no command in code, no word for a shell", () => {
    const command = /^(npm|npx|node|git|cd|ls|mkdir|cp|mv|cat|curl|wget|sudo|brew|yarn|pnpm|bash|sh|open|tar|unzip|gh)\b/;
    for (const { heading, body } of installSections) {
      assert.doesNotMatch(body, /^\s*```/m, `${heading} has a code block`);
      assert.doesNotMatch(body, /\b(terminal|command line|command-line|shell|console)\b/i, `${heading} names a shell`);
      for (const [, code] of body.matchAll(/`([^`\n]+)`/g)) {
        assert.doesNotMatch(code, command, `${heading} has the command \`${code}\``);
      }
    }
  });

  it("tell a person to take the three files from the release, not to build them", () => {
    const copying = installSections[1].body;
    assert.match(copying, /\*\*Releases\*\*|release/i);
    assert.doesNotMatch(copying, /build it|npm run build/i);
  });
});
