// The tests type-check the server's own source (real-nexus.ts imports it), with this folder's compiler settings, which are not
// the server's. The server's secrets plug (server/src/plugs/cloudflare/secrets.ts) hands a `Uint8Array` of any buffer kind to
// `crypto.subtle.digest`. The Workers types the server is built with take that. The DOM types this folder is built with take
// only a view on a plain `ArrayBuffer`, and refuse it, though at run time Node and the browser take it all the same.
//
// This adds the looser overload to the type so the server's file checks here without being touched. It changes no behaviour.
// Once the server's line is written so both type sets take it, this file can go.

interface SubtleCrypto {
  digest(algorithm: AlgorithmIdentifier, data: ArrayBufferView): Promise<ArrayBuffer>;
}
