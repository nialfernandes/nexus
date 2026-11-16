# Nexus server

The Nexus sync server keeps every version of every note of a vault, in a SQL database, and answers a small HTTP
API for storing and fetching them. **It holds only encrypted blobs and cannot read a note.** Each device encrypts a
note before it sends it, name and folder included (the format is in [docs/FORMAT.md](../docs/FORMAT.md), made by
[packages/crypto](../packages/crypto)), and the server stores the bytes as it was given them. It is written to run on
any host: all of its logic talks to a few interfaces (the **ports**, in `src/ports.ts`), and a **plug** supplies them
for one host. The one plug today is for Cloudflare Workers and D1 (`src/plugs/cloudflare/`).

**Status.** Not audited, like the rest of this repository (see the [top-level README](../README.md) and the
[threat model](../docs/THREAT-MODEL.md), which says what the server can still see). The Obsidian plugin in `plugin/`
now encrypts every note and uses the routes below, but the screens that make and unlock the vault key are not built yet, so
it has no key and **does not sync with this server yet**. Nothing is deployed.

## What it stores

A **note** is a row with an id the device chose (random, or made from a key the device keeps; never the path) and the number of its latest version. A
**version** is written once and never changed:

| Kept | What it is |
| --- | --- |
| `id`, `version` | The note's id and the version's number, from 1 |
| `kid` | The number of the vault key the blob is under |
| `blob` | The encrypted note, as base64 text. The server never opens it |
| `hash` | SHA-256 of the blob, 64 hex characters, so a device can check what it reads is what was stored |
| `writer`, `at` | The device that saved it, and the time (unix milliseconds). A device is a sign-in's token, written `device:<the token's id>`, the id the owner sees in the list of tokens and can revoke by. The owner's own browser session is not a token, and is written as the owner's name |
| `kind` | `save`, or `delete` (a delete keeps the blob it followed) |

A **wrap** is the vault key locked under the Recovery Key (`recovery`) or, if the person chose one, under a password
(`password`): opaque base64 with its `kid`. A new device that has the Recovery Key or the password fetches the wrap and
unlocks the vault key.

A wrap opens only with the **vault id** it was made with, so the server keeps that id beside the wraps (table `nexus_vault`,
migration 0005) and answers it with `GET /wraps`. The owner sends it with every wrap; the first one sets it, a wrap sent with
another id is refused (`409`), and it stays when every wrap is removed, because it names the vault the notes belong to. It is
not secret. Without it, a device or an agent that holds only the Recovery Key could not open the Recovery wrap. A wrap kept
before migration 0005 has no vault id beside it: the owner keeps it again, with the id.

**Nothing else about a note is kept or logged: no path, name, folder or text.** The server cannot search, and it has no
folders to give rights over. `src/no-plaintext.test.ts` stores two notes, calls every route, and fails if any table
row, log line or answer holds either note's path, folder, name or text (plain, escaped, or as base64).
Sign-in tokens, device labels and identity names are kept, since the server needs them.

## What it does

- Every save is a new version. Nothing is changed or removed once written.
- **A save names the version it started from** (`base`, 0 for a new note). If the note is at another version the save is
  refused `409` with the version it is at (`current`), and **the device reads the note, merges its edit into it, and
  saves again** from `current`. The server never merges: it cannot read a note. The merge is
  [packages/merge](../packages/merge), the code the server used to run, for the device to use. Two saves at the same
  moment cannot both win: one is saved and the other is refused.
- **A save has to look like an encrypted note, by its first bytes.** The server reads the length and the first five bytes of
  a blob and nothing after them ([docs/FORMAT.md](../docs/FORMAT.md) section 6): the first byte is the format's version
  (1), the next four, big-endian, are the save's `kid`, and the blob is at least 301 bytes (the version, kid, nonce, tag and
  a record padded to 256 bytes). A wrap is checked by its own header (section 7): the version, a second byte that says it is
  the kind of wrap it is saved as (2 for `recovery`, 3 for `password`), and at least 74 or 102 bytes. Anything else is `400`
  with a `reason` beside the words in `error`, and nothing is kept. This stops a device that forgot to encrypt from
  leaving a note in plain text here. It is not proof of encryption: a header followed by random bytes is accepted, since
  the server never opens a blob.
- A **changes feed** lets a device catch up from a cursor, a page at a time: a page is cut by its size as well as by its
  number of versions (see "The changes feed"). A history and a list say what the server holds, without blobs.
- A delete is a version too, and a save that starts from the delete's version brings the note back.
- Callers are **identities** (a person, an agent or an app). There are **no folder rights**: the folders are inside the
  encrypted notes, so an identity that is let in can use every note, and one that is not cannot. A caller calls with a
  bearer token that was made for one identity. Only the owner manages identities, tokens and wraps.
- A token is got by **device approval**: a device asks for a sign-in and is handed a short code and a link, the owner
  opens the link and allows it, and the device is handed its token once. Only a hash of a token is ever kept.
- A device can send its **public key** (`deviceKey`, an X25519 key as base64) when it asks for a sign-in. The owner's
  device, if it holds the vault key, can send with its allow an **approval**: the vault key sealed to that key, and
  its own public key for the approval (`approval` and `approverKey`). The server cannot open the approval. It keeps it
  beside the sign-in and hands it to the new device in the same first poll that hands over the token, **once**: the
  approval is deleted as the sign-in is marked collected. One that is never collected is deleted when its sign-in
  has run out (ten minutes): the device's own poll deletes it, and so does the next sign-in that starts or is allowed, because
  the server has no clock of its own to run at that moment. A server can still make or swap an approval, so the new
  device does not use the key in one until a person has compared the matching code on both screens
  ([docs/FORMAT.md](../docs/FORMAT.md) section 7.4).

Gone from earlier versions of this server: `/search` (a device searches its own copy), the folder rights and the
`/rights` route, `/move` (a rename is a new blob with the new path inside it, saved as the next version of the same id),
the server's own merge and its clash versions, the "target path exists" check, and the short hash of the text.

## The routes

All routes are under `/nexus/api`. A route takes JSON (a request that is not declared `application/json` is refused) and
answers JSON; a refusal is `{ "error": "<plain words>" }` and nothing is cached. A refusal because of a header also has a `reason`:
`not-an-encrypted-blob`, `blob-too-short` or `kid-mismatch` for a save; `not-an-encrypted-wrap`, `kind-mismatch` or `wrap-too-short` for a wrap. A blob or wrap is standard base64 with its
`=` padding. A body with a field a route does not list is refused `400`, so a client that still sends a path or a text is
told so and nothing of it is kept. The full contract is at the top of `src/routes.ts` and `src/__fixtures__/nexus-world.ts`.

| Route | Who | What |
| --- | --- | --- |
| `POST /save` `{ id, base, kid, blob }` | any identity | `200 { result: "saved", id, version }`; `409 { error, current }` if the note is at another version (`current` is 0 when there is no such note); `400` with a `reason` when the blob does not begin as an encrypted note does; `413` over 1,000,000 bytes |
| `GET /note?id=I[&version=N]` | any | `200 { id, version, kind, kid, blob, hash, writer, at }` |
| `GET /history?id=I` | any | `200 { id, versions: [ { version, kind, kid, writer, at, hash } ] }` |
| `GET /list` | any | `200 { notes: [ { id, version, at, kid, hash } ] }`, the live notes |
| `GET /changes[?after=C][&limit=N]` | any | `200 { changes: [ { id, version, kind, kid, writer, at, hash, blob } ], next }`, a delete has no blob. A page can hold fewer than `limit` versions: see "The changes feed" |
| `GET /heads[?after=C][&limit=N]` | any | `200 { heads: [ { id, version, kind, kid, writer, at, hash, blob } ], next }`: the newest version of every note, a delete (a deleted note's newest version) with no blob. Paged as `/changes` is: see "The heads listing" |
| `POST /delete` `{ id, base }` | any | `200 { result: "deleted", id, version }`; `404`; `409 { error, current }` |
| `GET /wraps` | any | `200 { vaultId, wraps: [ { kid, kind, wrap, writer, at } ] }`: `vaultId` is the vault id the wraps were made with, `null` before the first wrap |
| `POST /wrap` `{ kid, kind, wrap, vaultId }` | owner | Keeps a wrap, replacing the one of that kind for that `kid`; `400` with a `reason` when the wrap does not begin as that kind of wrap does; `409` when the server already holds a vault with another `vaultId` |
| `POST /wrap/delete` `{ kid, kind }` | owner | Removes a wrap |
| `POST /identity` `{ name, kind }`, `GET /tokens`, `POST /token/revoke` `{ id }` | owner | Managing |
| `POST /device/start`, `POST /device/poll` | nobody needs a sign-in | A device asks for a token |
| `GET /device/pending`, `POST /device/approve`, `POST /device/deny` | owner | Answering a device. A code that is finished is `410 { error, reason }`: `reason` is `"expired"` when nobody answered in ten minutes and `"used"` when it was answered already (the approval page draws a different card for each); a code Nexus has no sign-in for is `404` |

A note id is 1 to 128 letters, digits, hyphens or underscores (what url-safe base64, hex and a UUID are written in): a
path, with its slashes and dots, is refused as an id so it cannot be used as one by mistake.

### The changes feed

`GET /changes` answers the versions after a cursor, oldest first, with `next`, the cursor to ask from again. A page ends
at `limit` versions (100 when none is asked for, at most 500) **or** just before the version that would take the blobs
on the page past `NEXUS_CHANGES_PAGE_BYTES` (4,000,000 when it is not set), whichever comes first. A version is never
cut in two, `next` is the place of the last version on the page so the next page starts at the version after it, and a
page always holds at least one version, so a single version larger than the cap is sent on its own. What is counted is
each blob as it is sent, as base64 text (a blob of the largest size a note may be, 1,000,000 bytes, is 1,333,336
characters); a delete is sent with no blob and counts for none, and the few hundred bytes of JSON around each blob are not counted. So a page can be shorter than `limit` without the feed
being at its end: a device keeps asking from `next` until a page comes back empty (the same cursor comes back).

### The heads listing

`GET /heads` answers the newest version of each note and none of the versions it replaced, for a client that wants to know what
the vault holds now: where `/changes` sends one blob for every version ever saved, `/heads` sends one for every note. It pages
exactly as `/changes` does (`limit` and the same `NEXUS_CHANGES_PAGE_BYTES` cap, at least one note a page, the same cursor and the
same answer to a bad one), and the notes come in the order of their newest versions, so `next` is the place of the newest version of
the last note on the page. A note saved again while a client is reading the pages moves to the end of the listing and is met once
more, at its new version, so no note is missed: a client keeps the highest version it was given for each id. When a page comes back
empty its `next` is the place of the last version Nexus holds, so the changes feed asked from there gives what happened after the
listing and nothing from before it.

## Addresses: `/nexus`

Everything is under `/nexus`: the API at `/nexus/api/...` and the device approval page at `/nexus/approve`. Nothing else
answers: the older `/apps/nexus` prefix has been removed, and an address under it is a 404 like any other that is not
Nexus's. A link a device is handed is always on `/nexus`. `src/addresses.ts` is the one place the prefix is written.

On Cloudflare the page's files (the page, its stylesheet and script, and its three typefaces in `public/nexus/fonts`) sit in the assets under `public/nexus`, the same address the Worker serves them at, so
`wrangler.jsonc` sets `assets.run_worker_first` to `["/nexus/*"]`: without it the asset server would hand them to anyone
before the Worker could check for the owner. (The tests use a stand-in for the asset server, so this setting is the part
they cannot prove on Cloudflare itself.)

## A vault that was kept in plain text

Earlier versions of this server stored each note's path and its whole text. **Migration 0003 drops those tables**
(`nexus_notes`, `nexus_versions` and `nexus_rights`) and makes the blob ones, because the server cannot encrypt: it cannot turn
the notes it holds into blobs, and keeping a copy would leave every note readable by whoever runs the server. It does not
convert a plain text vault. **The first device that connects after the setup uploads every note again, encrypted.**
Identities and tokens are kept, so devices that were signed in stay signed in.

What is lost is the server's own history of old versions: the vault on your devices is the copy that matters. If you want
the old versions, export them from the database **before** you apply migration 0003, for example with
`npx wrangler d1 export nexus --remote --output nexus-before-blobs.sql`, and keep that file somewhere that only you can read,
because it holds your notes in plain text.

## The owner and the settings

One identity is the **owner**: it alone can make identities, list and revoke tokens, keep and remove wraps, and answer a
device's sign-in. Which identity that is, is a setting. There is no built-in owner.

| Setting | What it is | When it is left out |
| --- | --- | --- |
| `NEXUS_OWNER` | The owner's identity name: lower case letters, digits and hyphens, up to 40 characters, such as `owner`. | **None.** Nexus has no owner, so no browser session is let in and no device can be approved. It stays closed. Tokens that already exist still work. |
| `NEXUS_ADDRESS` | The public address of this Nexus, such as `https://nexus.example.org`. Only the scheme, host and port are kept. | **None.** The link a device is handed is built on the address the request came to. Set this when the server sits behind a proxy that changes the address. |
| `NEXUS_CHANGES_PAGE_BYTES` | The most blob text one page of the changes feed sends, in bytes: a whole number, 1 or more, such as `4000000`. See "The changes feed" below. | **4,000,000.** |
| `NEXUS_OWNER_SECRET` | The Cloudflare plug's way of knowing the owner: a long secret, at least 32 characters. See "Signing in as the owner". Make one with `openssl rand -hex 32`. | **None.** No cookie lets anyone in as the owner. |

