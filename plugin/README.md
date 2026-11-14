# Nexus for Obsidian

> **Not yet audited.** Nexus has not had an outside security audit, of its
> encryption design or of its code. Do not rely on it for anything you cannot
> afford to lose until it has. What Nexus is meant to protect against, and what it
> is not, is written down in the [threat model](../docs/THREAT-MODEL.md).
>
> **Encrypts on your device, but cannot be unlocked yet.** This version encrypts
> every note on your own device before it is sent, name and folder included, and
> only opens notes on your device, so your Nexus server holds scrambled data. But
> the screens that make the vault key, show you the Recovery Key and unlock the
> vault are not built yet. Until they are, the plugin has no key and syncs nothing:
> its status line says the vault is locked. It is not ready for real notes.

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
- **Sign in once.** Settings, Nexus, Sign in. The plugin asks your server for an
  approval for that user, labelled with this device's name (and a few characters of
  its id when no name was typed), shows the link and the code and opens the link.
  Allow it on the page the link opens, while signed in to your server as that user,
  and the plugin keeps the token it is handed in Obsidian's per-device local storage, never in the
  vault's files. The token is never shown. Sign out forgets it.
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
cd plugin
npm ci
npm run check
```

`npm run check` builds the two packages the plugin depends on (`packages/crypto`,
which needs its own `npm ci` and a build, and `packages/merge`), type-checks,
builds `main.js` from the TypeScript in `src/` and runs the tests. Run
`npm run packages` once before `npm test` or `npm run build` on their own, since the
encryption package has to be built first. `npm run build` alone makes `main.js`.
Obsidian loads three files: `manifest.json` (kept in this folder), `main.js` (built)
and `styles.css` (this plugin has none).

- `npm test` runs the tests. They run the sync engine and the sign-in against the
  real Nexus server from this repository's `server/` folder, running inside the test
  over an in-memory SQLite database (`tests/real-nexus.ts`), so no server has to be
  running. They need Node 22.13 or later, for `node:sqlite`, which prints an
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
has to encrypt or open a note. The setup screens will fill that port in a later piece
of work; until then the plugin is given a port that never holds a key, so it sends
nothing and reads nothing. The key is held in memory only while unlocked, and nothing
in this plugin writes it to disk. The vault id comes through the same port. It is not secret: the setup
screens will make it once, when the vault is made, keep it in this plugin's data file and beside the wraps on your
server, and hand it to a new device when you approve it. Every device of a vault has to use the same one,
because each note's encryption is bound to it. This plugin does none of that storing yet.

## Install through BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs a plugin straight from
a GitHub release. It works on desktop and on mobile.

1. In Obsidian, install the community plugin **BRAT** (its full name is Obsidian42 -
   BRAT) and turn it on.
2. Open BRAT's settings and choose **Add beta plugin**.
3. Enter the path of this repository, in the form `owner/name`, as it appears in the
   address bar of this page.
4. Turn on **Nexus** under Community plugins, then set it up and sign in from its
   settings (see "Set up once" above).

BRAT installs from a release, not from a folder of the repository. This repository
also releases the test plugin in `probe/` (version 0.1.0), and BRAT reads one list of
releases for the whole repository, so each release carries the files of one plugin.
A release of this plugin carries `manifest.json` and `main.js` from this folder, with
a tag that is the version in `manifest.json` (for example `0.2.0`). Whoever maintains
the repository makes that release; BRAT checks for new ones and updates the plugin.

## Install by copying the files

1. Build it (above), or take `manifest.json` and `main.js` from the release.
2. Make the folder `<vault>/.obsidian/plugins/nexus/` and put `manifest.json` and
   `main.js` in it. The folder name has to be `nexus`, the plugin's id.
3. In Obsidian, Settings, Community plugins, turn on **Nexus** (turn on community
   plugins first if they are off).

On an iPhone the vault is a folder in the Files app, and the Files app does not show
folders that start with a dot, so the `.obsidian` folder inside the vault is out of
sight there. The way through the Files app is the vault's own sync: put the `nexus`
folder (with `manifest.json` and `main.js`) into `<vault>/.obsidian/plugins/` on a
computer, let the vault reach the phone through iCloud Drive in the Files app, then
restart Obsidian on the phone and turn on **Nexus** under Community plugins.
Installing through BRAT on the phone needs none of this, so use it when you can.

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
