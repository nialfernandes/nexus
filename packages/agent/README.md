# @nexus/agent

For an agent that holds a key of its own: a **library** that reads and writes the encrypted
Nexus vault by note path, and the **`nexus-agent` command** a person runs, in their own
terminal, to set the vault up and to approve an agent.

**Nexus encryption has not yet been independently audited.** See the
[threat model](../../docs/THREAT-MODEL.md).

The agent is a device with its own X25519 key pair. The person makes the key pair, approves
its public half, and keeps the private half and the approval in their own secrets manager.
The agent opens the approval into the vault key, in memory only, and from then on reads and
writes notes exactly as the Obsidian plugin does: each note is encrypted on the agent before
it is sent, with its path inside, so the server never reads one.

## The steps a person takes

Each step is run by the person, in their own terminal. Nothing here is run by an agent. You need the address Nexus's
routes sit under (`NEXUS_ADDRESS`), the name of the server's owner (its `NEXUS_OWNER` setting) and the **owner secret** (its
`NEXUS_OWNER_SECRET`, see "Signing in as the owner" in the [server's README](../../server/README.md)). The owner secret is
the owner's credential for these commands: put it in `NEXUS_OWNER_SECRET`, or leave it out and the command asks for it at a
**hidden** prompt (or reads one line of standard input, which is how a secrets manager can feed it). It is sent to Nexus only as
the owner's cookie, and it is never an argument and never printed.

1. **Sign in as the owner:** `nexus-agent owner-sign-in --identity <the owner's name>`. It starts a sign-in for the owner,
   allows it with the owner secret, and prints the owner's token once. You never open the approval page for your own
   terminal. Save the token: it is the owner's `NEXUS_TOKEN` for the next step.
2. **Set up the vault** on a server that has none: `nexus-agent create-vault`. It makes the vault key, the vault id and the
   Recovery Key, and shows the Recovery Key **on this terminal only** (not into a pipe or a file). Write it down in your
   password manager. It asks you to type the last four characters back before it sends anything. It then keeps the Recovery
   wrap and the vault id on the server. It refuses a server that already has a wrap, a wrong type-back, and a token that is
   not the owner's.
3. **Set up each agent:** `nexus-agent set-up-agent --name scribe`. For a vault that exists, it does the whole of an agent's
   setup in one run:
   - it makes the identity `scribe` (kind `agent`; one that already exists is used),
   - makes the agent's key pair,
   - signs the agent in and allows it with the owner secret,
   - asks for the Recovery Key at a **hidden** prompt, opens the vault key with it and seals it to the agent's public key, and
   - prints the four values the agent needs, each on its own labelled line, once:

   ```
   NEXUS_ADDRESS=https://nexus.example.org/nexus/api
   NEXUS_TOKEN=nx_...
   NEXUS_AGENT_PRIVATE_KEY=...
   NEXUS_AGENT_APPROVAL=...
   ```

   Save them in your secrets manager now: they are shown once, and Nexus never sees the private key or the approval. A wrong
   owner secret, a server with no vault and a wrong Recovery Key are each refused before anything is made. Needs no
   `NEXUS_TOKEN` of yours: the owner secret does it all.

### The same steps one at a time

`set-up-agent` is these commands run in order, and each can be run alone:

- **Make an identity:** `nexus-agent make-identity --name scribe --kind agent` (the kind is `agent`, `person` or `app`).
- **Make the agent's key pair:** `nexus-agent keygen`. It prints the private key and the public key, each on its own labelled
  line, and a short code for the public key. Save the private key in your secrets manager now: it is shown once.
- **Sign a device in as an identity:** `nexus-agent sign-in --identity <name> --label <label>` starts the device sign-in every
  device uses. Open the link it prints, signed in as the owner, check the code, and allow it. Or allow it from a terminal:
  `nexus-agent allow <code>` asks Nexus what is asking (the identity and the label), shows it to you, and sends the allow only
  when you type `yes`. Anything else, or the input ending, allows nothing. `nexus-agent deny <code>` is the same for turning
  one down. The token is printed once, by `sign-in`.
- **Approve the agent:** `nexus-agent approve-agent` asks for the agent's public key (paste the `PUBLIC KEY` line from `keygen`)
  and for the Recovery Key at a **hidden** prompt. It fetches the Recovery wrap and the vault id from the server, opens the
  vault key, seals it to the agent's public key and **prints the approval**. Save it beside the agent's private key. The server
  never sees it. A wrong or mistyped Recovery Key is refused and nothing is printed.

A key is never an argument to any command: it would show in the process list and in the shell's history. The Recovery Key is
typed at a hidden prompt (or piped in on standard input, which is how a secrets manager can feed it), the owner secret is typed
at a hidden prompt or read from the environment, and the others come from the environment.

The owner's commands refuse a wrong owner secret with a plain message and change nothing. They send nothing but the owner's
cookie: not a token with it.

## The environment

| Variable | What it is | Read by |
| --- | --- | --- |
| `NEXUS_ADDRESS` | The address Nexus's routes sit under, such as `https://nexus.example.org/nexus/api` (the same address the Obsidian plugin takes) | every command except `keygen` |
| `NEXUS_TOKEN` | A sign-in token: the owner's for `create-vault` and `approve-agent`, the agent's own for `read`, `write` and `list` | `create-vault`, `approve-agent`, `read`, `write`, `list` |
| `NEXUS_AGENT_PRIVATE_KEY` | The agent's private key, as `keygen` printed it | `read`, `write`, `list` |
| `NEXUS_AGENT_APPROVAL` | The agent's approval, as `approve-agent` printed it | `read`, `write`, `list` |
| `NEXUS_OWNER_SECRET` | The owner's secret, the server's own `NEXUS_OWNER_SECRET`. When it is not set the command asks for it at a hidden prompt | `make-identity`, `allow`, `deny`, `owner-sign-in`, `set-up-agent` |

## The agent's commands

```
NEXUS_ADDRESS=... NEXUS_TOKEN=... NEXUS_AGENT_PRIVATE_KEY=... NEXUS_AGENT_APPROVAL=... \
  nexus-agent list                          # the paths of the notes, one a line
  nexus-agent read "Daily/2026-11-15.md"    # the note's text, exactly
  nexus-agent write "Agent/First.md" < note.md
```

`write` takes the text from standard input. Paths are checked with the rule the plugin uses
for a path from another device: a `.md` file, under no hidden folder, with no empty step,
`..`, backslash or control character.

## The library

```ts
import { AgentVault } from "./nexus-agent.js"; // the built single file, see below

const vault = await AgentVault.open({
  address: env.NEXUS_ADDRESS,               // where Nexus's routes sit
  token: env.NEXUS_TOKEN,                   // the agent's sign-in token
  privateKey: env.NEXUS_AGENT_PRIVATE_KEY,  // base64 (or the 32 bytes)
  approval: env.NEXUS_AGENT_APPROVAL,       // base64 (or the bytes)
  // fetch: the runtime's own is used when left out
  // wasm: in a Cloudflare Worker, the compiled module of nexus-agent.wasm, see "In a Cloudflare Worker"
});

await vault.write("Agent/2026-11-15 First.md", "# First\n");
const text = await vault.read("Agent/2026-11-15 First.md");
const paths = await vault.list();
await vault.remove("Agent/2026-11-15 First.md");
vault.close(); // overwrites the key
```

A writer that keeps its own note ids does not need the paths, and does not have to look at the vault. `connect` opens the
approval and checks it against the server (the vault id, and that the key opens a note: it asks for 10 notes at a time and stops
at the first that opens), and then each call sends or reads **one** note, whatever the vault holds:

```ts
const vault = await AgentVault.connect({ address, token, privateKey, approval });

const made = await vault.createNote("Agent/2026-11-15 First.md", "# First\n"); // { id, path, version: 1 }: keep the id
const done = await vault.updateNote(made.id, made.version, "# First\n\nMore.\n"); // { result: "saved", id, path, version: 2 }
const late = await vault.updateNote(made.id, made.version, "# Stale\n");           // { result: "changed-since", id, current: 2 }
const note = await vault.readNote(made.id);                                         // { id, path, version: 2, text }
```

It uses no Node module: only `fetch`, `atob`/`btoa`, `TextEncoder` and `crypto.getRandomValues`,
so one file runs in Node 22 and in a Cloudflare Worker. A Worker's secrets are strings, which
`privateKey` and `approval` take as they are.

- **The key stays in memory.** It is held in a private field, never logged, never written, and
  never in an error message. `close()` overwrites it. (JavaScript cannot wipe a string, so a
  key passed in as a string stays in the runtime's memory as long as the runtime keeps that string.)
- **`open` refuses** with an `AgentError` (a `code` and a plain message) when the private key
  does not open the approval, when the approval is for another vault than the one the server
  holds, and when the key opens none of the notes the vault already holds. It writes nothing.
  A vault with no note in it cannot show a wrong key, so the first note written there is the
  first proof. `connect` refuses all three the same way, before anything is written, without looking at the whole vault.
  A single note that does not open, or whose path the plugin would refuse, is `unreadable` to `readNote` and `updateNote`.
- **Notes are found by path.** The server knows a note only by a random id: the path is inside
  the encrypted note. The first look at a vault asks Nexus for the newest version of each note
  (`GET /heads`), 100 notes at a time, opens each note to learn its path and keeps only its
  id, its version and its path: the note's text is not kept, and at most one page of encrypted
  notes is held at once, so a vault of thousands of long notes can be opened inside a Worker's
  memory. Every later call asks only for what changed (`GET /changes`). A text is read from Nexus
  when a call needs it (`read`, and the comparison a `write` makes), one note at a time. A server
  that has no `/heads` route is read through its changes feed instead, which gives the same answer
  and is slower and heavier. A note that does not open, or has a path the plugin
  would refuse, is left out of `list` (`unreadableNotes()` says which ids). When two notes share a
  path, the one saved last is the one a path means. `listNotes()` is `list` with each note's id and version.
- **By id, nothing else is touched.** `createNote(path, text)` sends one new note and does not look to see
  whether another note is already at that path: two notes at one path are two ids, and the plugin gives the path to
  the one with the smaller id and moves the other aside (`write`, which does look, does the same). `readNote(id)` reads one
  note, and `updateNote(id, version, text)` saves the next version **only if the note is still at `version`**: when it
  is not, the answer is `changed-since` with the version it is at, and nothing is changed, merged or overwritten. A note
  that was deleted is at a newer version, so `updateNote` never brings one back. The note keeps its path;
  `updateNote` reads the version it is given once to learn the path, unless this vault made, read or saved the note just before.
- **A write never overwrites a newer text blind.** A save names the version it started from. When
  Nexus says the note is at another version (409) the library reads that version and puts the
  agent's change on top of it with the same three-way line merge the plugin uses, from the text
  the write began with, then saves from the version it read. If both changed the same lines, nothing
  is merged: the agent's text is kept as a second note beside the first,
  `<name> (duplicate agent 2026-11-15).md`, which the plugin takes as an ordinary note. The result
  says which happened (`merged`, `duplicate`). A note that keeps changing under the write ends in an
  error after a few rounds, with nothing more written. Two new notes made at one path at the same
  moment have different ids, so Nexus cannot tell them apart. The plugin's rule is that the smaller id keeps the
  path and the writer that holds the other one acts, so the agent does the same: when its new note has the
  larger id it moves it to a duplicate path (or drops it, if the two texts are the same), and when it has the
  smaller id it leaves the other writer to do that.
- **`remove` refuses** a note that changed since it was last looked at (`changed`), so a newer text is
  never deleted unseen.
- **One call runs at a time** on a vault.

## The built file

```
npm run build --workspace @nexus/agent     # after @nexus/crypto is built; the repository's `npm run build` does both
```

makes `dist/nexus-agent.js`: the library as **one ES module that imports nothing** (the
encryption, libsodium's WebAssembly and the merge are inside it), `dist/nexus-agent.wasm`: that same
WebAssembly as a file of its own, and `dist/cli.js`, the command. The build prints the SHA-256 of each
file in the form `sha256sum -c` reads:

```
<64 hex characters>  nexus-agent.js
<64 hex characters>  nexus-agent.wasm
<64 hex characters>  cli.js
```

Another repository can copy `nexus-agent.js` and `nexus-agent.wasm`, pin them, and check them against those
checksums. The same sources always make the same files, and the build test pins the checksums, so a change to
what is copied is a change someone has looked at. The tests build the files, check that the library names no
Node module, run it in a V8 context with only a Worker's web platform (no `require`, `process` or `Buffer`),
round-trip a note against the real server code, and run it in workerd, the runtime Cloudflare's Workers run on.

### In a Cloudflare Worker

A Worker will not make code from bytes: `WebAssembly.instantiate(bytes)` fails there with "Wasm code generation
disallowed by embedder". libsodium inside the library does exactly that when it is left to itself, so the library
takes its WebAssembly as a module that was compiled before the Worker started, which is what importing a `.wasm`
file gives a Worker:

```ts
import { AgentVault } from "./nexus-agent.js";
import wasm from "./nexus-agent.wasm"; // a WebAssembly.Module, in a Worker

const vault = await AgentVault.connect({ address, token, privateKey, approval, wasm });
```

The `.wasm` file is the very bytes that are also inside the library as text (the build test compares them), so
the two cannot differ. Without `wasm` the library starts libsodium from the text inside the file, as it always
did, which is what Node does. Only the first vault opened in a runtime uses `wasm`: libsodium starts once.

## The key steps the plugin shares

`create-vault` and `approve-agent` do their key steps (make the vault, the vault id and the Recovery Key, check the
last group typed back, lock the vault key under the Recovery Key, read the Recovery wrap Nexus holds and open it with a
typed key, seal an approval to an agent's public key) through one file, `src/setup.ts`. It does no input or output of its
own. The Nexus plugin's setup controller takes the same file as `@nexus/agent/setup`, so the command and the plugin make a
vault and an agent's approval the same way, and what each prints is the same as before. The file is not part of the built
library: an agent imports the vault, and a person's tools import the steps.

## Limits

- One vault per server, and one vault key per agent approval. An agent sees every note its person
  sees: there is no folder-only agent in version 1.
- The first `open` of a vault still reads and opens every note once, to learn the paths, a page at a time. It holds only the
  ids, versions and paths, not the texts, but it takes a request for every 100 notes, so a Worker that has a limit on
  subrequests needs `connect` and its own note ids for a very large vault. A path index kept in the vault is later work.
- `create-vault` needs a terminal. It will not run piped or redirected, so the Recovery Key is never
  written anywhere by the command.
- Revoking an agent's token stops it reading and writing from then on. It does not make the agent
  forget a key it already holds: that is rotating the vault key, which is later work.

## Develop

```
npm ci                                       # at the repository root: this package is one workspace of it
npm run build --workspace @nexus/crypto      # the package builds against the encryption library's built file
npm test --workspace @nexus/agent
npm run typecheck --workspace @nexus/agent
```
