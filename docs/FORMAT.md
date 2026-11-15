# Nexus encryption format, version 1

This document says exactly which bytes `@nexus/crypto` writes, so that someone
can write a compatible implementation in another language without reading the
TypeScript. If this document and the code disagree, that is a bug in one of
them: please report it.

**Nexus encryption has not yet been independently audited.** This document
describes the design; it is not a statement that the design is safe.

## 1. What is encrypted, and under which keys

| Thing | Made of | Used for |
| --- | --- | --- |
| **Vault key** (VK) | 32 random bytes, one per vault, numbered by a `kid` | Encrypts every note |
| **Recovery Key** (RK) | 32 random bytes, written out for a person to keep | Unlocks the vault key when no device is left |
| **Password** (optional) | text the person chooses | A second way to unlock the vault key |
| **Device key pair** | an X25519 key pair made on a device or agent | Receives the vault key once, when the device is approved |

The package (`packages/crypto`) has no input or output of its own. It never reads a file, opens a
connection, looks at a clock or stores a key; callers pass bytes in and get
bytes out. Random bytes come from libsodium, which in turn uses the platform's
`getRandomValues`.

## 2. Conventions

- All whole numbers are unsigned and written **big-endian**.
- A **length-prefixed string** is its UTF-8 byte count as a 4-byte number, then
  the UTF-8 bytes.
- `||` means "followed by".
- **Version** is the single byte `0x01` in this document. A reader that sees any
  other version refuses the data (`unsupported-version`); it does not guess.
- **Ids** (vault id, note id) are non-empty strings of at most 1024 UTF-8 bytes
  with no unpaired surrogate. Nexus does not look inside them. A `kid` is an
  integer from 0 to 4294967295.

## 3. Primitives

| Name here | Definition | libsodium.js call |
| --- | --- | --- |
| **AEAD** | XChaCha20-Poly1305 as in `draft-irtf-cfrg-xchacha-03`: 32-byte key, 24-byte nonce, 16-byte tag, tag placed after the ciphertext. This is libsodium's `crypto_aead_xchacha20poly1305_ietf` | `crypto_aead_xchacha20poly1305_ietf_encrypt` / `_decrypt` |
| **HKDF** | HKDF-SHA-256, RFC 5869. libsodium.js does not expose its HKDF, so it is the RFC's two steps over libsodium's HMAC-SHA-256 | `crypto_auth_hmacsha256_init` / `_update` / `_final` |
| **Argon2id** | Argon2 version 0x13 (RFC 9106), one lane, no secret, no associated data, 32-byte output, 16-byte salt. Memory is given in KiB below | `crypto_pwhash` with `crypto_pwhash_ALG_ARGON2ID13`; libsodium takes memory in bytes (KiB × 1024) |
| **Sealed box** | libsodium's `crypto_box_seal`: an ephemeral X25519 key, then a box to the receiver's public key; 48 bytes longer than its input | `crypto_box_seal` / `crypto_box_seal_open` |
| **SHA-256** | FIPS 180-4 | `crypto_hash_sha256` |

No other cipher, hash, key derivation or padding scheme is used.

## 4. Associated data

Every AEAD call in this format passes associated data (AD), so a ciphertext only
opens in the place it was made for:

```
AD = version (1) || kind (1) || kid (4) || vaultId (length-prefixed) || subject (length-prefixed)
```

| Kind byte | Meaning | Subject |
| --- | --- | --- |
| `0x01` | note blob | the note id |
| `0x02` | recovery wrap | empty (4 zero bytes) |
| `0x03` | password wrap | empty (4 zero bytes) |
| `0x04` | sealed approval | not used (a sealed box has no AD; the same fields are inside it, see 7.3) |

Because every id carries its length, `vaultId = "ab", noteId = "c"` and
`vaultId = "a", noteId = "bc"` give different AD.

The **password wrap** appends its own header (settings and salt, section 7.2)
to the AD, so none of those bytes can be changed without detection.

## 5. Padding

A note's record is padded before it is encrypted, so that the size of a blob
says little about the size of the note.

1. Take the record bytes (section 6.1), `n` bytes long.
2. Append one end mark byte `0x80`.
3. Append zero bytes until the total length is `padme(max(n + 1, 256))`.

So every record is padded to **at least 256 bytes** before Padmé is applied: a
one-line note and a note of two hundred bytes give blobs of the same size, and
only records of 256 bytes or more show a length, rounded by Padmé.

**Padmé** (Nikitin et al., 2018) for a length `L`:

```
if L < 2: return L
E = floor(log2(L))
S = floor(log2(E)) + 1
mask = 2^(E - S) - 1
return (L + mask) AND (NOT mask)
```

