# @nexus/crypto

The encryption every part of Nexus uses: note blobs, the wraps that lock the
vault key, sealed approvals for new devices, and the written Recovery Key.

**Nexus encryption has not yet been independently audited.**

It is plain TypeScript with no input or output of its own: no network, files,
storage or clocks. It uses only JavaScript and WebAssembly features, so one
file runs in a browser, on a phone inside Obsidian, in Node and in a worker. The
one runtime dependency is [libsodium.js](https://github.com/jedisct1/libsodium.js)
(`libsodium-wrappers-sumo`), which supplies every cipher and hash. The platform
must provide `globalThis.crypto.getRandomValues`, which libsodium uses for
random bytes.

The byte layout of everything it writes is in [docs/FORMAT.md](docs/FORMAT.md).
It is written so another implementation can be made from it.

## Use

```ts
import { decryptNote, encryptNote, generateVaultKey } from "@nexus/crypto";

const vaultKey = await generateVaultKey();
const context = { vaultId: "v1", noteId: "n1", kid: 1 };

const blob = await encryptNote(vaultKey, context, { path: "Daily/2026-11-15.md", text: "hello" });
const note = await decryptNote(vaultKey, context, blob); // { path, text }
```

Every refusal is a `NexusCryptoError` with a `code` (see FORMAT.md, "Errors").
Wrong key, wrong ids and damaged data all give `decryption-failed`; the cipher
cannot tell them apart, and nothing is returned.

The rest of the surface:

- `generateRecoveryKey`, `formatRecoveryKey`, `parseRecoveryKey`: the 256-bit
  Recovery Key and its written form with check characters.
- `wrapVaultKeyWithRecoveryKey`, `unwrapVaultKeyWithRecoveryKey`.
- `createPasswordWrap`, `openPasswordWrap`: the optional Argon2id wrap.
- `generateDeviceKeyPair`, `sealApproval`, `openApproval`: one-time approvals
  sealed to a device's or agent's X25519 key.

## Develop

```
npm ci
npm test          # known-answer vectors, cross-check against noble, refusal tests
npm run typecheck
npm run build     # dist/index.js, one ES module with libsodium's WebAssembly inside
```

`@noble/ciphers` and `@noble/hashes` are development dependencies only: the
tests use them as an independent second implementation.
