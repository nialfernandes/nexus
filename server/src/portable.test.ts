// Nexus's logic stays portable: it reaches its host only through ports (a SQL plug, a clock, secrets, a sign-in and
// settings: src/ports.ts), never through a Cloudflare binding. This reads the sources (no database, no Worker) and
// holds these rules:
//
//   1. no file outside src/plugs/cloudflare names a Cloudflare type or a binding (NEXUS_DB included), reads `env`,
//      or imports from Cloudflare or Hono;
//   2. the logic asks the clock and the machine for nothing directly (no Date.now, no crypto, no Math.random);
//   3. its SQL is the common ground of SQLite and Postgres, written with `?` placeholders (this is the test that
//      refuses SQLite-only SQL, so a host that is not SQLite can run the same logic);
//   4. the Cloudflare plugs exist, and they are the one place that names the database binding.
//
// The other suites run Nexus through the Cloudflare Worker (src/*.test.ts); this is the part that proves the shape
// of the code behind it.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const NEXUS = import.meta.dirname

/** The source without its comments, so a sentence about INSERT OR IGNORE is not mistaken for the SQL. */
function code(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
    } else if (c === '"' || c === "'" || c === '`') {
      out += c
      i++
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') { out += source[i++] }
        out += source[i++]
      }
      out += c
      i++
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Every non-test source file under a folder, skipping fixtures and suites (they are test support). */
function sourcesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__fixtures__' || name === '__suites__' ? [] : sourcesUnder(path)
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : []
  })
}

const read = (path: string) => code(readFileSync(path, 'utf8'))
const rel = (path: string) => relative(NEXUS, path)

const all = sourcesUnder(NEXUS)
const plugs = all.filter((p) => rel(p).startsWith('plugs/cloudflare/'))
const logic = all.filter((p) => !rel(p).startsWith('plugs/'))

const CLOUDFLARE = /\b(D1Database|D1PreparedStatement|D1Result|R2Bucket|R2Object|KVNamespace|DurableObject\w*|ExecutionContext|Fetcher|Queue)\b|cloudflare:|@cloudflare|\benv\.[A-Z]|\bBindings\b|\bAppEnv\b|from ['"]hono/

const SQLITE_ONLY = [
  [/\bjson_each\b|\bjson_extract\b|\bjson_array\b|->>/i, 'SQLite JSON functions'],
  [/INSERT\s+OR\s+(IGNORE|REPLACE)|REPLACE\s+INTO/i, 'INSERT OR ... / REPLACE INTO (use ON CONFLICT)'],
  [/\bPRAGMA\b|\bsqlite_\w+|\browid\b|\bAUTOINCREMENT\b/i, 'SQLite-only names'],
  [/\bIFNULL\s*\(|\bGLOB\b|\bstrftime\s*\(|\bunixepoch\s*\(|\bdatetime\s*\(|\bjulianday\s*\(/i, 'SQLite-only functions'],
  [/\$\d|:\w+\s*[,)]|@\w+\s*[,)]/, 'a placeholder other than ?'],
] as const

describe('Nexus is built, and in two parts', () => {
  it('has logic of its own and a folder of Cloudflare plugs', () => {
    expect(logic.length, 'logic files under src, outside plugs/').toBeGreaterThan(0)
    expect(plugs.length, 'plug files under src/plugs/cloudflare').toBeGreaterThan(0)
  })
})

describe('Nexus logic', () => {
  it('names no Cloudflare type, reads no binding, and imports nothing from Cloudflare or Hono', () => {
    for (const file of logic) expect(read(file), rel(file)).not.toMatch(CLOUDFLARE)
    expect(logic.length).toBeGreaterThan(0)
  })

  it('never names the database binding', () => {
    for (const file of logic) expect(read(file), rel(file)).not.toMatch(/NEXUS_DB/)
    expect(logic.length).toBeGreaterThan(0)
  })

  it('asks the clock for the time, not the machine it runs on', () => {
    for (const file of logic) {
      expect(read(file), rel(file)).not.toMatch(/Date\.now\(|crypto\.(getRandomValues|subtle|randomUUID)|Math\.random\(/)
    }
    expect(logic.length).toBeGreaterThan(0)
  })

  it('writes SQL in the common ground of SQLite and Postgres', () => {
    for (const file of logic) {
      const text = read(file)
      for (const [pattern, what] of SQLITE_ONLY) expect(text, `${rel(file)}: ${what}`).not.toMatch(pattern)
    }
    expect(logic.length).toBeGreaterThan(0)
  })
})

describe('the Cloudflare plugs', () => {
  it('are the only Nexus files that name a Cloudflare type', () => {
    const outside = all.filter((p) => !rel(p).startsWith('plugs/cloudflare/') && CLOUDFLARE.test(read(p)))
    expect(outside.map(rel)).toEqual([])
    expect(plugs.length).toBeGreaterThan(0)
  })

  it('do name the database binding: the one place that reads it', () => {
    const naming = plugs.filter((p) => /NEXUS_DB/.test(read(p)))
    expect(naming.length, 'a Cloudflare plug that reads NEXUS_DB').toBeGreaterThan(0)
  })
})
