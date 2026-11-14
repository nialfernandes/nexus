# Nexus threat model

**Status: not yet audited.** This document describes the design of Nexus
version 1: who it defends against, what the server can and cannot see, and what
it does not try to defend against. No outside security firm has reviewed the
design or the code. Until one has, treat every statement here as a goal that
the code is trying to meet, not as something anyone has proved. Do not rely on
Nexus for anything you cannot afford to lose. The encrypted server is not built
yet: the server in this repository today stores notes as plain text, and whoever
runs it can read them.

The exact byte layout of the encrypted data is in [FORMAT.md](FORMAT.md). This
document says what that format is for.

**How to read the sources.** A tag like [S39] points to the numbered list of
sources in the appendix at the end, where each entry has a link. The numbers are
kept from the research this document was written from, so some numbers are
missing: those sources are not cited here. Where a claim rests on a summary of a
page and not on the page itself, the appendix says so. Statements with no tag
are the design itself, or this document's own reasoning, and the text says which
when it matters.

## 1. Can the server operator read my notes?

**Today, yes.** The server in this repository stores notes as plain text, and
whoever runs it can read them. The encrypted server is not built yet. The answer
below, **No**, is what the design gives once the encrypted server lands, and it
is not true of anything you can run now.

**Once the encrypted server lands: No.** Each note is scrambled (encrypted) on
your device with a key that stays on your devices, before it is sent anywhere.
The server stores the scrambled result. The key never reaches the server in a form the server can use. Whoever
runs your server, whether that is a hosting company, a stranger or you, holds
scrambled blobs and a few labels, and cannot turn them back into notes.

There is one exception, and you have to switch it on yourself: **cloud
assistants**. A commercial AI assistant cannot hold a key of its own. If you
choose to let one read your notes, you approve it for a limited time, and while
it is connected the server holds your key in memory so it can unscramble notes
for that assistant. During that time the server's operator could read your notes
too, and so can the assistant's company. Section 3.6 explains the limits we put
around this. If you never approve a cloud assistant, this exception never
applies to you.

**What the operator does see** (with the encrypted server; today it sees the
notes too):

- That your vault exists, how many notes it has, and how many versions each has.
- A random id for each note.
- When each version was saved, and the order of the versions.
- Which of your devices or agents saved each version.
- The size of each blob, rounded up (section 2).
- That a version is a deletion.
- Network details such as your IP address, as with any server.

**What the operator does not see, once the encrypted server lands:** the text of your notes, their names, the
folders they are in, links, tags, or anything else inside the text.

**What the operator can still do,** even though it cannot read: it can refuse to
hand notes back, delete everything it stores, or serve you an older version of a
note as if it were the newest. The design makes some of this detectable and none
of it impossible (section 3.2). Keep a copy of your vault somewhere you control.

**Nobody can recover your notes for you.** There is no password reset and no
support desk that can unlock a vault, because the server has nothing to unlock
it with. If you lose every device and your Recovery Key, the notes are gone. That
is a deliberate choice, not a bug.

## 2. What the server sees, in detail

Encryption hides what notes say. It does not hide that notes exist, roughly how
big they are, or when they changed, because the server has to store and route
them. Note names and folders can be hidden, and Nexus hides them. Other products
that hide names include Obsidian Sync, Proton Drive and Self-hosted LiveSync
[S1][S25][S64].

| Visible to the server | Hidden from the server |
| --- | --- |
| That a vault has N notes and how many versions each has | Note text |
| A random note id for each note | Note names and folder paths |
| When each version was saved, and the order of versions (the changes feed needs this) | Links, tags and anything else inside the text |
| Which device or agent wrote each version | The folder structure |
| The size of each blob, rounded up | What a locked-mode agent read (the server only sees it fetch blobs) |
| Whether a version is a deletion | |
| IP addresses, as always | |

**Size.** An encrypted note is the length of its text plus a few bytes, so size
alone says something about a note. Before encrypting, Nexus pads each blob up to
a rounded size using a scheme called Padmé. The authors of that scheme show it
limits what size reveals to a very small amount for a file of any size, at a cost
of at most about 12% extra bytes, falling as files get larger [S77]. Notes are
small, so the cost is tiny.

