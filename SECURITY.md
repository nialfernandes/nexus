# Reporting a security flaw in Nexus

If you think you have found a security flaw in Nexus, please report it
privately, through GitHub's private vulnerability reporting, and please do not
open a public issue, pull request or discussion about it. A public post tells
everyone about the flaw before there is a fix.

**To report a flaw:** go to the [Security tab of this repository](https://github.com/nialfernandes/nexus/security),
choose **Report a vulnerability**, and fill in the form. The direct address of
the form is <https://github.com/nialfernandes/nexus/security/advisories/new>.
Only you and the people who look after Nexus can see what you write there. You
need a GitHub account to use it.

## Nexus has not had an outside audit

No outside security firm has reviewed the design of Nexus or its code. That
makes your report more useful, not less, and it means you should expect to find
flaws. The [threat model](docs/THREAT-MODEL.md) says what Nexus is meant to
protect against and what it is not, and it says plainly that it has not been
audited.

## What to include

A short report with these three things is enough:

1. **What you found.** Which part of Nexus it is in, and which version or commit
   you looked at. Nexus is still being built, so please report against the
   latest code on the `main` branch.
2. **How to reproduce it.** The steps, the input, or a small piece of code that
   shows it, so that someone else can see the same thing.
3. **What an attacker gains.** Who the attacker is (for example, the person who
   runs the server, or someone watching the network), and what they can read,
   change or stop that the [threat model](docs/THREAT-MODEL.md) says they
   cannot.

Please use test data. Do not put your real notes, vault key, Recovery Key or
sign-in tokens in a report. Please test only against your own vault and your own
server, and do not try to reach anyone else's notes or data.

## What is in scope

- **The server**, in `server/`.
- **The Obsidian plugin**, in `plugin/`.
- **The agent library and the `nexus-agent` command**, in `packages/agent`: how an
  agent that holds its own key opens the vault, and how the vault is set up and an
  agent approved.
- **The linking job**, in `packages/linker`: it opens the vault as an agent, reads transcript notes, sends their text to the
  language-model endpoint its owner chooses, and writes links back. What it sends and where, and what it may write, count.
- **The shared encryption code**, in `packages/crypto`.
- **The format of the encrypted data**, described in [docs/FORMAT.md](docs/FORMAT.md).
  A weakness in the design of the format counts, as well as a mistake in the
  code that follows it.

A flaw is most clearly in scope when Nexus fails to do something the threat
model says it does: for example, the server can read a note, a name or a
folder; a changed blob is accepted; a blob can be moved to another note without
being noticed; or a device that has been revoked can still read or write.

## What is not in scope

- **The test plugin under `probe/`.** It only checks that encryption works on a
  device. It is not part of the sync, it reads none of your notes and it sends
  nothing anywhere.
- **A device that is already compromised.** If someone controls your unlocked
  device, or malware runs on it, they can read what you can read. Nexus does not
  try to defend against that. See section 4 of the [threat model](docs/THREAT-MODEL.md),
  which lists the other limits that are known and stated there.
- **Flaws in a library Nexus uses,** such as libsodium, that are not caused by how
  Nexus uses it. Please report those to the library's own maintainers. If Nexus
  uses a library in a way that makes the flaw worse, that part is in scope.

If you are not sure whether something is in scope, report it anyway. It is
better to be told.

## What happens next

The people who look after Nexus will read your report and answer you in the
private advisory. We cannot promise how fast. Please keep the details private
until we have told you that a fix is out, so that people who use Nexus have time
to update.
