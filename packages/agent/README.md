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

Each step is run by the person, in their own terminal. Nothing here is run by an agent.

1. **Sign in as the owner.** `nexus-agent sign-in --identity <the owner's name>` starts the
   device sign-in every device uses. Open the link it prints, signed in as the owner, check the
   code, and allow it. The token is printed once: that is the owner's `NEXUS_TOKEN` below.
2. **Set up the vault** on a server that has none: `nexus-agent create-vault`. It makes the
   vault key, the vault id and the Recovery Key, and shows the Recovery Key **on this terminal
   only** (not into a pipe or a file). Write it down in your password manager. It asks you to
   type the last four characters back before it sends anything. It then keeps the Recovery wrap
   and the vault id on the server. It refuses a server that already has a wrap, a wrong
   type-back, and a token that is not the owner's.
3. **Make the agent's key pair:** `nexus-agent keygen`. It prints the private key and the
   public key, each on its own labelled line, and a short code for the public key. Save the
   private key in your secrets manager now: it is shown once.
4. **Sign the agent in:** `nexus-agent sign-in --identity <the agent's identity> --label <name>`
   as in step 1, and save the token it prints. (The identity is one the owner made with kind
   `agent`.)
5. **Approve the agent:** `nexus-agent approve-agent` asks for the agent's public key (paste the
   `PUBLIC KEY` line from step 3) and for the Recovery Key at a **hidden** prompt. It fetches
   the Recovery wrap and the vault id from the server, opens the vault key, seals it to the
   agent's public key and **prints the approval**. Save it beside the agent's private key. The
   server never sees it. A wrong or mistyped Recovery Key is refused and nothing is printed.

A key is never an argument to any command: it would show in the process list and in the shell's
history. The Recovery Key is typed at a hidden prompt (or piped in on standard input, which
is how a secrets manager can feed it) and the others come from the environment.

## The environment

| Variable | What it is | Read by |
| --- | --- | --- |
| `NEXUS_ADDRESS` | The address Nexus's routes sit under, such as `https://nexus.example.org/nexus/api` (the same address the Obsidian plugin takes) | every command except `keygen` |
| `NEXUS_TOKEN` | A sign-in token: the owner's for `create-vault` and `approve-agent`, the agent's own for `read`, `write` and `list` | all but `keygen` and `sign-in` |
| `NEXUS_AGENT_PRIVATE_KEY` | The agent's private key, as `keygen` printed it | `read`, `write`, `list` |
| `NEXUS_AGENT_APPROVAL` | The agent's approval, as `approve-agent` printed it | `read`, `write`, `list` |

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
});

await vault.write("Agent/2026-11-15 First.md", "# First\n");
const text = await vault.read("Agent/2026-11-15 First.md");
const paths = await vault.list();
await vault.remove("Agent/2026-11-15 First.md");
vault.close(); // overwrites the key
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
  first proof.
- **Notes are found by path.** The server knows a note only by a random id: the path is inside
  the encrypted note. The first `open` reads and opens every note once, to learn the paths, and
  every later call asks only for what changed. A note that does not open, or has a path the plugin
  would refuse, is left out of `list` (`unreadableNotes()` says which ids). When two notes share a
  path, the one saved last is the one a path means.
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
encryption, libsodium's WebAssembly and the merge are inside it) and `dist/cli.js`, the
command. The build prints the library file's SHA-256 in the form `sha256sum -c` reads:

```
<64 hex characters>  nexus-agent.js
```

Another repository can copy `nexus-agent.js`, pin it, and check it against that checksum. The same
sources always make the same file. The tests build it, check that it names no Node module, run it
in a V8 context with only a Worker's web platform (no `require`, `process` or `Buffer`) and round-trip
a note against the real server code.

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
- The first `open` of a large vault reads and opens every note. A path index kept in the vault is later work.
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
