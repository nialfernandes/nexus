// The notes in Mentions/: one for each book, website, quote and person, named by its title. Whatever mentions a thing finds its note by
// the title, ignoring case, punctuation and a leading "The" (`titleKey`), so two notes that mention the same thing link to the same note.
// A note that exists is never made again: at most it gains the author or address it lacked. Nothing in it is ever changed or removed.

import type { Mention } from "./mention";
import { hasField, hasFrontMatter, withFrontLines } from "./note-text";
import type { NoteStore } from "./store";
import { cutAtWord, mentionName, mentionPath, noteName, titleKey } from "./titles";

/** A quote longer than this is named by its first words, and the whole of it is the note's text. */
const QUOTE_NAME_MAX = 80;

/** A note in Mentions/ as the job knows it without its text. */
interface Known {
  id: string;
  /** The name the note has, which is what a link to it says. */
  name: string;
}

/** A YAML text in double quotes: JSON's own escaping is valid YAML, so nothing in a title can break the front matter. */
const quoted = (text: string): string => JSON.stringify(text);

/** A link as a front matter value. It is quoted: a bare `[[name]]` is a list in a list to YAML, not a link. */
const linkValue = (name: string): string => quoted(`[[${name}]]`);

/** The note's text for a thing that has none: its kind and what is known of it in the front matter, and a quote's whole words as its text. */
function newText(mention: Mention, name: string, authorName: string | null): string {
  const lines = ["---", `type: ${mention.type}`];
  if (authorName !== null) lines.push(`author: ${linkValue(authorName)}`);
  if (mention.url !== undefined) lines.push(`url: ${quoted(mention.url)}`);
  lines.push("---");
  const words = mention.type === "quote" && mention.title !== name ? `\n> ${mention.title.replace(/\n/g, "\n> ")}\n` : "";
  return `${lines.join("\n")}\n${words}`;
}

export class MentionNotes {
  readonly #store: NoteStore;
  readonly #byKey = new Map<string, Known>();
  /** The name each thing was settled to in this run, so the same mention twice is one pass over its note, not two. */
  readonly #settled = new Map<string, string>();

  constructor(store: NoteStore, paths: ReadonlyArray<{ id: string; path: string }>) {
    this.#store = store;
    for (const ref of [...paths].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const name = mentionName(ref.path);
      if (name === null) continue;
      const key = titleKey(name);
      // Two notes with one key are a person's own doing; the first by path is the one links go to.
      if (key !== "" && !this.#byKey.has(key)) this.#byKey.set(key, { id: ref.id, name });
    }
  }

  /** The note a title already has, if any. */
  #find(titles: readonly string[]): Known | undefined {
    for (const title of titles) {
      const key = titleKey(title);
      const known = key === "" ? undefined : this.#byKey.get(key);
      if (known !== undefined) return known;
    }
    return undefined;
  }

  /**
   * Makes sure the thing has a note, and tells the note's name, which is what a link to it says. Null when the thing has no name a note
   * can have. A thing that already has a note is not made again: when the note lacks the author or address this mention knows, it is added.
   */
  async settle(mention: Mention): Promise<string | null> {
    const wanted = mention.type === "quote" ? cutAtWord(noteName(mention.title), QUOTE_NAME_MAX) : noteName(mention.title);
    if (titleKey(wanted) === "") return null;
    const done = this.#settled.get(`${mention.type}:${titleKey(wanted)}:${mention.author ?? ""}:${mention.url ?? ""}`);
    if (done !== undefined) return done;

    const authorName = mention.author === undefined || mention.type === "person" ? null : await this.settle({ type: "person", title: mention.author });
    const known = this.#find([wanted, ...(mention.alsoKnownAs ?? [])]);
    const name = known === undefined ? await this.#create(mention, wanted, authorName) : await this.#fill(known, mention, authorName);
    this.#settled.set(`${mention.type}:${titleKey(wanted)}:${mention.author ?? ""}:${mention.url ?? ""}`, name);
    return name;
  }

  async #create(mention: Mention, name: string, authorName: string | null): Promise<string> {
    const made = await this.#store.createNote(mentionPath(name), newText(mention, name, authorName));
    this.#byKey.set(titleKey(name), { id: made.id, name });
    return name;
  }

  /** Adds the author or the address to a note that has none, and nothing else. A note that changed meanwhile keeps what it has: the link works all the same. */
  async #fill(known: Known, mention: Mention, authorName: string | null): Promise<string> {
    if (authorName === null && mention.url === undefined) return known.name;
    const note = await this.#store.readNote(known.id);
    if (!hasFrontMatter(note.text)) return known.name;
    const lines: string[] = [];
    if (authorName !== null && !hasField(note.text, "author")) lines.push(`author: ${linkValue(authorName)}`);
    if (mention.url !== undefined && !hasField(note.text, "url")) lines.push(`url: ${quoted(mention.url)}`);
    if (lines.length === 0) return known.name;
    await this.#store.updateNote(known.id, note.version, withFrontLines(note.text, lines));
    return known.name;
  }
}