Every record (the note's name and text, before encryption) is first padded to at
least 256 bytes, and Padmé is applied after that ([FORMAT.md](FORMAT.md), section
5). So a record under 256 bytes, such as a short note with its name, shows no
length at all: every such note gives a blob of the same size. Only records of 256
bytes or more show a length, and then only the rounded one.

**What other products leave visible,** for comparison. Cryptomator leaves
timestamps, the number of files and file sizes visible [S65]. Obsidian Sync
leaves visible when something was uploaded and which path goes with which content
[S1]. Self-hosted LiveSync leaves document ids, revision information and
ciphertext lengths visible, according to a search summary of a third-party
reimplementation and not a primary page [S64].

**What hiding names costs.** The server used to do several jobs by reading notes.
It cannot do them now, so the devices do them instead:

| Job | Where it happens now |
| --- | --- |
| Merging two edits of the same note | The device. A save must name the version it started from. If that is no longer the latest, the server says "moved on" and stores nothing; the device fetches the latest, merges locally and saves again. A clash keeps both texts, encrypted |
| Folder permissions by path | Dropped in version 1. A person's key opens all of their notes or none, so an agent or device gets exactly what its person sees. Folder-limited agents would need a separate key per folder and are a later change |
| Listing by folder, and search | The device, from an index it builds from notes it has decrypted |
| Moving a note | A new version of the same note with a new encrypted path inside. The device checks whether the target path is taken |
| Fingerprinting the text | Dropped. A hash of the plain text held by the server is a known weakness: an audit of Obsidian Sync found that one (finding TOB-OBSYNC-9) [S3]. Nexus keeps a SHA-256 of the encrypted blob, for integrity only |

## 3. The attackers

For each attacker: what they can learn, what they can do, and what stops them.

### 3.1 A stolen server database

Someone gets a full copy of everything the server stores, at one moment.

- **Learns:** everything in the left column of section 2. No text, names or paths.
- **Cannot:** read notes, and cannot guess a password to get at them, because the
  server holds no key derived from a password. The Recovery wrap that the server
  stores is locked with 256 random bits, which cannot be guessed. A password wrap
  exists only if you turn it on (section 4). Signal's backups also avoid
  any password-derived key [S18].
- **Quantum computers:** stored notes and the Recovery wrap use 256-bit symmetric
  keys, which a future quantum computer barely weakens [S71]. The server never
  stores a long-lived copy of your key locked by the kind of cryptography a
  quantum computer would break. The one-time approvals that do use it are deleted
  once collected and expire within minutes.

### 3.2 A hostile or compromised server operator

This covers a curious host that looks at everything, a hacked server, and an
operator who changes answers on purpose. They have a copy of everything and can
lie in any response.

- **Learns:** what a stolen database gives (3.1), plus live timing and traffic
  patterns.
- **Cannot read notes.** It also cannot alter a blob without detection, because
  the encryption is authenticated: a changed byte fails to decrypt.
- **Cannot move a blob to a different note or name.** The note id and key number
  are part of what the encryption checks, and the name is inside the encrypted
  part. Obsidian Sync had a finding about names and content not being tied
  together (TOB-OBSYNC-10) [S3]; Standard Notes ties the item id in [S28].
- **Cannot answer for recovery or start it,** because the server has no recovery
  feature (section 5).
- **Cannot slip its own public key into a device approval,** because the new
  device and the approving device both show a short code you compare [S10].
- **Can withhold notes, delete the whole store, or roll back,** meaning serve an
  older version of a note. An authenticated cipher shows a blob is genuine, not
  that it is the latest. Cryptomator describes the same class of limit: a hostile
  store could swap encrypted names within a folder while contents stay safe [S65].
  Two defences are planned for later: a hash chain, where each version's checked
  data includes the hash of the previous version so a device notices if history
  was edited, and each device remembering the highest version it has seen.
  Neither stops withholding.
- **Web page limit (this document's own reasoning, not from a source).** If you
  use a web page to read notes, the server delivers the code that runs in your
  browser. A hostile server could deliver code that steals your key. The
  protection in this section is therefore strongest for the Obsidian plugin and
  for agents, where the code is installed separately from the server, and weakest
  for a web page served by the same host.

### 3.3 A network attacker

Someone who can watch or interfere with traffic between a device and the server.

- **Learns:** what the operator learns (section 2): addresses, timing, rounded
  sizes. Notes are encrypted before they enter the connection, so breaking or
  removing the connection's own protection (TLS) does not reveal them.
- **Can:** block or delay traffic. That is a loss of availability, not of secrecy.
- **Recording now to read later:** a quantum computer could break the kind of
  key agreement used when two devices agree a secret across the internet [S71],
  and we use that kind in the one-time handover of the vault key to a new device
  or agent, which travels inside TLS. In principle an attacker who recorded that
  handover and later broke both layers could read the key sent in it. We accept
  this for version 1, because we found no JavaScript library for the post-quantum
  replacement with an independent audit; the leading one is self-audited only
  [S46]. The format carries a version byte
  and a named key-wrap type, so a post-quantum hybrid can be added later as a new
  wrap type [S5].

### 3.4 A lost or stolen device

- **Locked, with disk encryption:** where you use the Obsidian plugin, the key is
  held in Obsidian's local secret storage, which its own guide describes as local
  storage and does not promise is encrypted on disk [S63]. Another way in keeps
  the key wherever that app keeps secrets, and this document does not vouch for
  that place. The real defence is the device's own lock screen and disk encryption, which Nexus cannot
  add.
- **Unlocked, or taken over by malware:** it can read whatever you can. Out of
  scope (section 4).
- **What you do:** revoke the device. Deleting its sign-in token stops it reading
  or writing from now on. It does not make the device forget what it already
  holds. To cut a lost device off completely, rotate the vault key: new saves use
  a new key, the server refuses a save made under an older key number, and old
  versions are re-encrypted in the background. The refusal matters because
  Bitwarden warns that saving with a stale key corrupts data [S11]. Bitwarden documents the
  same limit for a revoked token [S12]. Standard Notes re-encrypts gradually
  after a key change, per a search summary of its specification [S31].
- **A limit of rotation:** until re-encryption finishes, old versions are still
  under the old key. Someone holding both the old key (from the lost device) and
  a copy of the old blobs (for example from 3.1) can read those versions.
  Rotation protects future saves and, once finished, the server's current copy; it
  cannot unscramble copies already taken.

### 3.5 A malicious plugin or agent

- **An agent you run** holds your vault key (or a key of its own that your device
  approved), so it can read and write everything you can. A compromised agent
  therefore means a compromised vault, for as long as it holds the key. Each agent
  is a device with its own keypair and its own sign-in token, so you can revoke it
  alone. A token issued to one machine and shown once is the same pattern
  Bitwarden Secrets Manager uses [S12]. After a compromise, revoke it and rotate
  the key (3.4). In version 1 you cannot limit an agent to one folder (section 2).
- **Another Obsidian plugin** runs with the same access as the Nexus plugin, in
  the same app, and can read vault files and the locally stored key [S63]. This
  part is this document's own reasoning. Install only plugins you trust.

### 3.6 A cloud assistant given a grant

A cloud assistant cannot hold a key, so for it to read a note something must
unscramble the note on its behalf while it is connected. That something is the
Nexus server. The design keeps the step small and short, and says so plainly.
The plan below is assembled from published parts, not a published scheme, and it
is what an outside audit most needs to test.

1. **The server makes a fresh keypair each time it starts** and keeps the private
   half in memory, never on disk. A restart ends every grant. Apple's private
   cloud service takes a similar stance, keeping user data only for the length of
   the request [S66].
2. **You approve one assistant** on a device, which says in plain words which
   assistant, for how long (you set a maximum, such as one hour) and what it can
   read (the whole vault in version 1). Your device seals your vault key to the
   server's current public key, with the assistant's id and the expiry bound in
   [S48].
3. **The server keeps the grant in memory only.** It unscrambles notes for that
   assistant's own token while the grant lasts, and refuses afterwards.
4. **Every read is logged for you:** which assistant, when, and which note id.
   Your device decrypts the names when it shows you the log, because the server
   cannot.
5. **You can cut the assistant off at any moment.** The server deletes the grant
   and the cut-off is immediate on that server, because the key was held nowhere
   else. By comparison a revoked Bitwarden Secrets Manager token can keep working
   for up to an hour [S12].
6. **Nothing is kept at rest:** no plain text is stored, logged or cached.

**What this does not do:**

- It does not protect your notes from the operator while a grant is live. Anyone
  who can run the server process or read its memory can read the key.
- The expiry is only as strong as the server's own code. A hostile server can
  ignore it. Only hardware attestation could check that, as below.
- The assistant's company sees the text it is given. Nothing in Nexus can stop it.

**Stronger options exist, and Nexus does not require them.** A confidential
computing enclave can keep memory unreadable by the host and prove what code it
runs. Apple's private cloud service is the best published example and is not
something others can buy or copy [S66]. AWS Nitro Enclaves offer isolation and an
attestation that a key service can require, but tie you to one cloud [S68], and
Nexus is meant to run on any host. Confidential virtual machines from other clouds
have been read with a physical memory interposer built for under US$1,000,
which vendors treat as out of scope [S67]. Nexus
treats an attested enclave as an optional place to run the server, for people who
need it.

## 4. What is out of scope

These are not defended against. They are stated so you do not assume otherwise.

- **A device taken over while unlocked,** by malware or by someone holding it: it
  can read what you can.
- **A hostile server withholding, deleting or rolling back notes.** Planned
  detection (3.2) will not make it impossible.
- **Metadata beyond what section 2 lists:** your IP address, the timing of saves,
  how many notes and versions exist, which device wrote, that a version is a
  deletion, and what a watcher can infer from traffic patterns.
- **A weak password, where you turned on the optional password wrap.** The server
  then stores a copy of the vault key locked by your password. A stolen database
  lets an attacker guess passwords offline, slowed down only by the Argon2id
  settings [S34]. The strongest setup uses no password at all: a Recovery Key you
  store yourself plus approving each new device from one you already have.
- **A lost key.** Lose all devices and the Recovery Key and the vault is gone.
- **What an assistant company does with text it is given** (3.6).
- **The web page's delivered code and other plugins on your device** (3.2, 3.5).
- **Mistakes in our own code or the libraries we use.** That is what testing and
  an outside audit are for, and neither is finished (section 7). If you find
  such a mistake, please report it privately, as [SECURITY.md](../SECURITY.md)
  describes, and not in a public issue.

## 5. What the design uses

This is a summary so that the rules in section 6 have something to refer to.
[FORMAT.md](FORMAT.md) is the specification.

- **One random vault key per person,** 256 bits, with a number (`kid`) that goes
  up when it is rotated. This is the same overall shape as Standard Notes and
  Bitwarden: one random key encrypts the data and is itself locked up in several
  ways [S28][S7].
- **Cipher for notes:** XChaCha20-Poly1305 through libsodium, a 256-bit key and a
  fresh random 24-byte value used once per save [S39][S48]. Its 24-byte value is
  long enough that choosing it at random is safe without any counter shared
  between devices [S39]. The checked-but-not-hidden data is the format version,
  vault id, note id and `kid`. The note's name and folder are inside the encrypted
  part with the text.
- **Recovery wrap (always present):** the vault key locked under a key derived
  with HKDF-SHA-256 from a 256-bit random Recovery Key made on your device and
  shown only to you. Signal's backups follow the same pattern [S18][S19].
- **Password wrap (optional):** Argon2id at 64 MiB of memory, 3 passes, 1 lane,
  with a random salt, settings stored beside the wrap [S34][S33][S42].
- **A new device or agent** gets the key by a one-time approval from a device you
  already hold, sealed to the new device's own public key, with the matching
  short code shown on both screens [S10].
- **The server holds** note blobs, ids, version numbers, key numbers, timestamps,
  writer ids and the wrapped keys. It keeps the sign-in tokens, device approval,
  changes feed, history and the check that stops two saves overwriting each
  other.

### Platform notes

- **Lockdown Mode (Apple devices) turns WebAssembly off, and libsodium.js does not
  load without it.** libsodium.js is meant to fall back to JavaScript [S48], but
  in our probe's test with WebAssembly removed, libsodium did not load, so
  nothing built on it ran: not the note cipher, not the sealed approval, and not
  its Argon2id. The probe's own pure JavaScript Argon2id still gave the right
  key in that test. The planned fix is a second, pure JavaScript engine for the
  same operations, used when WebAssembly is missing. Until it exists, the
  encrypting version of Nexus will not work on a device with WebAssembly off. This was seen with the probe's test
  setup; running the probe on a phone with Lockdown Mode on is still to do.

## 6. Design rules, and the failures they come from

1. **No password-derived key on the server.** A copy of the key locked by a
   password, sitting where a stolen database can be guessed at, is the weakest
   point we found in the leading products. Recovery is by a random Recovery Key or by
   approving a device. Signal does without such a copy [S18].
2. **Authenticated encryption, with the ids bound in.** Every encryption checks
   the format version, vault id, note id and key number, and the name is inside
   the encrypted part. This answers the Obsidian Sync finding about unbound
   metadata [S3] and follows Standard Notes' binding of the item id [S28].
3. **Nothing the server can test for.** No hash or deterministic encryption of
   anything the server could compare, which is the Obsidian Sync finding
   TOB-OBSYNC-9 [S3].
4. **One format version at launch and no legacy or downgrade path.** Researchers
   at ETH Zurich reported that hostile servers could push Bitwarden and Dashlane
   onto old code paths [S76].
5. **Recovery is something only a client does.** The server cannot start it or
   answer for it, and there is no "reset it for you". The same study reported
   key-recovery attacks that came from the recovery features of LastPass and
   Dashlane [S76].
6. **Authenticate every public key a device is handed,** by the short code shown
   on both screens. The same study reported unauthenticated public keys in
   1Password's vault sharing [S76], and Bitwarden's log in with device compares a
   fingerprint for the same reason [S10].
7. **A device with an old key cannot write.** The server refuses a save under a
   key number older than the current one [S11].
8. **No home-made cryptography.** Nexus writes no cipher, mode, key-derivation
   function or key-wrapping code of its own. The code calls libsodium for each
   operation; the format is an arrangement of those calls, not new cryptography.
9. **One audited library, plus a second as a cross-check.** libsodium
   (`libsodium-wrappers-sumo`) is the one library the product uses. In the tests
   only, `@noble/ciphers` and `@noble/hashes` are an independent second
   implementation, and every ciphertext and key wrap is checked against them.
   Argon2id is checked in two steps, not one: libsodium's output must agree with
   `@noble/hashes` at Nexus's own settings (64 MiB, 3 passes, 1 lane), and
   `@noble/hashes` must reproduce the test vector in RFC 9106 [S34]. libsodium
   cannot run that vector itself, because it uses one lane and takes no secret or
   associated data, so the RFC reaches libsodium only through noble. The tests
   also use known-answer vectors from the XChaCha20 draft [S35], and a failing
   case for each bad input: wrong key, wrong note id, wrong `kid`, one changed
   byte, a truncated blob. Each must fail to decrypt.
10. **Nothing long-lived on the server is locked by a key a quantum computer
    would break** (3.1, 3.3).
11. **Versions are pinned and listed** (section 7).

Audits help and do not make a design safe. The ETH Zurich study reported common
design mistakes and misunderstandings of cryptography in four mature, audited,
widely used password managers [S76]. That is why the rules above come first and
the audit comes after.

## 7. What is audited, and what is not

| Part | Outside review, as far as we know |
| --- | --- |
| libsodium, the C library | Cryptography Engineering LLC, 2017, versions 1.0.12 and 1.0.13, reported to have found no major flaws; later versions are not covered, and we know of this from a summary and not the report [S41] |
| libsodium.js, the JavaScript and WebAssembly build we use | No audit stated [S48] |
| `@noble/ciphers` (tests only) | Cure53, September 2024 [S43] |
| `@noble/hashes` (tests only) | Cure53, January 2022, excluding Argon2 [S44] |
| Nexus's own code and design | None |

Two things to be plain about:

- **XChaCha20-Poly1305 is not a finished standard.** Its research-group draft
  expired in 2020 [S35]. It is built from ChaCha20-Poly1305, which is RFC 8439
  [S36], and libsodium and noble-ciphers implement it the same way [S39][S43].
  If a finished standard matters more to you, AES-256-GCM is the fallback.
- **Argon2id has no second audited implementation.** The noble library excludes
  Argon2 from its audit [S44]. What we do instead is two checks. libsodium and
  `@noble/hashes` give the same output at Nexus's own settings (64 MiB, 3 passes,
  1 lane), and noble gives the answer in the RFC 9106 test vector [S34].
  libsodium cannot run that vector (it uses one lane and takes no secret or
  associated data), so it is not checked against the RFC directly. This is a
  check and not an audit.

## 8. What Nexus claims

Until an outside firm has audited the design and the code, the most Nexus will say
about its encryption is that it **has not yet been independently audited** and
that it uses audited libraries. It will not say "secure", and it will not say
"unhackable": the ETH Zurich study found, on paper, successful attacks by a
hostile server against every one of four mature, audited products [S76]. The aim is narrower and
honest: no known way for the host to read your notes, and an outside firm that
agreed. We intend to seek such an audit. None has been done, and no date is
promised.

## Appendix: sources

Numbers are from the research this document was written from; numbers it does not
cite are left out, so there are gaps. Every page was read on 2026-11-14.
"Search summary" means the claim was seen only in a web search answer, and "not
read" means the page could not be opened or parsed.

- **[S1]** Obsidian Sync security (AES-256 GCM, scrypt with salt, no recovery, what the server can see, deterministic file hash) — <https://obsidian.md/help/sync/security>
- **[S3]** Obsidian blog, 13 May 2026: findings TOB-OBSYNC-2, -9 and -10 from an outside audit, and accepted trade-offs. The audit report itself was not read (the PDF could not be parsed), so the findings come from this post — <https://obsidian.md/blog/cure53-tob-sync-audits/>
- **[S5]** age specification (C2SP): payload, header MAC, X25519 and scrypt recipients, post-quantum recipient types — <https://github.com/C2SP/C2SP/blob/main/age.md>
- **[S7]** Bitwarden security white paper (PBKDF2; a generated key; account recovery, emergency access, trusted devices) — <https://bitwarden.com/help/bitwarden-security-white-paper/>
- **[S10]** Bitwarden, log in with device (public key, fingerprint check, 15-minute expiry) — <https://bitwarden.com/help/log-in-with-device/>
- **[S11]** Bitwarden, rotate account encryption key (warnings) — <https://bitwarden.com/help/account-encryption-key/>
- **[S12]** Bitwarden Secrets Manager access tokens (issued to a machine account; never stored; a revoked token may work up to one hour) — <https://bitwarden.com/help/access-tokens/>
- **[S18]** Signal, introducing Secure Backups, 8 Sep 2025 (64-character recovery key made on the device; lost means lost) — <https://signal.org/blog/introducing-secure-backups/>
- **[S19]** libsignal, `rust/message-backup/src/key.rs` (HKDF-SHA-256 from the backup key) — <https://raw.githubusercontent.com/signalapp/libsignal/main/rust/message-backup/src/key.rs>
- **[S25]** Proton Drive security (OpenPGP, Curve25519, names encrypted; the page gives no audit year) — <https://proton.me/drive/security>
- **[S28]** Standard Notes protocol 004 specification (Argon2id 64 MiB, 5 passes, 1 lane; XChaCha20-Poly1305 with a 192-bit nonce; item id in authenticated data; random 256-bit items keys) — <https://raw.githubusercontent.com/standardnotes/app/main/packages/snjs/specification.md>
- **[S31]** Search summary of the Standard Notes specification on password change (new items key becomes default, old data re-encrypted progressively), not opened as a primary page — <https://github.com/standardnotes/app/blob/main/packages/snjs/specification.md>
- **[S33]** OWASP Password Storage Cheat Sheet (Argon2id 19 MiB, t=2, p=1; scrypt; PBKDF2) — <https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>
- **[S34]** RFC 9106, Argon2 (September 2021, informational; recommended parameter options and test vectors) — <https://www.rfc-editor.org/rfc/rfc9106.html>
- **[S35]** XChaCha IRTF draft, version 03, expired 10 Jan 2020 — <https://datatracker.ietf.org/doc/draft-irtf-cfrg-xchacha/>
- **[S36]** RFC 8439, ChaCha20 and Poly1305 for IETF Protocols (June 2018, informational) — <https://www.rfc-editor.org/rfc/rfc8439.html>
- **[S39]** libsodium, XChaCha20-Poly1305 (192-bit nonce, random nonces safe) — <https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction>
- **[S41]** libsodium documentation introduction (a complete security audit was sponsored; ISC licence) — <https://libsodium.gitbook.io/doc>. The details of the 2017 report by Cryptography Engineering LLC (versions 1.0.12 and 1.0.13; scope covered AEAD, key exchange, key derivation and Argon2; no major flaws) come from a search summary; the report PDF <https://www.privateinternetaccess.com/blog/wp-content/uploads/2017/08/libsodium.pdf> was not opened
- **[S42]** libsodium, password hashing (Argon2id default since 1.0.15; interactive preset 64 MiB) — <https://libsodium.gitbook.io/doc/password_hashing/default_phf>
- **[S43]** noble-ciphers (XChaCha20-Poly1305, AES-GCM; zero dependencies; Cure53 audit September 2024 of v1.0.0, funded by OpenSats) — <https://github.com/paulmillr/noble-ciphers>
- **[S44]** noble-hashes (Cure53 audit January 2022 of v1.0.0, excluding Argon2) — <https://github.com/paulmillr/noble-hashes>
- **[S46]** noble-post-quantum (ML-KEM, X-Wing; self-audited only, v0.6.1, April 2026) — <https://github.com/paulmillr/noble-post-quantum>
- **[S48]** libsodium.js (WebAssembly with a JavaScript fallback; the sumo build carries `crypto_pwhash` and XChaCha20-Poly1305; ISC; no audit stated) — <https://github.com/jedisct1/libsodium.js>
- **[S63]** Obsidian `SecretStorage` guide (the secret is held in local storage, keyed to the vault) — <https://docs.obsidian.md/plugins/guides/secret-storage>; changelog 1.11, 12 Jan 2026 — <https://obsidian.md/changelog/2026-01-12-desktop-v1.11.4/>. Claims about mobile availability and keychain use came from a search summary and are not relied on here
- **[S64]** Self-hosted LiveSync 0.25.0, 19 Jul 2025 (all metadata encrypted, not obfuscated) — <https://github.com/vrtmrz/obsidian-livesync/releases/tag/0.25.0>. The visible document ids, revision information and ciphertext lengths come from a search summary of a third-party reimplementation
- **[S65]** Cryptomator security target (timestamps, file counts and sizes visible; a hostile store can swap encrypted filenames) — <https://docs.cryptomator.org/security/security-target/>; architecture — <https://docs.cryptomator.org/security/architecture/>
- **[S66]** Apple, Private Cloud Compute, 10 Jun 2024 (stateless computation, data not retained after the response, published software images) — <https://security.apple.com/blog/private-cloud-compute/>
- **[S67]** TEE.fail (a DDR5 interposer built for under US$1,000 against Intel SGX and TDX, AMD SEV-SNP and Nvidia confidential computing; IEEE S&P 2026; outside the vendors' threat models) — <https://tee.fail/>
- **[S68]** AWS Nitro Enclaves concepts (no network, no persistent storage, signed attestation, key service conditions) — <https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave-concepts.html>
- **[S71]** NIST post-quantum cryptography FAQs (Grover's algorithm and AES key sizes) — <https://csrc.nist.gov/projects/post-quantum-cryptography/faqs>. The page is about AES; reading it as true of a 256-bit XChaCha20 key is general knowledge, not something the page states
- **[S76]** ETH Zurich researchers, "Zero Knowledge (About) Encryption: A Comparative Security Analysis of Four Cloud-based Password Managers", IACR ePrint 2026/058, USENIX Security 2026 (12 attacks on Bitwarden, 7 on LastPass, 6 on Dashlane, 6 on 1Password). The abstract was opened; the detail on recovery features, legacy code paths and unauthenticated public keys comes from a search summary of the paper and press coverage — <https://eprint.iacr.org/2026/058>
- **[S77]** Padmé and PURBs paper, arXiv 1806.03160, 2018 (leakage limited to about O(log log M) bits for size up to M; overhead at most 12%) — <https://arxiv.org/abs/1806.03160>
