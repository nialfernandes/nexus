# Nexus for Obsidian

> **Not yet audited.** Nexus has not had an outside security audit, of its
> encryption design or of its code. Do not rely on it for anything you cannot
> afford to lose until it has. What Nexus is meant to protect against, and what it
> is not, is written down in the [threat model](../docs/THREAT-MODEL.md).
>
> **Encrypts on your device.** This version encrypts every note on your own
> device before it is sent, name and folder included, and only opens notes on your
> device, so your Nexus server holds scrambled data. The screens that make the vault
> key, show you the Recovery Key once, unlock the vault and add another device are
> in the plugin (see "The screens" below). Until the vault is unlocked on a device
> the plugin has no key and syncs nothing: its status line says the vault is
> locked.

An Obsidian plugin that keeps every note in a vault in step with a Nexus server,
both ways, on desktop and on mobile. You run the server yourself and tell the
plugin where it is and which user to be: the plugin has no default address and no
default user.

## What it does

- **Set up once.** A new install has no server address and no user name, and it
  sends nothing to anyone until you have entered both. Open Settings, Nexus, enter
  the **Nexus address** (the address your server's routes sit under, with no slash
  at the end) and your **User name** (the user your server knows you as). Until
  both are set, the status line says so.
- **Set up or unlock.** Settings, Nexus, Encryption, **Set up or unlock**. On the
  first device of a new vault it shows the Recovery Key once, asks you to type three of
  its groups back, and lets you choose a password as well (off by default). On a
  device that has to join a vault that exists, it asks for the Recovery Key, or for
  the password when one was set up, or for another device that is already unlocked to
  approve it.
- **Sign in once.** Settings, Nexus, Sign in. The plugin asks your server for an
  approval for that user, labelled with this device's name (and a few characters of
  its id when no name was typed), shows the link and the code and opens the link.
  Allow it on the page the link opens, while signed in to your server as that user,
  and the plugin keeps the token it is handed in Obsidian's per-device local storage, never in the
  vault's files. The token is never shown. Sign out forgets it. A sign-in belongs to the
  address and user it began with: if you change either while it waits, it is dropped and no
  token is kept.
- **First sync.** Notes only in Nexus come down, notes only in the vault go up, and
  a note in both with different text is a clash. Nothing is deleted on a first sync.
  On a first sync a note in the vault and a note in Nexus are the same note when they
  have the same path.
- **Every note is encrypted on your device.** What leaves the device for each note is
  a random id, the number of the vault key, and one encrypted blob that holds the
  note's path and text. Nexus cannot read a note, merge two edits or search. What
  comes down is opened on your device with the vault key: a blob that does not open
  (changed, from another vault, another note or another key) is never shown and never
  written into your vault. The note you have is left as it is, the status line names
  the note's id, and the plugin tries it again on the next sync.
- **A note keeps its id.** The id is made at random the first time a note is synced and
  kept on this device beside the note's path. A rename or a move sends the new path
  inside a new encrypted version of the same note; the id never changes.
- **Ongoing sync, both ways.** An edit goes up three seconds after typing stops.
  Changes made in Nexus come down when Obsidian starts, every 30 seconds while it is
  open, and when the app comes back to the front. A rename or delete in the vault
  becomes a rename or delete in Nexus, and the other way round.
- **Merging happens here.** Nexus refuses a save that did not start from the note's
  latest version. The plugin then reads the note as it is now (and the version it
  started from), merges the two edits line by line on your device, and saves again.
- **Only notes.** Markdown files outside hidden folders. The `.obsidian` folder
  (where Obsidian and its plugins keep their settings) and attachments are never
  sent. A path that comes down from Nexus that is not a note, or that names a place
  outside your notes, is never written.
- **A clash never loses anything.** When two edits touch the same line, the vault's
  text is kept in a sibling note named `<name> (clash <device> <date>).md`, Nexus's
  text goes into the note, and a notice names both. Merge by hand, then delete the
  copy. Edits that do not touch the same lines are merged without a clash. If two
  devices each make a different note at one path, the note with the smaller id keeps
  the path, and the device that holds the other moves it to
  `<name> (duplicate <device> <date>).md`, an ordinary note that is synced like any
  other, so both texts are in Nexus and on every device. If the two texts are the same,
  the second note is dropped.
- **The engine can search the vault on your device.** The plugin keeps a small in-memory index of the
  words in your notes (never written to disk, rebuilt when the plugin starts), because Nexus cannot search
  notes it cannot read. It works with no key unlocked and no network. This version has no search screen,
  on purpose: inside Obsidian its own search already reads your files, so the index is for a way in that has
  no files to read, such as the web page that is planned. The engine answers `search(query)`.
