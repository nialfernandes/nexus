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

The byte layout of everything it writes is in
[docs/FORMAT.md](../../docs/FORMAT.md) at the repository root. It is written so
another implementation can be made from it.

## Use

```ts
import { decryptNote, encryptNote, generateVaultKey } from "@nexus/crypto";

const vaultKey = await generateVaultKey();
const context = { vaultId: "v1", noteId: "n1", kid: 1 };

const blob = await encryptNote(vaultKey, context, { path: "Daily/2026-11-15.md", text: "hello" });
const note = await decryptNote(vaultKey, context, blob); // { path, text }
```

Every refusal is a `NexusCryptoError` with a `code` (see docs/FORMAT.md, "Errors").
A blob under another `kid` than expected gives `wrong-kid`. Wrong key, wrong
note id or vault id, and damaged data all give `decryption-failed`; the cipher
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
npm ci            # at the repository root: this package is one workspace of it
npm test --workspace @nexus/crypto          # known-answer vectors, cross-check against noble, refusal tests
npm run typecheck --workspace @nexus/crypto
npm run build --workspace @nexus/crypto     # dist/index.js, one ES module with libsodium's WebAssembly inside
```

A part of Nexus that only reads the first bytes of a blob and never opens one (the server) takes the layout's numbers
from `@nexus/crypto/format` (`src/format.ts`) instead of the built file: the version byte, the kind bytes and the sizes,
with no encryption and no libsodium.

`@noble/ciphers` and `@noble/hashes` are development dependencies only: the
tests use them as an independent second implementation.
