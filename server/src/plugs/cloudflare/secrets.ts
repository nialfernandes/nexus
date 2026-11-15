// The secrets plug: random bytes and SHA-256 from the Workers runtime's Web Crypto. Like the rest of this folder it
// is the only Nexus code that reaches for the machine, so the logic stays portable.

import type { Secrets } from "../../ports";

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const workerSecrets: Secrets = {
  random(count) {
    const bytes = new Uint8Array(count);
    crypto.getRandomValues(bytes);
    return bytes;
  },
  async hash(text) {
    return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
  },
  async hashBytes(bytes) {
    // `slice` copies into a plain ArrayBuffer, the one kind of buffer the Workers types and the DOM types both let `digest` take.
    return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())));
  },
};