- **A status line** in the settings tab and, on desktop, the status bar: the time of
  the last sync, or what went wrong in plain words (not set up, signed out, locked,
  offline, a note Nexus would not take, a note that did not open).

It uses only Obsidian's own APIs (`requestUrl`, the vault and its events, `Notice`,
the settings tab), with no Node or Electron module, so it runs on an iPhone.

## Build and test

```
npm ci                # at the repository root: installs every package, this one included
npm run check         # at the root: builds the encryption package, then checks every package
```

The plugin is one workspace of the repository's root `package.json`, with the
encryption package (`packages/crypto`), the merge package (`packages/merge`) and the
server, so one `npm ci` at the root installs them all. `npm run check` at the root
checks that the CI workflows' actions are pinned to commit hashes, runs the tests of the
release scripts (see "Making a release"), builds the
encryption package, type-checks every package, builds `main.js` from the
TypeScript in `src/`, and runs every package's tests, the plugin's among them. The
encryption package has to be built before the plugin's own `npm run typecheck`, `npm
test` or `npm run build`, since the plugin takes it from its built file: run `npm run
build --workspace @nexus/crypto` at the root once. `npm run build` in this folder
alone makes the three files in `dist/`.
`npm run build` in this folder writes the three files Obsidian loads, and a person
copies into a vault, into `dist/`: `main.js` (built from `src/`), `manifest.json` and
`styles.css` (both kept in this folder and copied as they are). The manifest's version
is `0.3.0`.

- `npm test` runs the tests. They run the sync engine and the sign-in against the
  real Nexus server from this repository's `server/` folder, running inside the test
  over an in-memory SQLite database (`tests/real-nexus.ts`, which takes the SQL port
  over node:sqlite from the shared test package, `packages/test-sqlite`), so no server has
  to be running. They need Node 22.13 or later, for `node:sqlite`, which prints an
  "experimental" warning that can be ignored. The tests are pinned to the server as
  it is in this repository: when the server changes what it holds or answers, they
  move along with it. The server holds only blobs, so the tests make and open blobs
  themselves with the encryption package, under a vault key they hold in memory
  (`tests/test-unlock.ts` is the test-only fill for the unlock port).
  One test runs `npm run build` and checks that the bundle asks for no Node or
  Electron module.
- `npm run typecheck` type-checks everything, the plugin's entry (`src/main.ts`) and
  settings tab (`src/settings.ts`) included, and the tests.

## Where the key comes from

The sync engine never makes or stores a key. It asks the unlock port
(`src/unlock.ts`) for the vault key, the vault id and the key number each time it
has to encrypt or open a note. The port is the key holder (`src/key-holder.ts`): one
object that starts locked. The key is held in memory only while unlocked, and nothing
in this plugin writes it to disk. Locking the vault, or the plugin unloading, drops
the key and overwrites its bytes with zeros, and so does signing out, and so does changing the
Nexus address or the user name, because the key belonged to the other vault.

The setup controller (`src/vault-setup.ts`) is what puts the key in the holder. It
is a plain state machine with no look and no screen of its own: a screen reads its
state and calls one event when the person does something. The comment at the top of
the file names every state and every event in plain words. It covers:

- **First run, with no vault on your server.** It makes the vault key, the vault id
  and the Recovery Key, and shows the Recovery Key. The person types back three of its
  fourteen groups, chosen at random, with as many tries as they need. Then the person
  chooses whether the vault also opens with a password. Only then does it send the
  Recovery wrap, with the vault id, then the password wrap if one was asked for, and
  unlock. Nothing is sent before that, and going back to the key shows the same key.
- **A vault exists and this device has the Recovery Key.** It reads the vault id and
  the Recovery wrap from Nexus, opens the wrap with the key typed, and unlocks. A key
  that is wrong, or not whole, is refused with a plain message and nothing is kept.
  When Nexus holds a password wrap, the password opens it the same way.
- **A new device, approved from another.** The two-code exchange below, as states:
  waiting, type the matching code, unlocked or refused.
- **This device approves another device,** with the device code typed here, and nothing
  else: the one code the new device shows. This device finds the new device from it.
- **This device approves an agent.** The person pastes the agent's public key, and
  the controller seals the vault key to it and shows the approval, for the person to save beside the agent's
  private key. It is the same text `nexus-agent approve-agent` prints, so either can be used, and it is never sent through Nexus.
- **Locked or unlocked,** the status the plugin already shows.

Every key step is the shared one in `packages/agent` (`@nexus/agent/setup`), the code the
`nexus-agent` commands `create-vault` and `approve-agent` also call, or the approval engine's
(`src/approval.ts`); there is no second copy of any of them in this plugin.

The vault id comes through the same port. It is not secret: the setup makes it once, when
the vault is made, and sends it with the first wrap, so it is kept beside the wraps on your server. A device that
unlocks with the Recovery Key reads it there, and a new device is handed it in its approval. Every device of a vault
has to use the same one, because each note's encryption is bound to it. This plugin keeps it nowhere else, so the data
file still holds only the address and the user name.

## The screens

The screens (`src/screens/`) are a drawing of the setup controller's state and nothing more: what is
on screen is the controller's `state`, and what the person does is one call to one of its events. They
have no key, no code and no check of their own. A code is one box for each character (or, for the Recovery
Key, one for each group of four), and it is checked the moment the last box is full, so there is no
Approve, Check or Unlock button. Anything a device sent, such as the name it signed in with, is put on a
screen as text and never as markup. Opening them is **Set up or unlock** and **Approve a device** in the
Encryption row of the settings tab, and the commands of the same names.

They are shown in Obsidian's own modal, on a phone and on a desktop, and are styled by `styles.css`, which
writes every colour, radius and size once, as a token, at its top. The type faces they are drawn in
(Unbounded, Instrument Sans and JetBrains Mono) are written into `styles.css` as base64 `@font-face` rules, so
the screens look as drawn on a device that has none of them. Each is cut down to the weights and the Latin letters
the screens use (about 41 KB of font files in all, 55 KB as base64), and its licence (the SIL Open Font License
1.1, with its copyright line) is written beside it in the same file, because the licence asks that it travels with
the font and a plugin is three files. The fonts are the ones the approval page serves, in
`server/public/nexus/fonts`; `python3 plugin/tools/embed-fonts.py` (needs `pip install fonttools brotli`) writes
the block again, and only the block, if a font or a weight changes. `styles.css` is 86 KB with them, 15 KB before.

## Giving a new device the vault key

The engine for this is `src/approval.ts`, and the setup controller drives it as states, which the screens
above draw. A device that holds the vault key can approve a new one, so that the new device
unlocks the vault with no Recovery Key typed.

- The new device makes a key pair of its own for the attempt, keeps the private half in memory only,
  and asks to be signed in with its public key. It shows one code, its **device code**, which is the code of that key.
- The approving device is unlocked and signed in as the owner. The person types the device code, and only that. This device asks
  Nexus which sign-ins are waiting and for the public key of each, works out each key's code itself, and takes the sign-in whose
  key has the code typed. It goes on only if there is one, so a server that swapped the new device's key for its own is not sent the
  vault key: the swapped key has another code. Otherwise it seals the vault key to the
  new device's key and leaves that with Nexus, which cannot open it, hands it over once and deletes it.
  The approving device shows a **matching code**.
- The new device works out the matching code from both devices' keys and what it was handed. It uses nothing
  it was handed, not the token and not the key, until the person types the approving device's code on
  it and it is the same. An approval a server made or swapped gives a different code and is refused. The
  approval itself (`src/approval.ts`) allows three wrong matching codes and then closes, key and all, so the setup
  controller and any other caller get the same limit.

The derivation of both codes is in [docs/FORMAT.md](../docs/FORMAT.md) section 7.4. The vault key goes to the
unlock port and nowhere else; nothing here writes a key or an approval to disk.

## Install through BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs a plugin straight from
a GitHub release, and updates it when there is a newer one. It works on desktop and on
mobile, and there is nothing to build and no folder to make.

1. In Obsidian, open Settings, Community plugins (turn community plugins on if they are
   off), choose Browse, and install the plugin **BRAT** (its full name is Obsidian42 -
   BRAT). Turn it on.
2. Open BRAT's settings and choose **Add beta plugin**.
3. Enter the path of this repository, in the form `owner/name`, as it appears in the
   address bar of this page, and confirm. BRAT installs the latest release.
4. Turn on **Nexus** under Community plugins, then set it up and sign in from its
   settings (see "Set up once" above).

BRAT checks for a newer release and updates the plugin by itself, so these steps are done
once on each device.

BRAT installs from a release, not from a folder of the repository. A release of this
plugin carries `main.js`, `manifest.json` and `styles.css` from `dist/`, with a tag that
is the version in `manifest.json` (for example `0.3.0`). The repository's release
workflow (`.github/workflows/release.yml`) makes it, from the tagged commit, when the
maintainer pushes the tag, and it makes none when the tag is not that version. The test
plugin in `probe/` is a separate plugin and is not released by it: BRAT reads one list
of releases for the whole repository, so each release carries the files of one plugin.

## Install by copying the files

Use this where BRAT cannot be used. The release is the same one.

1. On this repository's page on GitHub, open **Releases**, open the latest release and
   download its three files, `main.js`, `manifest.json` and `styles.css`.
2. Put the three files in the folder `<vault>/.obsidian/plugins/nexus/` of your vault,
   making the folders that are not there. The last folder's name has to be `nexus`, the
   plugin's id.
3. In Obsidian, Settings, Community plugins, turn on **Nexus** (turn on community
   plugins first if they are off).

On an iPhone the vault is a folder in the Files app, and the Files app does not show
folders that start with a dot, so the `.obsidian` folder inside the vault is out of
sight there. The way through the Files app is the vault's own sync: put the `nexus`
folder (with `main.js`, `manifest.json` and `styles.css`) into `<vault>/.obsidian/plugins/` on a
computer, let the vault reach the phone through iCloud Drive in the Files app, then
restart Obsidian on the phone and turn on **Nexus** under Community plugins.
Installing through BRAT on the phone needs none of this, so use it when you can.

## Making a release

For whoever maintains the repository. A release is one command and one tag:

```
npm run release:bump -- 0.3.1    # at the repository root: patch, minor or major work too
git commit -am "chore(plugin): release 0.3.1"
git tag 0.3.1                    # the tag is the version, with no "v"
git push origin main 0.3.1
```

The bump (`.github/release/bump-version.mjs`) gives the new version to `manifest.json`
and `versions.json` together (and to this folder's `package.json`, the lockfile and the
two places in this README that name it, which the plugin's tests want to match), and
adds `--min-app 1.9.0` when the oldest Obsidian the plugin runs on has changed. It
changes nothing when the version is not later than the manifest's. Pushing the tag runs
the release workflow, which checks that the tag is the manifest's version (and stops
before building when it is not), builds the plugin with the repository's own build,
checks that `dist/` holds exactly `main.js`, `manifest.json` and `styles.css`, and
makes the release with those three files. `versions.json` is Obsidian's list of the
oldest Obsidian each plugin version runs on.

## Good to know

- What the plugin keeps is split by whose it is. `data.json` in
  `<vault>/.obsidian/plugins/nexus/` holds only the Nexus address and the user name,
  which are the same everywhere. The token, this device's id and name, the changes
  cursor and what is known of every note (its id, its version and a fingerprint of
  its text) are kept in Obsidian's per-device local storage, not in the `.obsidian`
  folder or anywhere else in the vault. So a vault that iCloud (or anything else)
  syncs between a Mac and an iPhone never shares a token or a set of versions between
  them: sign each device in on its own. A device that kept its notes by path, from
  before notes were encrypted, starts again as one that has never synced.
- Changing the address or the user name signs the vault out and starts the sync over:
  the next sign-in brings the vault and Nexus together again, and deletes nothing.
- A device is named after its platform (iPhone, Mac and so on); a text field in the
  settings changes it. A sign-in carries that name to Nexus, with a few characters of
  the device's id added when you have not typed a name, so two phones can be told
  apart when you revoke one.
- A clash copy stays in the vault it was made in and is never sent to Nexus. Rename
  it to something else once you have merged it and it becomes an ordinary note.
- A note Nexus refuses (one too big for it to keep, for example) is named in the status
  line and not sent; it does not stop the other notes, and stays named until the note is
  dealt with.
- A note from Nexus that this vault cannot write (a locked file, a name the system
  refuses) is named in the status line and tried again on every sync until it can be
  written. It does not stop the notes after it.
- A note is removed from the vault only when Nexus says it is gone: it answers 404 for
  that note, or its changes carry a delete for it. A refusal, a fault in Nexus, a lost
  sign-in, a blob that does not open or no network never removes a note: it stays as
  it is, the status line says what happened, and the plugin asks for it again on the
  next sync.
- Needs Obsidian 1.8.7 or newer.
- A note deleted while Obsidian is closed is not deleted from Nexus: only a delete the
  plugin sees is sent.
- Editing a note on two devices at once is safe: the edits are merged, or both texts are
  kept (see clashes above).
- A note's name and folder are inside the encrypted blob, so Nexus has no folders to
  show and no path to check: a note's path is whatever the last device to save it wrote.

## Licence

MIT, as the rest of Nexus. See [LICENSE](../LICENSE).
