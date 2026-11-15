// Base64 with no Node module: a Worker has no `Buffer`. Nexus writes and reads standard base64 with its `=` padding.

/** Big enough to be quick, small enough for `String.fromCharCode` to take as arguments. */
const CHUNK = 0x8000;

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  return btoa(binary);
}

/** The bytes, or null when the text is not standard base64 with its padding. */
export function decodeBase64(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
    return bytes;
  } catch {
    return null;
  }
}

/** Url-safe base64 without padding: what a note's id is written in, so it is also safe in an address. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
