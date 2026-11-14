// Search, on the device. The server holds only encrypted blobs and has no search, so the vault is searched here: a small
// index of every note's words, built from the vault's own files.
//
// The index is kept in memory and never written anywhere: a file of every word of every note would be a second copy of the
// notes, outside the vault's own. It is rebuilt from the vault each time the plugin starts.
//
// A search takes words. A note matches when each word is the start of some word in the note or in its name, in any case and
// with or without accents. Matches come back with the notes whose name matches first, then the ones that use the words most.

import { nameOf } from "./notes";

export interface SearchHit {
  path: string;
  /** The first line of the note that holds the first word searched for, shortened; empty when only the name matched. */
  snippet: string;
}

const SNIPPET_LENGTH = 120;

/** Words are runs of letters and digits, lower case, with accents taken off. */
function wordsOf(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

interface Entry {
  /** Each word and how many times the note uses it (the name's words included). */
  counts: Map<string, number>;
  nameWords: Set<string>;
  text: string;
}

export interface SearchIndex {
  /** Adds the note, or replaces what the index holds for it. */
  set(path: string, text: string): void;
  remove(path: string): void;
  rename(from: string, to: string): void;
  /** Every path the index holds, so the engine can drop the ones that have left the vault. */
  paths(): string[];
  search(query: string, limit?: number): SearchHit[];
}

export function createSearchIndex(): SearchIndex {
  const entries = new Map<string, Entry>();

  function entryFor(path: string, text: string): Entry {
    const counts = new Map<string, number>();
    const nameWords = new Set(wordsOf(nameOf(path).replace(/\.md$/i, "")));
    for (const word of [...wordsOf(text), ...nameWords]) counts.set(word, (counts.get(word) ?? 0) + 1);
    return { counts, nameWords, text };
  }

  /** How often the note uses words that start with `term`, and whether its name does; null when it uses none. */
  function use(entry: Entry, term: string): { uses: number; inName: boolean } | null {
    let uses = 0;
    for (const [word, count] of entry.counts) if (word.startsWith(term)) uses += count;
    if (uses === 0) return null;
    return { uses, inName: [...entry.nameWords].some((word) => word.startsWith(term)) };
  }

  function snippetOf(text: string, term: string): string {
    for (const line of text.split("\n")) {
      if (wordsOf(line).some((word) => word.startsWith(term))) {
        const shown = line.trim();
        return shown.length > SNIPPET_LENGTH ? `${shown.slice(0, SNIPPET_LENGTH)}…` : shown;
      }
    }
    return "";
  }

  return {
    set: (path, text) => void entries.set(path, entryFor(path, text)),
    remove: (path) => void entries.delete(path),
    rename(from, to) {
      const entry = entries.get(from);
      if (!entry) return;
      entries.delete(from);
      entries.set(to, entryFor(to, entry.text));
    },
    paths: () => [...entries.keys()],
    search(query, limit = 50) {
      const terms = wordsOf(query);
      if (terms.length === 0) return [];
      const hits: Array<SearchHit & { named: number; uses: number }> = [];
      for (const [path, entry] of entries) {
        let named = 0;
        let uses = 0;
        let matched = true;
        for (const term of terms) {
          const found = use(entry, term);
          if (!found) {
            matched = false;
            break;
          }
          uses += found.uses;
          if (found.inName) named++;
        }
        if (matched) hits.push({ path, snippet: snippetOf(entry.text, terms[0]), named, uses });
      }
      hits.sort((a, b) => b.named - a.named || b.uses - a.uses || (a.path < b.path ? -1 : 1));
      return hits.slice(0, limit).map(({ path, snippet }) => ({ path, snippet }));
    },
  };
}
