// Folder rights: what an identity may read and write, and the one rule that decides it.
//
// An identity holds a list of rights. Each is a folder prefix written as the notes' own paths are (with its closing
// slash, so `Podcasts/Transcripts/`; the empty prefix is the whole vault) and an access: `read`, `write` (which
// includes read) or `none`. For a note, the right with the LONGEST prefix that the note's path starts with decides.
// A note no right reaches is not allowed at all. `none` is what lets "everything except Private/" be written as
// { "" write } and { "Private/" none }.
//
// The owner (the identity named by the `owner` setting, ports.ts) is never held to a list: it may write everywhere,
// whatever any row says.

import { vaultPath } from "./paths";
import { Refusal } from "./refusal";

export type Access = "read" | "write" | "none";

export interface FolderRight {
  path: string;
  access: Access;
}

/**
 * Who is calling, and what they may touch. `name` is also the writer kept on every version they save. `owner` is
 * true for the one identity the host's settings name as the owner, which holds write on everything, always.
 */
export interface Caller {
  name: string;
  rights: readonly FolderRight[];
  owner: boolean;
}

export const ACCESSES: readonly Access[] = ["read", "write", "none"];

/** The most rights one identity can be given: a list longer than this is a mistake, not a vault layout. */
export const MAX_RIGHTS = 100;

/** The owner as a caller: write on every path, with no list to narrow. */
export const ownerCaller = (name: string): Caller => ({ name, rights: [{ path: "", access: "write" }], owner: true });

/** What the caller may do with a path: the access of the longest matching prefix, `none` when nothing reaches it. */
export function accessAt(caller: Caller, path: string): Access {
  if (caller.owner) return "write";
  let best: FolderRight | null = null;
  for (const right of caller.rights) {
    if (path.startsWith(right.path) && (best === null || right.path.length > best.path.length)) best = right;
  }
  return best === null ? "none" : best.access;
}

export const mayRead = (caller: Caller, path: string): boolean => accessAt(caller, path) !== "none";
export const mayWrite = (caller: Caller, path: string): boolean => accessAt(caller, path) === "write";

/** Stops a read the caller may not make. The refusal names the path, whether or not a note is there. */
export function requireRead(caller: Caller, path: string): void {
  if (!mayRead(caller, path)) throw new Refusal(403, `${caller.name} may not read ${path}.`);
}

/** Stops a write the caller may not make. The refusal names the path, whether or not a note is there. */
export function requireWrite(caller: Caller, path: string): void {
  if (!mayWrite(caller, path)) throw new Refusal(403, `${caller.name} may not write ${path}.`);
}

/** A list of rights as a caller sends it, checked: each path a folder (or the whole vault), each access known. */
export function parseRights(value: unknown): FolderRight[] {
  if (!Array.isArray(value)) throw new Refusal(400, "The rights have to be a list of { path, access } entries.");
  if (value.length > MAX_RIGHTS) throw new Refusal(400, `An identity can hold at most ${MAX_RIGHTS} rights.`);
  const seen = new Set<string>();
  return value.map((entry): FolderRight => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Refusal(400, "Each right has to be an object with a path and an access.");
    }
    const { path, access } = entry as Record<string, unknown>;
    if (typeof path !== "string") throw new Refusal(400, "A right's path has to be text: a folder such as Ideas/, or an empty path for the whole vault.");
    if (path !== "") {
      if (!path.endsWith("/")) throw new Refusal(400, `The right's path ${path} has to be a folder ending in a slash, such as Ideas/.`);
      vaultPath(path.slice(0, -1), "right's folder");
    }
    if (typeof access !== "string" || !(ACCESSES as readonly string[]).includes(access)) {
      throw new Refusal(400, `The access for ${path === "" ? "the whole vault" : path} has to be read, write or none.`);
    }
    if (seen.has(path)) throw new Refusal(400, `The list has ${path === "" ? "the whole vault" : path} twice.`);
    seen.add(path);
    return { path, access: access as Access };
  });
}
