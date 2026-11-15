# @nexus/linker

A linking job for the Nexus vault. It reads each new **transcript note**, finds the books, websites, quotes and
people the note mentions, and joins the note to **one note for each of them** in a folder called `Mentions/`. When
another episode mentions the same book, it lands on the same note, so the notes link up the way a second brain does:
open a book's note and the notes that link to it, every episode that talks about it, are its backlinks.

It is part of Nexus, not of any one writer of transcript notes. It reads and writes the vault as an agent, through
[`@nexus/agent`](../agent/README.md) (`listNotes`, `readNote`, `createNote` and `updateNote`), with a key of its own, and
it runs two ways: as a **Cloudflare Worker on a cron trigger**, and as a **command** in a terminal.

**Nexus encryption has not yet been independently audited.** See the [threat model](../../docs/THREAT-MODEL.md). The job
sends the text of a transcript to the model endpoint you choose, so that endpoint sees what the job reads.

## What it does to a note

For each transcript note in the folders you name that has not been linked yet:

1. **Finds what it mentions**, from two sources.
   - **The links in its show notes** (everything above the transcript), by a script. A link to a book's page on a
     bookshop or a book site (Amazon, Goodreads) is a **book**, titled by the words in the address and, when the show
     notes say the title in fewer words, by those. Any other web page is a **website**, named by its host and the first
     words of its path. The tracking that came on a link (`utm_source`, `fbclid` and the like) is left off. The episode's
     own page is not a mention.
   - **What is said**, by **one call to a small model** for the note's transcript. The model is any endpoint that speaks
     the common chat-completions form: its address, key and name are settings, and nothing here names a maker or picks a
     model. It is asked for a JSON list of `{ "type": "book" | "website" | "quote" | "person", "title", "author"?, "url"? }`.
     The answer is **checked against that shape and anything that does not fit is dropped**. A transcript longer than
     the model's window (`LINKER_MODEL_WINDOW_CHARS`) is sent in parts, cut between paragraphs, and the lists are joined.
2. **Makes sure each thing has its one note**, `Mentions/<title>.md`, straight in the one folder (no subfolders), with its kind
   in its details:

   ```
   ---
   type: book
   author: "[[James Clear]]"
   url: "https://www.amazon.com/dp/0735211299"
   ---
   ```

   A person has a note of their own the same way (`type: person`), and so does a book's or a quote's author. A website
   has `url:`. A quote too long for a name is named by its first words and keeps all of them as the note's text. A thing
   found by an existing note's title is **never made again**: titles are matched to the notes already in `Mentions/`
   ignoring case, accents, punctuation and a leading "The", so "the atomic habits" and "Atomic Habits." are one note. A note that
   exists gains the author or address it lacked, and nothing it had is ever changed.
   (The link is quoted, `"[[James Clear]]"`, because that is what YAML needs for a note-taking app to read the property as a link.)
3. **Writes the links back.** The transcript note gets a `## Mentions` section of `[[links]]`, before its transcript, and
   `mentions: linked` in its front matter, so it is never processed twice. The note is saved **at the version the job read**,
   so a note edited meanwhile is left alone and tried again next run. The job writes the transcript note last, after its
   Mentions notes: if anything fails before that, the transcript note is untouched.

## Safe by design

- **A model that fails, times out or answers with something that is not a list leaves the note as it was**, with the
  reason logged once, and the next run tries it again. Nothing is written for that note, not even from its links.
- **At most `LINKER_MAX_NOTES` notes a run** (10 unless set). A note that fails counts, so a failing model is asked no
  more than that a run.
- **It never deletes a note**, and the code has no call that would. It **never changes a note outside `Mentions/`
  except the `## Mentions` section and the one front matter line**; a `## Mentions` section that is already there keeps
  its lines and gains only the links it lacks. Line endings and everything else in the note stay as they were.
- The model's text is never trusted: a title has the characters a link or a path reads as syntax taken out before it is a
  note's name, so nothing it says can name a note outside `Mentions/`.
- The agent's key stays in memory. The job logs no key, token or address of a model, and a reason it gives for a failure
  is a fixed sentence.

## The settings

The same names are the environment of the command and the variables and secrets of the Worker.

