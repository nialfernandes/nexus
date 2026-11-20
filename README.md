# Nexus

> **Not yet audited.** Nexus has not had an outside security audit, of its
> encryption design or of its code. Do not rely on it for anything you cannot
> afford to lose until it has. What it is meant to protect against, and what it is
> not, is written down in the [threat model](docs/THREAT-MODEL.md).
>
> **Not for real notes yet.** The server in this repository stores only the blobs
> a device sends and never reads a note, and the Obsidian plugin encrypts every
> note on your device before it sends it. The plugin has the screens that make the
> vault key, show you the Recovery Key once, unlock the vault and add another device,
> and until the vault is unlocked on a device the plugin has no key and syncs nothing:
> it says the vault is locked. The server checks only that a blob begins the way an
> encrypted one does (a plain-text save is refused), not that it really is encrypted.
> Nothing has been audited, so do not use Nexus for notes you want to keep private.

Nexus is end-to-end encrypted notes and sync that works with any notes app. It
keeps a person's notes in sync across their devices and across the assistants they
work with, so the notes can act as a second brain that every tool sees the same
way. Notes are plain Markdown text. You reach them through whichever way in suits
you: the [Obsidian plugin](plugin/) is one, a web page served by the server is
another, and a notes app of Nexus's own may follow. A small server stores each
note's versions and passes changes between devices. The server is designed to run
on any host: the first host supported is Cloudflare, and the plan is to add
others, such as a Kubernetes cluster or a single machine at home. Nexus is still
being built, and its parts are arriving in stages.

The design encrypts every note on your own device before it is sent, name and
folder included, so the server holds only scrambled data and cannot read your
notes. There is no password reset: if you lose every device and your Recovery
Key, the notes are gone. Cloud assistants are the one exception, because they
cannot hold a key, and the threat model explains what you give up if you allow one.

## Build and test

The repository is one npm workspace: the encryption (`packages/crypto`), the line merge
(`packages/merge`), the test database the server and plugin tests share
(`packages/test-sqlite`), the library and the `nexus-agent` command for an agent that holds its own key
(`packages/agent`), the linking job that joins each transcript note to the books, websites, quotes and people it mentions
(`packages/linker`), the server (`server/`) and the Obsidian plugin (`plugin/`). Node 22.13 or later is needed.

```
npm ci            # installs every package, with one lockfile
npm run check     # checks the CI actions are pinned to commit hashes, tests the audit script, builds the encryption package and the agent package, type-checks every package, builds the linking job and the plugin, runs every test
npm run check:audit   # asks npm for advisories: fails on a high or critical one in a package that ships, prints the dev-only ones (needs the network)
```

`npm run check` is what every pull request runs (`.github/workflows/check.yml`), beside
`npm run check:audit` (right after `npm ci`, and not part of `npm run check` because it needs the network),
`bash docs/check-citations.sh` and the approval page's browser spec (`npm run test:browser` in `server/`, which
needs Playwright's Chromium, so it is two steps of its own: server/README.md, "The browser spec"). `probe/` is not part of the workspace: it is a small test
plugin that ships its own built files, with its own `npm ci` and `npm run check`.

## Read before you trust it

- [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md): who Nexus defends against, what
  the server can and cannot see, and what is out of scope.
- [docs/FORMAT.md](docs/FORMAT.md): the format of the encrypted data.

## Security

Found a flaw? Please report it privately and do not open a public issue. How to do
that, and what is and is not in scope, is in [SECURITY.md](SECURITY.md).

Dependency updates come as reviewed pull requests. Each week GitHub proposes a new
version of the CI actions (with the new full commit hash, so they stay pinned) and
one grouped pull request for the npm packages, the encryption libraries included
(`.github/dependabot.yml`). The same check that every pull request runs is run on
each of them, and none is merged until a person has read it. That check fails on a
high or critical npm advisory in a package that ships (`npm audit --omit=dev
--audit-level=high`, run by `npm run check:audit`); an advisory in a tool used only
to build and test is printed and does not fail it.

## Licence

Nexus is open source under the MIT licence. See [LICENSE](LICENSE).
