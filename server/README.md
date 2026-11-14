# Nexus server

The Nexus sync server keeps the notes of a vault, and every version of every note, in a SQL database, and
answers a small HTTP API for reading and writing them. It is written to run on any host: all of its logic talks to
a few interfaces (the **ports**, in `src/ports.ts`), and a **plug** supplies them for one host. The one plug today
is for Cloudflare Workers and D1 (`src/plugs/cloudflare/`).

**Status.** This is the plaintext server. Notes are stored in the database as the text you save, and the server
can read them. They are not encrypted, and this code has not been audited. Do not put anything in it that you
would not be willing to have the person running the server read.

The planned encryption, and what it will and will not protect against, is in the [threat model](../docs/THREAT-MODEL.md).
The not-yet-audited notice in the [top-level README](../README.md) applies to everything here.

## What it does

- Every save is a new version. Nothing is changed or removed once written.
- Two writers who start from the same version both keep their edits: if their changes touch different lines the
  server merges them, and if they touch the same lines both texts are kept and the note is flagged as a clash until
  a later save resolves it.
- Notes can be listed, searched, moved and deleted, and a **changes feed** lets a client catch up from a cursor.
- Callers are **identities**, each holding **folder rights** (read, write or none, for a folder and everything under
  it). A caller calls with a bearer token that was made for one identity.
- A token is got by **device approval**: a device asks for a sign-in and is handed a short code and a link, the owner
  opens the link and allows it, and the device is handed its token once. Only a hash of a token is ever kept.

The routes and the shape of every answer are written at the top of `src/routes.ts`, and the contract the tests hold
them to is at the top of `src/__fixtures__/nexus-world.ts` and `src/__fixtures__/identity-world.ts`. All routes are
under `/apps/nexus/api`.

## The owner and the settings

One identity is the **owner**: it holds write on everything, always, and it alone can make identities, set rights,
list and revoke tokens, and answer a device's sign-in. Which identity that is, is a setting. There is no built-in
owner.

| Setting | What it is | When it is left out |
| --- | --- | --- |
| `NEXUS_OWNER` | The owner's identity name: lower case letters, digits and hyphens, up to 40 characters, such as `owner`. | **None.** Nexus has no owner, so no browser session is let in and no device can be approved. It stays closed. Tokens that already exist still work. |
| `NEXUS_ADDRESS` | The public address of this Nexus, such as `https://nexus.example.org`. Only the scheme, host and port are kept. | **None.** The link a device is handed is built on the address the request came to. Set this when the server sits behind a proxy that changes the address. |
| `NEXUS_OWNER_SECRET` | The Cloudflare plug's way of knowing the owner: a long secret, at least 32 characters. See "Signing in as the owner". Make one with `openssl rand -hex 32`. | **None.** No cookie lets anyone in as the owner. |

A setting that is there but cannot be used (an owner name that is not a name, an address that is not a web address,
a secret shorter than 32 characters) stops every request with a plain 503, and the Worker's log says which
variable is wrong.

## Run it on Cloudflare

You need a Cloudflare account and Node 22.13 or later. `wrangler` is run with `npx` and is not a dependency of this
package.

1. Install: `cd server && npm ci`.
2. Make the database: `npx wrangler d1 create nexus`. It prints a database id. Put it in `wrangler.jsonc`, in place
   of `REPLACE-WITH-THE-ID-FROM-WRANGLER-D1-CREATE`.
3. Build its tables: `npx wrangler d1 migrations apply nexus --remote`. The files in `migrations/` are applied in
   name order. They seed nothing: there are no identities until the owner makes them.
4. Choose the settings. Put the variables in `wrangler.jsonc`, under `vars`:

   ```jsonc
   "vars": { "NEXUS_OWNER": "owner", "NEXUS_ADDRESS": "https://nexus.example.org" }
   ```

   and set the secret, which is never written in a file: `npx wrangler secret put NEXUS_OWNER_SECRET`.
5. Deploy: `npx wrangler deploy`.

Serve Nexus over HTTPS only. The owner's secret and every token travel in request headers.

The Worker (`src/plugs/cloudflare/worker.ts`) sends `/apps/nexus/api/*` to Nexus, gives the owner the device approval
page (`public/nexus/`, served through the `ASSETS` binding), and answers 404 to everything else. The four files of the
page are static and identical for everyone, and hold nothing private, so Cloudflare's asset server will also serve
them under `/nexus/`; the Worker's `/apps/nexus/...` addresses are the ones that check for the owner.

### Signing in as the owner