Writers must pad to exactly `padme(max(n + 1, 256))`. Readers remove padding by dropping
all trailing `0x00` bytes and then the one `0x80` before them, and refuse
(`malformed`) data with no `0x80`. A reader does not insist on the exact length,
so a later writer may pad more (for example to a larger minimum) without a new
format version.

## 6. Note blob

```
offset  length  field
0       1       version (0x01)
1       4       kid, the number of the vault key the blob is under
5       24      nonce, random, new for every encryption
29      n + 16  AEAD ciphertext of the padded record, then the 16-byte tag
```

The AD is kind `0x01` with the note's `kid`, vault id and note id. The `kid` is
written in the blob so a blob alone says which key opens it, **and** it is in
the AD. A reader that is told which `kid` it expects compares it with bytes 1 to
4 first and, if they differ, refuses with `wrong-kid` before it tries to
decrypt. Rewriting those bytes cannot make a blob open under another `kid`,
because the AD still holds the real one. The note id and vault id are **not** in
the blob: the server keeps them beside it, and the reader supplies them.
Total length = `1 + 4 + 24 + padme(max(n + 1, 256)) + 16`, so at least 301
bytes for a new blob. The shortest blob a reader can open is 46 bytes (header,
tag and the end mark).

### 6.1 The record

The record is a JSON object written as UTF-8 with no extra white space and the
members in this order: `{"path": <string>, "text": <string>}`, as
`JSON.stringify` writes it (unpaired surrogates are written as `\uXXXX`
escapes). A reader accepts any JSON object with a string `path` and a string
`text`, and ignores other members. `path` is the note's path in the vault.

## 7. Wraps and approvals

### 7.1 Recovery wrap (74 bytes)

```
offset  length  field
0       1       version (0x01)
1       1       kind (0x02)
2       24      nonce, random
26      48      AEAD ciphertext of the 32-byte vault key, then the tag
```

Key: `KEK = HKDF-SHA-256(IKM = RK, salt = empty, info = "nexus v1 recovery", L = 32)`,
where an empty salt means 32 zero bytes, as RFC 5869 says, and `info` is the 17
ASCII bytes of the label. AD: kind `0x02`, with the vault id and the `kid` of the
vault key being wrapped.

### 7.2 Password wrap (102 bytes)

```
offset  length  field
0       1       version (0x01)
1       1       kind (0x03)
2       4       Argon2id memory, in KiB
6       4       Argon2id passes (t)
10      4       Argon2id lanes (p)
14      16      salt, random
30      24      nonce, random
54      48      AEAD ciphertext of the 32-byte vault key, then the tag
```

Key: `Argon2id(password, salt, m, t, p, 32 bytes)`. The password is converted to
bytes by Unicode normalisation form **NFKC**, then UTF-8, so the same typing
gives the same key whatever form a device produces. An empty password, or one
with an unpaired surrogate, is refused.

AD: kind `0x03` with the vault id and `kid` (as in section 4), **followed by
bytes 0 to 29 of the wrap** (version through salt).

Writers in this version use `m = 65536` (64 MiB), `t = 3`, `p = 1`. Because the
wrap comes from the server, a reader accepts only `m` from 65536 to 262144,
`t` from 3 to 12 and `p = 1`, and refuses anything else (`unsupported-parameters`)
**before** it derives a key.

### 7.3 Sealed approval

A device or agent makes its own X25519 key pair. Another device that holds the
vault key seals the vault key to the public key (a sealed box, 32 + 16 bytes
longer than its content). The content is:

```
version (0x01) || kind (0x04) || kid (4) || vaultId (length-prefixed) || vault key (32)
```

A device that already knows its vault passes the vault id it expects, and
refuses an approval for another vault (`wrong-vault`). A new device that does
not know its vault yet passes none, and learns the vault id from the approval.
Either way it learns the `kid` from the content.

A sealed box does **not** say who sealed it: anyone who has the public key,
including a server, can make one. **An approval alone is not authenticated.** A
server that wanted a device to use a vault key of its own could seal one to the
device's public key, and the device would open it without a fault. So a device
that opens an approval must not use the key in it until a person has checked
the matching code (7.4).

### 7.4 The device key code and the matching code

A server sits between the two devices, so there are two things it could do, and
each has a code that stops it.

**Before the approving device seals anything: the device key code.** The new
device sends its public key `N` to the server, and the approving device is given
a key back by the server. A server that gave the approving device a key of its
own would be sent the vault key, sealed to the server, and nothing the new device
did afterwards could take that back. So the new device shows a code for its own
key, and the approving device refuses to seal until a person has typed that code
on it and it is the code of the key it was given:

