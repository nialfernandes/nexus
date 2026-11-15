// `nexus-agent read <path>`, `write <path>` and `list`: the library from a terminal. The credentials come from the environment only.

import { AgentVault } from "../vault";
import { Stop, type Io } from "./io";
import { ENV } from "./labels";
import { Prompter } from "./prompt";
import { need } from "./settings";

async function open(io: Io): Promise<AgentVault> {
  const settings = need(io, [ENV.address, ENV.token, ENV.privateKey, ENV.approval]);
  return AgentVault.open({
    address: settings[ENV.address],
    token: settings[ENV.token],
    privateKey: settings[ENV.privateKey],
    approval: settings[ENV.approval],
    now: io.now,
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
  });
}

const pathOf = (path: string | undefined, command: string): string => {
  if (path === undefined) throw new Stop(`Say which note: nexus-agent ${command} <path>.`);
  return path;
};

export async function readNote(io: Io, path: string | undefined): Promise<number> {
  const wanted = pathOf(path, "read");
  const vault = await open(io);
  try {
    io.stdout.write(await vault.read(wanted));
    return 0;
  } finally {
    vault.close();
  }
}

export async function writeNote(io: Io, path: string | undefined): Promise<number> {
  const wanted = pathOf(path, "write");
  if (io.stdin.isTTY === true) throw new Stop("Pipe the note's text in on standard input, for example: nexus-agent write Notes/a.md < a.md");
  const prompter = new Prompter(io.stdin, io.stderr);
  const text = await prompter.rest();
  prompter.close();
  const vault = await open(io);
  try {
    const done = await vault.write(wanted, text);
    if (!done.saved) io.stdout.write(`${done.path} already says that: nothing was saved.\n`);
    else if (done.duplicate) io.stdout.write(`${wanted} changed at the same lines meanwhile, so the text is kept as a second note: ${done.path} (version ${done.version}).\n`);
    else if (done.merged) io.stdout.write(`${done.path} changed meanwhile, so the change was put on top of the newer text (version ${done.version}).\n`);
    else io.stdout.write(`Saved ${done.path} (version ${done.version}).\n`);
    return 0;
  } finally {
    vault.close();
  }
}

export async function listNotes(io: Io): Promise<number> {
  const vault = await open(io);
  try {
    for (const path of await vault.list()) io.stdout.write(`${path}\n`);
    const skipped = vault.unreadableNotes().length;
    if (skipped > 0) io.stderr.write(`${skipped} note(s) in this vault could not be opened with this key, or have a path the plugin would refuse, and are not listed.\n`);
    return 0;
  } finally {
    vault.close();
  }
}