A Cloudflare Worker has no accounts, so the Cloudflare plug knows the owner by a secret: a request that carries the
cookie `nexus_owner` holding the value of `NEXUS_OWNER_SECRET` is the owner's, as the identity named by `NEXUS_OWNER`.
The secret is compared by its hash. Everything else that calls Nexus brings a bearer token.

To start, approve a device or make an identity with a plain request. Read the secret from a file or a password
manager rather than typing it, so it does not stay in your shell history:

```sh
# Make an identity for an agent, allowed to write everywhere except Private/.
curl -X POST https://nexus.example.org/apps/nexus/api/identity \
  -H 'content-type: application/json' -b "nexus_owner=$(cat owner-secret)" \
  -d '{"name":"agents","kind":"agent","rights":[{"path":"","access":"write"},{"path":"Private/","access":"none"}]}'

# A device asks for a sign-in as that identity. It is handed a code, a link and a secret.
curl -X POST https://nexus.example.org/apps/nexus/api/device/start \
  -H 'content-type: application/json' -d '{"identity":"agents","label":"my laptop"}'

# The owner allows the code (or opens the link in a browser that holds the cookie).
curl -X POST https://nexus.example.org/apps/nexus/api/device/approve \
  -H 'content-type: application/json' -b "nexus_owner=$(cat owner-secret)" -d '{"code":"K7QM-4XNP"}'

# The device polls with its secret and is handed its token, once.
curl -X POST https://nexus.example.org/apps/nexus/api/device/poll \
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
  - Values are text, whole numbers or null. Booleans are the integers 0 and 1.
  - Rows come back as plain objects keyed by column name, and counts as JavaScript numbers.
  - **`batch` is one transaction**: every statement is applied or none is. Every write Nexus makes relies on it, and
    so does its way of staying safe when two writers meet: a write that loses to another one fails whole and is run
    again.
  - Nothing SQLite-only. `src/portable.test.ts` reads every source file and refuses SQLite-only functions and syntax,
    `INSERT OR ...`, `PRAGMA`, `rowid`, placeholders other than `?`, and any Cloudflare type or binding outside the
    plug. A new plug lives under `src/plugs/<host>/` and the test is extended to name it.
- **`clock`**, a `Clock`: `now()` in unix milliseconds. Tests give it a clock they control.
- **`secrets`**, a `Secrets`: `random(count)` bytes that cannot be guessed, and `hash(text)`, SHA-256 as 64 lower
  case hex characters.
- **`signIn`**, a `NexusSignIn`: `identify(request)` answers who is making the request with a browser session, or
  null. It must answer only `{ identity: settings.owner }` or null, and null when there is no owner. How the owner
  proves who they are (a cookie, a header set by a proxy, a client certificate) is the plug's choice.
- **`settings`**, a `NexusSettings`: the owner and the address, each `null` when not set, read from the host's own
  configuration.

Besides the host, the plug must create the tables by applying the files in `migrations/` in name order (split at the
semicolons: the files hold no semicolon inside a comment or a literal), and may serve the approval page in `public/`
to the owner. The Cloudflare plug in `src/plugs/cloudflare/` is the worked example: `host.ts` builds the host,
`d1.ts` is the SQL plug, `secrets.ts` the secrets plug, `signin.ts` the sign-in plug, `settings.ts` reads the
settings, `worker.ts` is the entry, and `app.ts` lets an app in the same Worker call the store without a token.

## Develop

```sh
npm ci            # install exactly what package-lock.json says
npm test          # every test
npm run typecheck # tsc --noEmit
```

Node 22.13 or later is needed: the tests use `node:sqlite`, which prints an "experimental" warning that can be
ignored.

The tests run in plain Node. They call the real Worker entry (`src/plugs/cloudflare/worker.ts`), with a stand-in for
D1 made from an in-memory SQLite database (`src/__fixtures__/d1-sqlite.ts`) that keeps D1's two behaviours Nexus
relies on: a batch is one transaction, and foreign keys are enforced. They do not run on Cloudflare itself, so the
plug's use of the real D1 and of the real asset server is the part they do not prove.

```
migrations/          the schema, in the SQL common ground of SQLite and Postgres
public/nexus/        the device approval page (four static files)
src/ports.ts         what the logic needs from a host
src/routes.ts        the routes, and the one place a request becomes an answer
src/*.ts             the logic: the store, merging, rights, identities, devices
src/plugs/cloudflare the one host plug today
src/__fixtures__/    what the tests are built on
```

## License

MIT, as the rest of this repository.
