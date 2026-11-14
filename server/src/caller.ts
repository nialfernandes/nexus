// Who is calling. A caller is an identity's name, and whether it is the owner. There are no folder rights: a note's
// folder is inside the encrypted note, which the server cannot read, so an identity can use every note or none. What
// one identity may not do is manage: only the owner makes identities, lists and revokes tokens, and changes the wraps.

export interface Caller {
  /** The identity's name. It is also the writer kept on every version the caller saves. */
  name: string;
  /** True for the one identity the host's settings name as the owner. */
  owner: boolean;
}

export const ownerCaller = (name: string): Caller => ({ name, owner: true });
