// A note's path is its identity: any folder depth, any text, kept exactly as written (case included). The only
// paths refused are ones that leave the vault or cannot be kept: an absolute path, a `.` or `..` step anywhere, an
// empty step (`a//b`, a trailing slash), a backslash, a control character or a half of an emoji. A `..` inside a
// name (`v1..v2 notes.md`) is a name, not a step.

import { Refusal } from "./refusal";

const MAX_PATH_BYTES = 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when the text can be written as UTF-8 without losing anything. */
export const isWholeText = (text: string): boolean => !LONE_SURROGATE.test(text);

/** The path as given, or a refusal that says why it is not a path in the vault. */
export function vaultPath(value: unknown, what = "path"): string {
  if (typeof value !== "string" || value === "") throw new Refusal(400, `A ${what} is needed, such as Ideas/Podcast names.md.`);
  if (value.startsWith("/")) throw new Refusal(400, `The ${what} has to be inside the vault, so it cannot start with a slash.`);
  if (CONTROL.test(value) || value.includes("\\") || !isWholeText(value)) {
    throw new Refusal(400, `The ${what} holds a character a note's path cannot hold.`);
  }
  if (new TextEncoder().encode(value).length > MAX_PATH_BYTES) throw new Refusal(400, `The ${what} is too long.`);
  for (const step of value.split("/")) {
    if (step === "") throw new Refusal(400, `The ${what} has an empty folder or file name in it.`);
    if (step === "." || step === "..") throw new Refusal(400, `The ${what} has to stay inside the vault, so it cannot hold . or .. as a step.`);
  }
  return value;
}

/** A folder: a path with one trailing slash allowed. Nothing or "" is the whole vault. */
export function vaultFolder(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Refusal(400, "The folder has to be text.");
  return vaultPath(value.endsWith("/") ? value.slice(0, -1) : value, "folder");
}