```
digest = SHA-256( "nexus v1 device key code" || N )
code   = the first 50 bits of digest, as 10 symbols of the alphabet in section 8
```

The label is the 24 ASCII bytes of `nexus v1 device key code`. If the server swapped
`N`, the code of the key the approving device holds is not the code on the new
device's screen. After the approving device has sealed, the matching code below
checks what the new device is handed.

**Before the new device uses the key: the matching code.** The new device and
the approving device each work out the same short code from the same bytes, and
show it. The person compares the two. The new device does not use the vault key
from an approval until the person says the codes match (in Nexus's plugin, by
typing the code the approving device shows).

The new device made a key pair for this approval and sent its public key
(`N`, 32 bytes) when it asked to be approved. The approving device made a key
pair of its own for this approval and sent its public key (`A`, 32 bytes) with
the approval. `S` is the sealed approval, exactly as the approving device made
it, and `kid` is the number of the vault key in it. Then:

```
digest = SHA-256( "nexus v1 approval code" || N || A || kid (4) || SHA-256(S) )
code   = the first 50 bits of digest, as 10 symbols of the alphabet in section 8
```

The label is the 22 ASCII bytes of `nexus v1 approval code`. Both codes are written
in two groups of five symbols joined by a hyphen, for example `ENBRP-QJF17`.
Reading what a person typed is as in section 8: capitals or small letters, a
hyphen, spaces or none, `O` as `0`, `I` or `L` as `1`.

Why this stops a server that makes or swaps an approval:

- The server sits between the two devices. It can change `N` (the new device's
  key as the approving device sees it), `A` (the approving device's key as the
  new device sees it) and `S` (the approval the new device is handed). Any one
  change makes the two devices work out different codes, because each of the
  three is in the hash.
- The `kid` is read by the new device from inside the approval after it opens
  it, and by the approving device from its own key. A different `kid` gives a
  different code. (The vault id and the vault key are not in the hash on their
  own, but `S` carries them, and `S` is in the hash.)
- The server cannot choose the approving device's code. That code depends on
  `S`, and `S` holds a fresh random ephemeral key every time, so the approving
  device's code cannot be known before it seals. To match it, the server has to
  seal approvals of its own until one has the same code at the new device, a
  guess that comes right once in 2^50 tries, inside the minutes the approval
  lasts. Each try is a sealed box, which costs one X25519 operation.
- The code is **not** a secret. The server may see it. It only has to differ
  when the approval differs.

Both devices keep their private keys to themselves. The new device keeps its
private key only until it has opened the approval, and does not store it.

### 7.5 An agent's approval, and the vault id kept beside the wraps

An agent is a device that keeps only its private key. Its approval is the sealed approval of
section 7.3, made by `nexus-agent approve-agent`: the person opens the Recovery wrap with the
Recovery Key and seals the vault key to the agent's public key. The bytes are the same.

The server never sees an agent's approval, so the server cannot make or swap one, and the
matching code of section 7.4 is not used for it: that code exists because a device approval
passes through the server. The person carries an agent's approval from the terminal that made it
to the agent's secrets themself.

**The vault id.** The wraps of section 7.1 and 7.2 are bound to the vault id (section 4), so a
holder of only the Recovery Key needs it to open the Recovery wrap. It is not secret. The server
keeps it once, beside the wraps: it is sent with every wrap (`vaultId`), the first wrap sets it,
a wrap sent with another id is refused, and the wraps are answered with it (`GET /wraps`). A new
device that has only the Recovery Key reads the vault id and the wrap from the server and opens
the wrap with `unwrapVaultKeyWithRecoveryKey`.

### 7.6 A note id made from a key the caller keeps

A note's id is not secret from the server: the server keeps it beside every version. Devices make
it at random (the plugin does). A writer that must make the same note again after an answer was
lost (a transcript writer that sends its notes again) needs an id it can make again from its own
data, and an id such as `episode-123` would tell the server what the note is. So the agent library
(`createNote(path, text, { key })`) makes the id from the writer's `key` and the vault key:

```
IDK = HKDF-SHA-256(IKM = VK, salt = empty, info = "nexus v1 note id key", L = 32)
id  = base64url( the first 16 bytes of HMAC-SHA-256(IDK, the UTF-8 bytes of key) ), with no = padding
```

The label is the 20 ASCII bytes of `nexus v1 note id key`, and an empty salt is 32 zero bytes as in 7.1.
`key` is a string of the kind section 2 calls an id: non-empty, at most 1024 UTF-8 bytes, no
unpaired surrogate (`invalid-argument` otherwise). `base64url` is RFC 4648 section 5. The id is 22
characters of `A-Z a-z 0-9 - _`, as long as a random id, so Nexus takes it as it takes any id.

