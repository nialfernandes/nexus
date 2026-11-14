// The fingerprint kept with every version of a note: SHA-256 of the encrypted blob, as 64 lower case hex characters.
// It is there for integrity: a device that reads a blob can check it is the one that was stored, and a damaged row
// shows. It says nothing about the note's text, which the server never sees. (It used to be a short hash of the text.)
// The host does the hashing (ports.ts), so the logic asks the machine for nothing.

import type { Secrets } from "./ports";

export const blobHash = (secrets: Secrets, blob: Uint8Array): Promise<string> => secrets.hashBytes(blob);
