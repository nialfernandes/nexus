# Nexus

> **Not yet audited.** Nexus has not had an outside security audit, of its
> encryption design or of its code. Do not rely on it for anything you cannot
> afford to lose until it has. What it is meant to protect against, and what it is
> not, is written down in the [threat model](docs/THREAT-MODEL.md).
>
> **Not for real notes yet.** The server that exists today stores notes as plain
> text, and whoever runs it can read them. The encrypted server has not been built.
> Until it has, do not use Nexus for notes you want to keep private.

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

## Read before you trust it

- [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md): who Nexus defends against, what
  the server can and cannot see, and what is out of scope.
- [docs/FORMAT.md](docs/FORMAT.md): the format of the encrypted data.

## Security

Found a flaw? Please report it privately and do not open a public issue. How to do
that, and what is and is not in scope, is in [SECURITY.md](SECURITY.md).

## Licence

Nexus is open source under the MIT licence. See [LICENSE](LICENSE).
