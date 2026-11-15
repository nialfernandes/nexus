// Who is calling. A caller is an identity's name, and whether it is the owner. There are no folder rights: a note's
// folder is inside the encrypted note, which the server cannot read, so an identity can use every note or none. What
// one identity may not do is manage: only the owner makes identities, lists and revokes tokens, and changes the wraps.

export interface Caller {
  /** The identity's name. */
  name: string;
  /** True for the one identity the host's settings name as the owner. */
  owner: boolean;
  /**
   * Who is kept as the writer of every version and wrap this caller saves: the device. A bearer token is one device's
   * sign-in, so its writer is `device:<the token's id>`, the id the owner sees in the list of tokens and can revoke by.
   * The owner's own browser session is not a token, so its writer is the identity's name. An identity's name has no
   * colon, so no name can pass for a device.
   */
  writer: string;
}

/** The writer a token's calls are kept under. */
export const deviceWriter = (tokenId: string): string => `device:${tokenId}`;

export const ownerCaller = (name: string, writer: string = name): Caller => ({ name, owner: true, writer });