- The same key gives the same id in the same vault, so the second call finds the first call's note.
- A different key, or a different vault key, gives a different id. Two ids collide as 128-bit
  values do.
- The server holds neither `VK` nor `IDK`. It cannot tell what key an id was made from, and cannot
  test a guess at the key, whatever the key looks like.
- `IDK` is used for nothing else. The vault id is not part of the derivation: two vaults with the same vault key would
  give the same id, and vault keys are random.

## 8. Writing the Recovery Key down

The 32 bytes of RK are written in the 32 symbols
`0123456789ABCDEFGHJKMNPQRSTVWXYZ` (digits and capitals without I, L, O and U;
Crockford's base 32 alphabet, the one Nexus already uses for approval codes),
5 bits per symbol, most significant bit first:

1. 256 bits make **52 symbols**; the last symbol holds the final key bit followed
   by four zero bits.
2. **Check characters:** `digest = SHA-256("nexus v1 recovery check" || RK)`. The
   first 20 bits of `digest` make **4 symbols**, appended after the 52.
3. The 56 symbols are written in **14 groups of 4** joined by `-`.

Reading accepts small letters, hyphens, spaces and line breaks, and reads `O` as
`0` and `I` or `L` as `1`. It refuses (`bad-recovery-key`) any other length or
character, a last key symbol whose four spare bits are not zero, and check
characters that do not match. One wrong symbol is always caught among the check
characters; among the key symbols a wrong symbol slips through with a chance of
about one in a million.

## 9. Errors

Every refusal is a `NexusCryptoError` with a `code`:

| Code | When |
| --- | --- |
| `invalid-argument` | A key, id, kid, password or record is not what the function takes |
| `truncated` | The data is shorter than the smallest valid blob, wrap or approval |
| `unsupported-version` | The first byte is not `0x01` |
| `wrong-kid` | A note blob names a different `kid` than the reader expects (checked before decryption) |
| `malformed` | The length is too long, the kind byte is wrong, the padding has no end mark, or the decrypted record is not a `{path, text}` object |
| `decryption-failed` | A note blob did not authenticate |
| `unwrap-failed` | A wrap or approval did not authenticate |
| `unsupported-parameters` | A password wrap names Argon2id settings outside the accepted range |
| `bad-recovery-key` | A written Recovery Key could not be read (section 8) |
| `wrong-vault` | A sealed approval opened but is for another vault |

**Why one code covers wrong key, wrong ids and damage.** XChaCha20-Poly1305
reports only that the tag did not match. A wrong key, a changed note id, vault
id, a rewritten `kid` that still matches the header, a flipped bit and a cut-off
ending all look the same, so Nexus does not claim to tell them apart. In every case nothing is returned: the cipher
checks the tag before it releases any plaintext, and a failed call gives the
caller no partial text.

## 10. Worked examples

All use these inputs. **They are test values; never use fixed keys or nonces.**

| Name | Value |
| --- | --- |
| vault key | bytes `00 01 02 ... 1f` |
| Recovery Key | bytes `20 21 22 ... 3f` |
| nonce | bytes `40 41 42 ... 57` (24 bytes) |
| salt | bytes `60 61 ... 6f` (16 bytes) |
| password | `correct horse battery staple` |
| vault id, note id, `kid` | `vault-1`, `note-1`, `1` |
| record | `{"path":"Daily/2026-11-15.md","text":"hello"}` (45 bytes; with the end mark 46, which the 256-byte floor raises to `padme(256)` = 256) |

Note blob (301 bytes = 1 + 4 + 24 + 256 + 16; the `kid` is `00000001` after the version byte):

```
0100000001404142434445464748494a4b4c4d4e4f5051525354555657af1b75
11a4885b2cadb0e6d7c3e54aa0a2889be922687eab5f1f90212b2801e4738176
4c6fb0ec7593de9b6e775adaf19b6b7de86f85b49cb6fc08f413b24c545a2bf8
7214b345c88503b0ffdc799ceff6c7062b283d647750a30794c56533252675b7
c9b8e56bb6dda1629a4717c98b9ff313de29ca83e00cbf571222c77b9fdf5147
0ed1ded6b0a0a0f23069a7de50ee2768ff352c5c1d4d2aa1b93ddb0ab139fc04
bc7e42e07e51fdcec36bd73cfe81eacae18ce1f48ee9c2078f1a952a99aafdb4
a3937724fa7b33296dcddd0570c8406b44d2f9a12aa38e4cf7ec3d3ead1f0568
e31a097342d0f62a600b2351762db7ddff84d44d905575c69e440ccab611d58c
25e4543bf16b90c265a965aa8e
```

Recovery wrap (74 bytes):

```
0102404142434445464748494a4b4c4d4e4f50515253545556576b8543b518c8
ccac275ec522b35b7f022a002d3520e1a34decd6e7f43506268ae474daa36ba1
21bd2171400eb138c499
```

Password wrap (102 bytes; `00010000` = 65536 KiB, `00000003` = 3 passes, `00000001` = 1 lane):

```
0103000100000000000300000001606162636465666768696a6b6c6d6e6f4041
42434445464748494a4b4c4d4e4f5051525354555657aabf5c2ca8ef548a032d
84583b467a725f7ea0806abae90239ab5a435b4058049f3b818e5a531fd65857
7e560d8eeb0f
```

A note id made from a key (section 7.6): the vault key is `VK` = bytes `00 01 ... 1f` and the key is `episode-123`.
`IDK` = `c875fbaa126ee4a10e7f123500f989a93e62a28407652b4be3de216c2e8d92cf`, the first 16 bytes of the
HMAC are `1d7843795da6a287d651b4c6e0aabddf`, and the id is `HXhDeV2moofWUbTG4Kq93w`.

The Recovery Key as written: `40GJ-48S4-4MK2-EA19-58NJ-RB9E-5WR3-2CHK-6GTK-CDSR-74X3-PF1X-7RZG-2M48`

The device key code (section 7.4) of `N` = bytes `10 11 ... 2f`: `3X1TB-8BMC4`.

The matching code (section 7.4) from `N` = bytes `10 11 ... 2f`, `A` = bytes
`50 51 ... 6f`, `kid` = 1 and `S` = 91 bytes `90 91 ... ea`. The hash does not look inside `S`, so
these bytes need not be a real sealed approval: `ENBRP-QJF17`.

An implementation is correct if it makes these exact bytes from these inputs and
opens them again. `packages/crypto/tests/noble-cross-check.test.ts` builds all three a second
way, with `@noble/ciphers` and `@noble/hashes` written from this document, and
checks that the bytes are the same.

## 11. Checks the package runs

- **XChaCha20-Poly1305:** the vector in `draft-irtf-cfrg-xchacha-03`, appendix
  A.3.1, through libsodium.
- **HKDF-SHA-256:** RFC 5869 test cases 1 and 3, through libsodium's HMAC.
- **Argon2id:** the RFC 9106 section 5.3 vector (four lanes, a secret and
  associated data) **cannot be run through libsodium**, whose `crypto_pwhash`
  does one lane with neither. It is run through `@noble/hashes`, and libsodium is
  then checked against `@noble/hashes` at the settings Nexus uses (64 MiB,
  3 passes, 1 lane). That shows the second library agrees with the RFC and
  libsodium agrees with the second library; it does not show libsodium passing
  the RFC vector itself.
- **Both ways:** every note blob and wrap is opened by the second library, and
  every one the second library writes is opened here.
- **Refusals:** a flipped bit anywhere, a wrong note id, vault id, `kid`, key,
  Recovery Key or password, a blob naming another `kid`, a truncated or
  lengthened blob, a wrong version or kind, and out-of-range password settings,
  each with the named error above.
- **Padding:** a record of any length up to 255 bytes gives a blob of one size.
- The sealed approval has no second implementation in the tests (libsodium's
  sealed box is the one implementation); it has round-trip and refusal tests.
- **The note id made from a key:** built a second way with `@noble/hashes`, written from section 7.6, and pinned by the worked
  example in section 10. The same key gives the same id; another key or another vault key each give another id;
  a key that is empty, too long or holds an unpaired surrogate is refused.
- **The device key code and the matching code:** each code is built a second way with `@noble/hashes`, written from
  section 7.4, and each is pinned by the worked examples in section 10. A swapped
  approval, a changed key on either side, a changed `kid` and any one changed byte of
  the approval each give a different code.

## 12. What this format does not do

- It does not hide that a note exists, when it changed, or roughly how big it
  is; Padmé blurs the size, nothing hides the rest.
- It does not rotate keys, re-encrypt notes, or store anything. Those belong to
  the callers.
- It does not authenticate who sealed an approval. The matching code (7.4) does that, once a person has compared it; this package only works it out.

## 13. Changing the format

Any change to a byte layout, a label, the associated data or a limit above
needs a new version byte. A version-1 reader refuses other versions, so old and
new data can sit side by side while a vault is moved across.
