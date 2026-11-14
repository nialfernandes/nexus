# Nexus for Obsidian

> **Not yet audited.** Nexus has not had an outside security audit, of its
> encryption design or of its code. Do not rely on it for anything you cannot
> afford to lose until it has. This version of the plugin does not encrypt yet:
> it sends the text of each note to your Nexus server as it is, so the server can
> read it. Encrypting on your own device before anything is sent is the next
> stage of the work. What Nexus is meant to protect against, and what it is not,
> is written down in the [threat model](../docs/THREAT-MODEL.md).

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
- **Ongoing sync, both ways.** An edit goes up three seconds after typing stops.
  Changes made in Nexus come down when Obsidian starts, every 30 seconds while it is
  open, and when the app comes back to the front. A rename or delete in the vault
  becomes a move or delete in Nexus, and the other way round.
- **Only notes.** Markdown files outside hidden folders. The `.obsidian` folder
  (where Obsidian and its plugins keep their settings) and attachments are never
  sent.
- **A clash never loses anything.** When two edits touch the same line, the vault's
  text is kept in a sibling note named `<name> (clash <device> <date>).md`, Nexus's
  text goes into the note, and a notice names both. Merge by hand, then delete the
  copy. Edits that do not touch the same lines are merged by Nexus without a clash.
- **A status line** in the settings tab and, on desktop, the status bar: the time of
  the last sync, or what went wrong in plain words (not set up, signed out, offline,
  not allowed).

It uses only Obsidian's own APIs (`requestUrl`, the vault and its events, `Notice`,
the settings tab), with no Node or Electron module, so it runs on an iPhone.

## Build and test

```
cd plugin
npm ci
npm run build
```

This makes `main.js` from the TypeScript in `src/`. Obsidian loads three files:
`manifest.json` (kept in this folder), `main.js` (built) and `styles.css` (this
plugin has none).

- `npm test` runs the tests. They run the sync engine and the sign-in against the
  real Nexus server from this repository's `server/` folder, running inside the test
  over an in-memory SQLite database (`tests/real-nexus.ts`), so no server has to be
  running. They need Node 22.13 or later, for `node:sqlite`, which prints an
  "experimental" warning that can be ignored. The tests are pinned to the server as
  it is in this repository: when the server changes what it holds or answers, they
  move along with it.
  One test runs `npm run build` and checks that the bundle asks for no Node or
  Electron module.
- `npm run typecheck` type-checks everything, the plugin's entry (`src/main.ts`) and
  settings tab (`src/settings.ts`) included, and the tests.
- `npm run check` runs all three.

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
  cursor and the version of every note are kept in Obsidian's per-device local
  storage, not in the `.obsidian` folder or anywhere else in the vault. So a vault
  that iCloud (or anything else) syncs between a Mac and an iPhone never shares a
  token or a set of versions between them: sign each device in on its own.
- Changing the address or the user name signs the vault out and starts the sync over:
  the next sign-in brings the vault and Nexus together again, and deletes nothing.
- A device is named after its platform (iPhone, Mac and so on); a text field in the
  settings changes it. A sign-in carries that name to Nexus, with a few characters of
  the device's id added when you have not typed a name, so two phones can be told
  apart when you revoke one.
- A clash copy stays in the vault it was made in and is never sent to Nexus. Rename
  it to something else once you have merged it and it becomes an ordinary note.
- A note Nexus refuses (a user that may not write there) is named in the status line
  and not sent; it does not stop the other notes, and stays named until the note is
  dealt with.
- A note from Nexus that this vault cannot write (a locked file, a name the system
  refuses) is named in the status line and tried again on every sync until it can be
  written. It does not stop the notes after it.
- A note is removed from the vault only when Nexus says it is gone: it answers 404 for
  that note, or its changes carry a delete for it. A refusal, a fault in Nexus, a lost
  sign-in or no network never removes a note: it stays as it is, the status line says
  what happened, and the plugin asks for it again on the next sync.
- Needs Obsidian 1.8.7 or newer.
- A note deleted while Obsidian is closed is not deleted from Nexus: only a delete the
  plugin sees is sent.
- Editing a note on two devices at once is safe: both texts are kept (see clashes
  above).

## Licence

MIT, as the rest of Nexus. See [LICENSE](../LICENSE).
