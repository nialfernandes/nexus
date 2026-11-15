// What goes wrong, in words a person can act on. An AgentError carries a `code` to branch on and a plain message. A message is
// always a fixed sentence (or Nexus's own words, which never repeat what was sent): it never holds a key, a token or a piece of
// either, whatever the call was given.

export type AgentErrorCode =
  | "bad-settings" //  the address, token, private key or approval is missing or is not what it should be
  | "bad-approval" //  the approval could not be opened with this private key
  | "wrong-vault" //   the approval is for another vault than the one the server holds, or the server holds none
  | "wrong-key" //     the approval's key opens none of the vault's notes
  | "unsafe-path" //   the path is not one the plugin would write into a vault
  | "not-found" //     there is no note at that path, or with that id
  | "key-taken" //     `createNote` was given a key whose id another note already has (a different text or path, or deleted, or one that cannot be opened)
  | "unreadable" //    the note could not be opened with this vault's key, or names a path the plugin would refuse
  | "unreachable" //   Nexus could not be reached
  | "refused" //       Nexus answered with a refusal
  | "changed" //       the note kept changing, or changed while it was being deleted
  | "closed"; //       the vault was closed, so its key is gone

export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}
