// Which paths an agent may read and write: the same rule the plugin applies to a path it is handed from another device
// (plugin/src/notes.ts `isSafeNotePath`), so a note the agent writes is a note the plugin will take, and the agent never
// acts on a path the plugin would refuse. tests/paths.test.ts holds the two to the same answers.

/** True for the sibling note that keeps a clashing text: `<name> (clash <device> <date>).md`, which the plugin never syncs. */
export const isClashCopy = (path: string): boolean => / \(clash .+ \d{4}-\d{2}-\d{2}(?: \d+)?\)\.md$/i.test(path);

/** True for a markdown file that is not inside a hidden folder and is not a clash copy. */
export function isNote(path: string): boolean {
  if (!/\.md$/i.test(path) || isClashCopy(path)) return false;
  return !path.split("/").some((step) => step.startsWith("."));
}

/**
 * True for a note path that is safe to write into a vault: a note (see isNote) whose steps are all plain names. One that starts
 * at the root, climbs out with `..`, holds an empty step or a backslash or a control character is refused.
 */
export function isSafeNotePath(path: string): boolean {
  if (typeof path !== "string" || !isNote(path) || path.startsWith("/") || /[\\\u0000-\u001f]/.test(path)) return false;
  return path.split("/").every((step) => step !== "" && step !== "." && step !== "..");
}

/** The device's name with every character a file name cannot hold (or a link cannot carry) turned into a dash. */
const fileSafe = (text: string): string => text.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, "-").trim();

/** The day as a person writes it in a file name: 2026-11-14, in the clock's own time zone. */
function dayStamp(when: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}`;
}

/**
 * The path a text is kept at when it could not be merged into a note that changed under it: `Ideas/a (duplicate agent 2026-11-14).md`,
 * in the note's own folder, the name the plugin gives a duplicate. It is an ordinary note, so every device gets it. A count is added
 * when the name is taken.
 */
export function duplicateNotePath(notePath: string, name: string, when: Date, taken: (path: string) => boolean): string {
  const stem = notePath.replace(/\.md$/i, "");
  const label = `${fileSafe(name) || "agent"} ${dayStamp(when)}`;
  let path = `${stem} (duplicate ${label}).md`;
  for (let count = 2; taken(path); count++) path = `${stem} (duplicate ${label} ${count}).md`;
  return path;
}
