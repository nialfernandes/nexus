# Nexus probe

A small test plugin for Obsidian. It checks, on the device you run it on, that
the encryption Nexus plans to use actually works there, and how long it takes.

It is not part of the sync and it does not sync anything. It reads none of your
notes, makes no network requests and sends nothing anywhere. It writes one small
file (`data.json` in its own plugin folder) holding the last run's results, so a
run that the app cut short can still be reported.

## What it checks

When you run it (the ribbon button, or the command **Nexus probe: Run the
probe**), it runs these one after another and shows the results on one screen:

| Check | Why |
| --- | --- |
| WebAssembly exists and runs a tiny module | The encryption library is compiled to WebAssembly. |
| `crypto.subtle` exists and gives the right SHA-256 | Nexus does not depend on it, but we want to know. |
| `crypto.getRandomValues` exists | Needed for keys and nonces. |
| libsodium.js (`libsodium-wrappers-sumo`) loads | The one encryption library Nexus plans to use. |
| XChaCha20-Poly1305 encrypts and decrypts a 100 KiB note, timed | The cipher for notes. |
| XChaCha20-Poly1305 matches the published test vector | A right answer, not just a round trip. |
| XChaCha20-Poly1305 refuses a ciphertext with one bit changed | The tag check works. |
| A sealed box to a fresh X25519 key opens again | How a key is handed to another device. |
| Argon2id matches the RFC 9106 test vector (JavaScript implementation) | See the note below. |
| Argon2id, 64 MiB, 3 passes, 1 lane, by libsodium, gives the expected key, timed | The optional password step. Over 60 seconds counts as a failure. |
| scrypt (N=2^17, r=8, p=1), only if the Argon2id check above failed | The fallback the research names. |
| Argon2id in plain JavaScript, only if libsodium could not give the right key | Is Argon2id still possible with no WebAssembly, and how slow? |

The report also lists the platform, the Obsidian version and the user agent.

A note on the RFC 9106 vector: it uses 4 lanes, a secret and associated data.
libsodium's Argon2id always uses 1 lane and takes neither, so it cannot be fed
that vector. The probe therefore checks the vector with the JavaScript
implementation (`@noble/hashes`) and checks libsodium against a key that two
independent implementations agree on.

## Install with BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) is a community plugin that
installs test plugins straight from a GitHub repository.

1. In Obsidian, open **Settings, Community plugins**, install and enable **BRAT**.
2. Open BRAT's settings and choose **Add beta plugin**.
3. Enter the path of this repository, in the form `owner/name`, as it appears in
   the address bar of this page.
4. Back in **Community plugins**, enable **Nexus probe**.

BRAT installs from a GitHub release, not from a folder of the repository. So this
only works once a release exists whose tag is the version in
`probe/manifest.json` (for example `0.1.0`) and that has two files attached:
`main.js` and `manifest.json`, both taken from `probe/dist/`. Whoever maintains
the repository makes that release.

### Without BRAT

Copy `probe/dist/main.js` and `probe/dist/manifest.json` into a new folder
`<your vault>/.obsidian/plugins/nexus-probe/`, then enable **Nexus probe** in
**Community plugins**. On a phone it is easiest to put the vault in a folder you
can reach from a file manager or sync app, or to use BRAT.

## Run it and send the results back

1. Open the command palette and run **Nexus probe: Run the probe**, or tap the
   shield ribbon button.
2. Optionally type a note about the run, such as `iPhone 13, Lockdown Mode on`.
   Say whether Lockdown Mode was on: the plugin cannot tell.
3. Wait. On a slow phone the screen can freeze for a minute or more during the
   Argon2id check. Leave it alone. It is not hung.
4. Tap **Copy results** and paste them into a reply. If copying is refused, the
   text is selected: copy it by hand.

Please run it on every device you can: an iPhone with Lockdown Mode off and then
on (Settings, Privacy and Security, Lockdown Mode; it restarts the phone), an
Android phone (an older one is the most useful), and a Mac, Windows or Linux
computer. Send back one copy per device and setting.

If Obsidian closes or restarts by itself in the middle of a run, open the plugin
again: it shows how far the last run got ("the app stopped during ..."). Copy
that and send it back too. That is a result, and an important one.

## Build it yourself

```
cd probe
npm ci
npm run check    # type checks, builds into dist/, runs the tests
```

`npm run build` alone writes `dist/main.js` and `dist/manifest.json`. The build
fails if the bundle contains an import from Node or Electron, because the same
file must run on phones. The tests run the built `main.js` under Node and
check that `dist/` is up to date with the source.