A setting that is there but cannot be used (an owner name that is not a name, an address that is not a web address,
a page size that is not a whole number of bytes, a secret shorter than 32 characters) stops every request with a plain 503, and the Worker's log says which
variable is wrong.

## Run it on Cloudflare

You need a Cloudflare account and Node 22.13 or later. `wrangler` is run with `npx` and is not a dependency of this
package.

1. Install: `npm ci` at the repository root, which installs every package, this one included.
2. Make the database: `npx wrangler d1 create nexus`. It prints a database id. Put it in `wrangler.jsonc`, in place
   of `REPLACE-WITH-THE-ID-FROM-WRANGLER-D1-CREATE`.
3. Build its tables: `npx wrangler d1 migrations apply nexus --remote`. The files in `migrations/` are applied in
   name order. They seed nothing: there are no identities until the owner makes them. If this database already holds a
   plain text vault from an earlier version, read "A vault that was kept in plain text" above first.
4. Choose the settings. Put the variables in `wrangler.jsonc`, under `vars`:

   ```jsonc
   "vars": { "NEXUS_OWNER": "owner", "NEXUS_ADDRESS": "https://nexus.example.org" }
   ```

   and set the secret, which is never written in a file: `npx wrangler secret put NEXUS_OWNER_SECRET`.
