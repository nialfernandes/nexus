// Nothing in the plugin names a person, and nothing points at a particular server. The Nexus address and the user name
// are settings the person enters, so no file in this folder (source, tests, manifest, README, build files) may carry
// the project owner's name or address. This is the same search a reviewer runs by hand over the plugin folder.
//
// The words searched for are written as pieces, so this file does not hold them whole itself.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const NAME = new RegExp(['ni', 'al'].join(''), 'i');

/**
 * What is not the plugin's own writing: what npm installed, and the build's output. `main.js` is the bundle, which holds the
 * encryption library's WebAssembly written out as base64 text, and a search for a name in any case finds letters of it by chance.
 * The source it is built from is searched, and the bundle is held to what it asks for by bundle.test.ts.
 */
const SKIPPED_FOLDERS = new Set(['node_modules']);
const SKIPPED_FILES = new Set(['main.js']);

/** Every file under `folder`, as a path from the plugin's folder. */
function filesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap((entry) => {
    const full = path.join(folder, entry);
    if (statSync(full).isDirectory()) return SKIPPED_FOLDERS.has(entry) ? [] : filesUnder(full);
    return SKIPPED_FILES.has(entry) && path.dirname(full) === PLUGIN.replace(/\/$/, '') ? [] : [path.relative(PLUGIN, full)];
  });
}

describe('the plugin folder', () => {
  const files = filesUnder(PLUGIN);

  it('finds the files it is meant to search (so that finding nothing means nothing is there)', () => {
    for (const expected of ['manifest.json', 'README.md', 'package.json', 'src/main.ts', 'src/settings.ts', 'tests/world.ts']) {
      expect(files, `${expected} is searched`).toContain(expected);
    }
    expect(files.some((file) => file.startsWith('node_modules'))).toBe(false);
    expect(files, 'the built bundle is not searched: it holds the encryption library as base64').not.toContain('main.js');
  });

  it('holds no name of a person or of a site, in any file, any case', () => {
    const hits = files.flatMap((file) =>
      readFileSync(path.join(PLUGIN, file), 'utf8')
        .split('\n')
        .flatMap((line, index) => (NAME.test(line) ? [`${file}:${index + 1}: ${line.trim().slice(0, 80)}`] : [])),
    );
    expect(hits).toEqual([]);
  });

  it('has a manifest whose author and links name the project, not a person', () => {
    const manifest = JSON.parse(readFileSync(path.join(PLUGIN, 'manifest.json'), 'utf8')) as Record<string, string>;
    expect(manifest.author).toBe('Nexus contributors');
    for (const field of ['authorUrl', 'fundingUrl']) {
      const link = manifest[field];
      if (link !== undefined) expect(link, `${field} names no person`).not.toMatch(NAME);
    }
  });

  it('has no default address and no default user: the source names no web address of its own', () => {
    const source = files.filter((file) => file.startsWith('src/'));
    expect(source.length).toBeGreaterThan(3);
    for (const file of source) {
      const text = readFileSync(path.join(PLUGIN, file), 'utf8');
      // The one address in the source is the example shown greyed in the settings field, on the reserved example domain.
      const urls = (text.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((url) => !/^https?:\/\/(?:[a-z]+\.)?example\.com(?:\/|$)/.test(url));
      expect(urls, `${file} holds no address of a real server`).toEqual([]);
    }
  });
});
