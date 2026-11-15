// What a title is, for this job: how two titles are told to be the same thing, and how a title becomes the name of a note.

/** The one folder every mentioned thing has its note in. No subfolders: the links and the details say what a note is. */
export const MENTIONS_FOLDER = "Mentions/";

/** The longest a note's name may be, in characters. A longer title is cut at a word. */
export const NAME_MAX = 100;

/** Characters a link, a path or a tag reads as syntax: they are taken out of a note's name. */
const NAME_TAKEN_OUT = /[/\\:*?"<>|#^[\]\u0000-\u001f\u007f]/g;

/**
 * What two titles are compared by: case, accents, punctuation and a leading "The" are ignored, and "&" is "and".
 * "the atomic habits" and "Atomic Habits." have the same key. A title with nothing to compare has an empty key.
 */
export function titleKey(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['‘’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the (?=\S)/, "");
}

/** `text` cut to at most `max` characters at a word. A first word longer than `max` is cut where it stands. */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  // The character after the cut is a space when the cut falls between two words.
  const lastSpace = cut.lastIndexOf(" ");
  const kept = lastSpace > 0 ? cut.slice(0, lastSpace) : text.slice(0, max);
  return kept.replace(/[\s.,;:\-–—]+$/g, "");
}

/** A title as the name of a note: the characters a link reads as syntax taken out, spaces made one, no space or dot at either end, cut at a word. Empty when nothing is left. */
export function noteName(title: string): string {
  const cleaned = title.replace(/\s+/g, " ").replace(NAME_TAKEN_OUT, "").replace(/ {2,}/g, " ").replace(/^[\s.]+|[\s.]+$/g, "");
  return cutAtWord(cleaned, NAME_MAX).replace(/^[\s.]+|[\s.]+$/g, "");
}

/** The path of the note for a name. */
export const mentionPath = (name: string): string => `${MENTIONS_FOLDER}${name}.md`;

/** The name a Mentions path carries, or null for a path that is not a note straight in the folder. */
export function mentionName(path: string): string | null {
  if (!path.startsWith(MENTIONS_FOLDER) || !path.endsWith(".md")) return null;
  const name = path.slice(MENTIONS_FOLDER.length, -".md".length);
  return name === "" || name.includes("/") ? null : name;
}

/** Words a title written in lower case keeps in lower case when it is given capitals (a web address has no capitals to take its words from). */
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to", "vs"]);

/** The words of a web address's slug as a title: "atomic-habits" is "Atomic Habits". A slug that already has capitals is kept as it is. */
export function titleFromSlug(slug: string): string {
  let text = slug;
  try {
    text = decodeURIComponent(slug);
  } catch {
    // A slug that is not valid percent-encoding is read as it is.
  }
  const words = text.split(/[-_+\s]+/).filter((word) => word !== "");
  if (words.some((word) => /\p{Lu}/u.test(word))) return words.join(" ");
  return words.map((word, at) => (at > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1))).join(" ");
}