5. Deploy: `npx wrangler deploy`.

Serve Nexus over HTTPS only. The owner's secret and every token travel in request headers.

The Worker (`src/plugs/cloudflare/worker.ts`) sends `/nexus/api/*` to Nexus, gives the
owner the device approval page (`public/nexus/`, served through the `ASSETS` binding), and answers 404 to everything
else. The files of the page are static and identical for everyone and hold nothing private, and `run_worker_first`
(above) makes the Worker the only way to them.

### Signing in as the owner

A Cloudflare Worker has no accounts, so the Cloudflare plug knows the owner by a secret: a request that carries the
cookie `nexus_owner` holding the value of `NEXUS_OWNER_SECRET` is the owner's, as the identity named by `NEXUS_OWNER`.
The secret is compared by its hash. Everything else that calls Nexus brings a bearer token.

The `nexus-agent` command makes these requests for you (`make-identity`, `allow`, `owner-sign-in` and `set-up-agent`,
which sets an agent up end to end): see [the agent package's README](../packages/agent/README.md). The requests below are
for any other client.

To start, approve a device or make an identity with a plain request. Read the secret from a file or a password
manager rather than typing it, so it does not stay in your shell history:

```sh
# Make an identity for an agent.
curl -X POST https://nexus.example.org/nexus/api/identity \
  -H 'content-type: application/json' -b "nexus_owner=$(cat owner-secret)" \
  -d '{"name":"agents","kind":"agent"}'

# A device asks for a sign-in as that identity. It is handed a code, a link and a secret.
curl -X POST https://nexus.example.org/nexus/api/device/start \
  -H 'content-type: application/json' -d '{"identity":"agents","label":"my laptop"}'

# The owner allows the code (or opens the link in a browser that holds the cookie).
curl -X POST https://nexus.example.org/nexus/api/device/approve \
  -H 'content-type: application/json' -b "nexus_owner=$(cat owner-secret)" -d '{"code":"K7QM-4XNP"}'

# The device polls with its secret and is handed its token, once.
curl -X POST https://nexus.example.org/nexus/api/device/poll \
  -H 'content-type: application/json' -d '{"secret":"<the secret from the start answer>"}'
```

The approval page needs the same cookie in the browser. A browser that holds it should keep it `Secure`, `HttpOnly`
and `SameSite=Lax`. Nexus also refuses any request whose body is not declared `application/json`, as a second wall
against a page on another site acting for the owner.

A better browser sign-in than a hand-set cookie (for example, Cloudflare Access in front of the page) is not built
yet. Because a host decides how the owner signs in, that is exactly what a plug supplies (below).

## What a new host plug must provide

Everything outside `src/plugs/` uses only the interfaces in `src/ports.ts`. To run Nexus somewhere that is not
Cloudflare, write one plug that builds a `NexusHost` and hands each request to `runNexus(request, host)` (in
`src/routes.ts`), which answers it and never throws. A host provides:

- **`sql`**, a `SqlDb`. This is the contract, and it is the common ground of SQLite and Postgres:
  - `?` placeholders, in order. (A Postgres plug rewrites them to `$1`, `$2`, and so on.)
  - Values are text, whole numbers or null. Booleans are the integers 0 and 1. Encrypted bytes are kept as base64 text.
  - Rows come back as plain objects keyed by column name, and counts as JavaScript numbers.
  - **`batch` is one transaction**: every statement is applied or none is. Every write Nexus makes relies on it, and
    so does its way of staying safe when two writers meet: a write that loses to another one fails whole and is run
    again.
  - Nothing SQLite-only. `src/portable.test.ts` reads every source file and refuses SQLite-only functions and syntax,
    `INSERT OR ...`, `PRAGMA`, `rowid`, placeholders other than `?`, and any Cloudflare type or binding outside the
    plug. A new plug lives under `src/plugs/<host>/` and the test is extended to name it.
- **`clock`**, a `Clock`: `now()` in unix milliseconds. Tests give it a clock they control.
- **`secrets`**, a `Secrets`: `random(count)` bytes that cannot be guessed, `hash(text)` and `hashBytes(bytes)`, SHA-256
  as 64 lower case hex characters (of a token's text, and of a blob).
- **`signIn`**, a `NexusSignIn`: `identify(request)` answers who is making the request with a browser session, or
  null. It must answer only `{ identity: settings.owner }` or null, and null when there is no owner. How the owner
  proves who they are (a cookie, a header set by a proxy, a client certificate) is the plug's choice.
- **`settings`**, a `NexusSettings`: the owner and the address, each `null` when not set, and the size of a page of the
  changes feed, a number of bytes (4,000,000 when the host has no choice), read from the host's own configuration.

Besides the host, the plug must create the tables by applying the files in `migrations/` in name order (split at the
semicolons: the files hold no semicolon inside a comment or a literal), and may serve the approval page in `public/`
to the owner. The Cloudflare plug in `src/plugs/cloudflare/` is the worked example: `host.ts` builds the host,
`d1.ts` is the SQL plug, `secrets.ts` the secrets plug, `signin.ts` the sign-in plug, `settings.ts` reads the
settings, `worker.ts` is the entry, and `app.ts` lets an app in the same Worker call the store without a token.

## Develop

```sh
npm ci                                   # at the repository root: installs exactly what package-lock.json says
npm test --workspace nexus-server        # every test
npm run typecheck --workspace nexus-server # tsc --noEmit
```

The server is one workspace of the repository's root `package.json`; `npm run check` at the root runs every package's
checks, this one's included. Node 22.13 or later is needed (the root `package.json` says so once): the tests use
`node:sqlite`, which prints an "experimental" warning that can be ignored.

The one thing the server takes from the encryption package, `@nexus/crypto`, is the format's numbers
(`@nexus/crypto/format`: the version byte, the kind bytes and the smallest sizes `src/header.ts` checks a blob and a wrap
against). That file holds no encryption, so the server still holds none.

The tests run in plain Node. They call the real Worker entry (`src/plugs/cloudflare/worker.ts`), with a stand-in for
D1 made from an in-memory SQLite database (`memoryD1` in `packages/test-sqlite`, shared with the plugin's tests) that keeps D1's two behaviours Nexus
relies on: a batch is one transaction, and foreign keys are enforced. They do not run on Cloudflare itself, so the
plug's use of the real D1 and of the real asset server is the part they do not prove.

```
migrations/          the schema, in the SQL common ground of SQLite and Postgres
public/nexus/        the device approval page (four static files)
src/ports.ts         what the logic needs from a host
src/routes.ts        the routes, and the one place a request becomes an answer
src/*.ts             the logic: the store, wraps, identities, devices, addresses
src/plugs/cloudflare the one host plug today
src/__fixtures__/    what the tests are built on
```

## License

MIT, as the rest of this repository.
