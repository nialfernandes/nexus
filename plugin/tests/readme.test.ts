// The Nexus plugin's README has to say where the plugin keeps the token and the version of each note: in Obsidian's
// per-device local storage, not in the `.obsidian` folder, which travels with a vault that something else syncs between
// devices. The rest of the README's promises are held by bundle.test.ts.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const README = readFileSync(path.join(PLUGIN, 'README.md'), 'utf8');

/** The README as one line of words: its line breaks, extra spaces and the `>` that starts each line of a quoted notice do not matter to what it says. */
const WORDS = README.replace(/^> ?/gm, '').replace(/\s+/g, ' ');

describe('the Nexus plugin README on where things are kept', () => {
  it("says the token and what is known of each note's version are in Obsidian's per-device local storage, not in the .obsidian folder", () => {
    expect(WORDS).toMatch(/token[^.]*per-device local storage/i);
    expect(WORDS).toMatch(/version[^.]*per-device local storage/i);
    expect(WORDS).toMatch(/per-device local storage, not in the `\.obsidian` folder/i);
  });

  it('never says the .obsidian folder is where the plugin keeps its token', () => {
    expect(WORDS).not.toMatch(/\.obsidian[^.]{0,40}keeps its token/i);
    expect(WORDS).not.toMatch(/keeps? (the|its) token[^.]*\.obsidian/i);
  });

  it('says what the data file holds: the address and the user name and nothing else', () => {
    expect(WORDS).toMatch(/data\.json.{0,80}holds only the Nexus address and the user name/i);
  });
});

describe('the Nexus plugin README on what a reader must know first', () => {
  it('opens with the not-yet-audited notice, before anything else, and links the threat model', () => {
    const firstHeading = README.indexOf('\n## ');
    const notice = README.search(/not yet audited/i);
    expect(notice, 'the notice is there').toBeGreaterThan(-1);
    expect(notice, 'and comes before the first section').toBeLessThan(firstHeading);
    const link = /\[threat model\]\(([^)]+)\)/.exec(README)?.[1];
    expect(link, 'it links the threat model').toBeTruthy();
    expect(existsSync(path.join(PLUGIN, link!)), `${link} is a file in this repository`).toBe(true);
  });

  it('says plainly what this version does with notes and what it cannot do yet: it encrypts on the device, and the logic that unlocks it is built, but no screen starts it', () => {
    expect(WORDS).toMatch(/encrypts every note on your own device before it is sent/i);
    expect(WORDS).toMatch(/screens that make the vault key[^.]*are not built yet/i);
    expect(WORDS).toMatch(/logic behind them is built and tested, but nothing in the plugin starts it/i);
    expect(WORDS).toMatch(/has no key and syncs nothing/i);
    expect(WORDS).toMatch(/status line says the vault is locked/i);
    expect(WORDS, 'and no longer says that notes are sent as they are').not.toMatch(/does not encrypt yet|sends the text of each note to your Nexus server as it is/i);
  });

  it('says that the key is held in memory only, where the engine asks for it, and that the setup controller and the key holder are what fill and empty it', () => {
    expect(WORDS).toMatch(/held in memory only while unlocked, and nothing in this plugin writes it to disk/i);
    expect(WORDS).toMatch(/unlock port \(`src\/unlock\.ts`\)/);
    expect(WORDS).toMatch(/key holder \(`src\/key-holder\.ts`\)/);
    expect(WORDS).toMatch(/setup controller \(`src\/vault-setup\.ts`\)/);
    expect(WORDS).toMatch(/no second copy of any of them in this plugin/i);
    expect(WORDS, 'and no longer says the plugin is given a port that never holds a key').not.toMatch(/never holds a key/i);
  });

  it('says that merging and search are done on the device, because Nexus cannot read a note', () => {
    expect(WORDS).toMatch(/merges the two edits line by line on your device/i);
    expect(WORDS).toMatch(/The engine can search the vault on your device/i);
    expect(WORDS).toMatch(/Nexus cannot read a note, merge two edits or search/i);
  });

  it('says that a second note made at one path is moved to a duplicate path and synced, never kept only on the device', () => {
    expect(WORDS).toMatch(/smaller id keeps the path/i);
    expect(WORDS).toMatch(/`<name> \(duplicate <device> <date>\)\.md`, an ordinary note that is synced/i);
    expect(WORDS).toMatch(/both texts are in Nexus and on every device/i);
  });

  it('says where the vault id comes from and that the plugin keeps it nowhere else, and that search has no screen because Obsidian searches its own files', () => {
    expect(WORDS).toMatch(/vault id comes through the same port\. It is not secret/i);
    expect(WORDS).toMatch(/beside the wraps on your server/i);
    expect(WORDS).toMatch(/keeps it nowhere else, so the data file still holds only the address and the user name/i);
    expect(WORDS, 'and no longer says that storing it is later work').not.toMatch(/does none of that storing yet/i);
    expect(WORDS).toMatch(/inside Obsidian its own search already reads your files/i);
  });

  it("says to run npm ci and npm run check at the repository's root, which builds the encryption package first", () => {
    expect(WORDS).toMatch(/npm ci/);
    expect(WORDS).toMatch(/npm run check/);
    expect(WORDS).toMatch(/one workspace of the repository's root `package\.json`/i);
    expect(WORDS).toMatch(/builds the encryption package, type-checks every package/i);
    expect(WORDS, 'and no longer names the per-package install the root replaced').not.toMatch(/npm run packages|cd plugin/);
    const root = JSON.parse(readFileSync(path.join(PLUGIN, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string>; workspaces: string[] };
    expect(root.scripts.check, 'the root has the check the README names').toBeTruthy();
    expect(root.workspaces, 'and the plugin is one of its workspaces').toContain('plugin');
  });

  it('says there is no default address and no default user, and that nothing is sent until both are set', () => {
    expect(WORDS).toMatch(/no default address and no default user/i);
    expect(WORDS).toMatch(/sends nothing to anyone until you have entered both/i);
  });

  it('explains how to install it through BRAT from this repository, and which files a release carries', () => {
    expect(WORDS).toMatch(/## Install through BRAT/);
    expect(WORDS).toMatch(/Add beta plugin/);
    expect(WORDS).toMatch(/`owner\/name`/);
    expect(WORDS).toMatch(/`manifest\.json` and `main\.js`/);
    const manifest = JSON.parse(readFileSync(path.join(PLUGIN, 'manifest.json'), 'utf8')) as { version: string };
    expect(WORDS, "a release's tag is the manifest's version").toContain(`(for example \`${manifest.version}\`)`);
  });
});
