// What Obsidian loads from the Nexus plugin: manifest.json says the plugin is called Nexus, has the id nexus and runs
// on mobile; `npm run build` in the plugin's folder produces main.js from the source; and the bundle asks for no
// Node or Electron module, which an iPhone does not have. Obsidian itself supplies `obsidian` and the editor's own
// packages, and those are the only modules the bundle may require.
//
// The build is run for real, here, with main.js removed first, so the file that is scanned is the one the build makes
// and never a stale one left in the folder.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = path.join(PLUGIN, 'manifest.json');
const MAIN = path.join(PLUGIN, 'main.js');
const README = path.join(PLUGIN, 'README.md');

/** The environment the build runs in. Vitest's own VITEST* variables are dropped: left in, a nested tool may print nothing. */
const CLEAN_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST'))),
  NO_COLOR: '1',
  FORCE_COLOR: '0',
};

/**
 * Every module a bundle asks for: `require("x")` and `import("x")`, in any quote. A built plugin is CommonJS, so there is
 * no `from "x"` to look for, and looking for one would only catch the plugin's own wording.
 */
function modulesAskedFor(code: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\brequire\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
    /\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) found.add(match[2]);
  return [...found].sort();
}

/** True for a module Obsidian does not provide on a phone: any Node built-in (with or without `node:`) and Electron. */
function isNodeOrElectron(name: string): boolean {
  const bare = name.replace(/^node:/, '');
  return name.startsWith('node:') || name === 'electron' || name.startsWith('electron/') || builtinModules.includes(bare) || builtinModules.includes(bare.split('/')[0]);
}

/** True for a module Obsidian puts in front of every plugin. */
const providedByObsidian = (name: string): boolean => name === 'obsidian' || name.startsWith('@codemirror/') || name.startsWith('@lezer/');

/** The build, run once for this file and shared by the tests that read what it makes. */
let built: Promise<void> | undefined;
function build(): Promise<void> {
  built ??= (async () => {
    expect(existsSync(path.join(PLUGIN, 'package.json')), 'package.json is there: the plugin has its own package').toBe(true);
    rmSync(MAIN, { force: true });
    await run('npm', ['run', 'build'], { cwd: PLUGIN, env: CLEAN_ENV, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  })();
  return built;
}

/** Long enough for a first build on a busy machine. */
const BUILD_TIME = 150_000;

describe('the Nexus plugin as Obsidian loads it', () => {
  it('builds manifest.json and main.js, where Obsidian looks for them', async () => {
    await build();
    expect(existsSync(MANIFEST), 'manifest.json sits beside main.js').toBe(true);
    expect(existsSync(MAIN), '`npm run build` makes main.js').toBe(true);
    expect(statSync(MAIN).size, 'and it is not empty').toBeGreaterThan(1000);
  }, BUILD_TIME);

  it('has a manifest that names the plugin Nexus, with the id nexus, and runs on mobile', async () => {
    await build();
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;
    expect(manifest.id).toBe('nexus');
    expect(manifest.name).toBe('Nexus');
    expect(manifest.isDesktopOnly, 'a plugin for the iPhone as well').toBe(false);
    for (const field of ['version', 'minAppVersion', 'description', 'author']) {
      expect(typeof manifest[field], `${field} is written, as Obsidian requires`).toBe('string');
      expect((manifest[field] as string).trim(), `${field} is not blank`).not.toBe('');
    }
    expect(manifest.version, 'a version a release can carry').toMatch(/^\d+\.\d+\.\d+$/);
  }, BUILD_TIME);

  it('is built with esbuild from its own package', () => {
    expect(existsSync(path.join(PLUGIN, 'package.json')), 'package.json is there').toBe(true);
    const pkg = JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(typeof pkg.scripts?.build, 'the package has a build script').toBe('string');
    expect(pkg.devDependencies?.esbuild, 'and esbuild is one of its own dev dependencies').toBeTruthy();
  });

  it('explains how to build it and how to install it, through BRAT and by copying the files, on an iPhone too', () => {
    expect(existsSync(README), 'README.md is there').toBe(true);
    const text = readFileSync(README, 'utf8');
    for (const term of ['BRAT', 'npm run build', 'manifest.json', 'main.js', '.obsidian/plugins/nexus', 'Files app']) {
      expect(text, `the README mentions ${term}`).toContain(term);
    }
  });

  it('asks for no Node or Electron module: only Obsidian and what Obsidian provides', async () => {
    // The scan first, on text that holds each kind of ask, so that finding nothing below can only mean there is nothing.
    const sample = [
      'const fs = require("fs");',
      "const e = require('electron');",
      'const p = require(`node:path`);',
      'const c = await import("crypto");',
      'const o = require("obsidian");',
      'const v = require("@codemirror/view");',
    ].join('\n');
    const sampled = modulesAskedFor(sample);
    expect(sampled.filter(isNodeOrElectron)).toEqual(['crypto', 'electron', 'fs', 'node:path']);
    expect(sampled.filter(providedByObsidian)).toEqual(['@codemirror/view', 'obsidian']);

    await build();
    const code = readFileSync(MAIN, 'utf8');
    const asked = modulesAskedFor(code);
    expect(code, 'a built plugin is CommonJS that requires the obsidian module').toMatch(/require\(["']obsidian["']\)/);
    expect(code).not.toContain('require("fs")');
    expect(code).not.toContain('require("electron")');
    expect(asked.filter(isNodeOrElectron), 'no Node built-in and no Electron').toEqual([]);
    expect(asked.filter((name) => !providedByObsidian(name)), 'nothing else is required either: Obsidian would not find it').toEqual([]);
  }, BUILD_TIME);
});
