// What counts as a note, how a note's text is told apart from another, and what a clash copy is called.

/** True for the sibling note that keeps a clashing text: `<name> (clash <device> <date>).md`, with a count after the date when the name was taken. */
export const isClashCopy = (path: string): boolean => / \(clash .+ \d{4}-\d{2}-\d{2}(?: \d+)?\)\.md$/i.test(path);

/**
 * True for a note the plugin syncs: a markdown file that is not inside a hidden folder (`.obsidian`, where the plugin's own
 * settings live, `.trash` and the like) and is not a clash copy. A clash copy stays in the vault it was made in: it is
 * never read, sent or tracked, until the person renames it to something else.
 */
export function isNote(path: string): boolean {
  if (!/\.md$/i.test(path) || isClashCopy(path)) return false;
  return !path.split("/").some((step) => step.startsWith("."));
}

/**
 * A short fingerprint of a text. It tells "the same text as last time" from "edited since", so two different texts
 * must not share one in practice. It is not a security hash and nothing relies on it as one.
 */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ unit, 2654435761);
    h2 = Math.imul(h2 ^ unit, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${text.length.toString(36)}-${hex(h2)}${hex(h1)}`;
}

/** The last step of a path: the file's own name. */
export const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The device's name with every character a file name cannot hold (or a link cannot carry) turned into a dash. */
const fileSafe = (text: string): string => text.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, "-").trim();

/** The day as a person writes it in a file name: 2026-11-14, in the clock's own time zone. */
export function dayStamp(when: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}`;
}

/**
 * The name of the sibling note that keeps a clashing text: `Ideas/a (clash My iPhone 2026-11-14).md`, in the
 * note's own folder. When that name is taken (a second clash the same day) a count is added inside the brackets, so
 * an earlier copy is never written over.
 */
export function clashCopyName(notePath: string, device: string, when: Date, taken: (path: string) => boolean): string {
  const stem = notePath.replace(/\.md$/i, "");
  const label = `${fileSafe(device) || "device"} ${dayStamp(when)}`;
  let name = `${stem} (clash ${label}).md`;
  for (let count = 2; taken(name); count++) name = `${stem} (clash ${label} ${count}).md`;
  return name;
}