| Setting | What it is | Needed |
| --- | --- | --- |
| `NEXUS_ADDRESS` | Where Nexus's routes sit, such as `https://nexus.example.org/nexus/api` | yes |
| `NEXUS_TOKEN` | The agent's sign-in token | yes (a secret) |
| `NEXUS_AGENT_PRIVATE_KEY` | The agent's private key | yes (a secret) |
| `NEXUS_AGENT_APPROVAL` | The approval sealed to the agent's public key | yes (a secret) |
| `LINKER_FOLDERS` | The folders of transcript notes, comma separated, such as `Transcripts/`. Not `Mentions/` | yes |
| `LINKER_MODEL_ADDRESS` | The chat endpoint's address, such as `https://models.example.org/v1`. The job calls `<address>/chat/completions` | yes |
| `LINKER_MODEL_KEY` | The key it is given as a bearer token | yes (a secret) |
| `LINKER_MODEL_NAME` | The model's name on that endpoint. There is no default | yes |
| `LINKER_MAX_NOTES` | The most notes a run takes on | no, 10 |
| `LINKER_MAX_CHECKS` | The most notes at a later version than the first that a run reads to see whether they were linked (see Limits) | no, 20 |
| `LINKER_MODEL_WINDOW_CHARS` | The most characters of transcript sent in one call, 500 or more | no, 12000 |
| `LINKER_MODEL_TIMEOUT_SECONDS` | How long one call may take | no, 60 |

The agent's four values are the ones `nexus-agent set-up-agent` prints (see the [agent's README](../agent/README.md)). Make the
agent for the job its own identity, such as `nexus-agent set-up-agent --name linker`.

## Running it

**In a terminal**, with the settings in the environment (a key is never an argument):

```
nexus-linker run     # one pass: up to LINKER_MAX_NOTES notes, then a summary
```

It prints what it did to each note on the error stream, and a summary to standard output. It exits 0 when the pass is done,
1 when it could not start (a setting is missing, or the vault could not be opened) or a note could not be linked, and 2 when it
is asked for something it does not know.

**As a Worker on a schedule**: copy [`wrangler.example.toml`](./wrangler.example.toml) to `wrangler.toml`, set your values, and put in
the four secrets named at the end of it with `wrangler secret put`. It wakes on its cron trigger and has no web route, so nothing can
call it. Build the repository's packages first (`npm run build` at the root), since the Worker takes the agent's built library and
its WebAssembly file.

## Limits

- **Which notes are looked at.** A note's text is inside its encrypted note, so whether it is linked cannot be told without reading it.
  A note at its first version has never been written by this job, so every note at its first version is taken as not linked and
  read. A note at a later version may be one the job linked or one a person edited first, so the job reads up to `LINKER_MAX_CHECKS`
  of them, the newest by path first. An unlinked note that was edited long ago and is older than the newest few will not be seen.
- **Names and titles.** A book found by a bookshop's address is titled by the address's words, which run on into the book's
  subtitle; the show notes' own wording is used when it is there, and the first words of the address's title are also tried against the
  notes already in `Mentions/`. A book mentioned by link in one episode and by a different form of its name in another can still end up
  as two notes, which a person can join. A page with no title in its address (a short link) is a website named by its address.
- **A note that fails every run** (a model that cannot read that transcript) is taken on each run and fills one of its places.
  The job keeps no record of failures: it adds nothing to a note it did not link.
- **A transcript note edited mid-run** has the Mentions notes the run made kept; the next run uses them and does not make them again.
  If the model words something differently the second time, the first run's note is left with no backlink.
- The job opens the vault the way the agent library's `open` does, which reads every note once to learn the paths, so a very
  large vault needs a Worker plan with room for that many subrequests (see the [agent's README](../agent/README.md)).

## Develop

```
npm ci                                       # at the repository root: this package is one workspace of it
npm run build --workspace @nexus/crypto      # the agent's build needs the encryption library's
npm run build --workspace @nexus/agent       # this package runs against the agent's built library
npm test --workspace @nexus/linker
npm run typecheck --workspace @nexus/linker
npm run build --workspace @nexus/linker      # dist/cli.js, and dist/worker.js with the WebAssembly beside it
```

The tests use the server's own code over an in-memory database, as the agent's do, a stand-in model server on a port of the
machine, and the built Worker in workerd, woken as a cron trigger wakes it.
