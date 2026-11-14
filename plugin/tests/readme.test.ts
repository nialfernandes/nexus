// The Nexus plugin's README has to say where the plugin keeps the token and the version of each note: in Obsidian's
// per-device local storage, not in the `.obsidian` folder, which travels with a vault that something else syncs between
// devices. The rest of the README's promises are held by bundle.test.ts.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const README = readFileSync(path.join(PLUGIN, 'README.md'), 'utf8');

/** The README as one line of words: its line breaks and extra spaces do not matter to what it says. */
const WORDS = README.replace(/\s+/g, ' ');

describe('the Nexus plugin README on where things are kept', () => {
  it("says the token and the versions are in Obsidian's per-device local storage, not in the .obsidian folder", () => {
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

  it('says plainly that this version does not encrypt yet', () => {
    expect(WORDS).toMatch(/does not encrypt yet/i);
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
