// The `nexus-agent` command: which command was asked for, and what to do when it stops with a message. Everything it works with comes
// in as `io`, so the command a test runs is the command a person runs.

import { AgentError } from "../errors";
import { allow, deny } from "./allow";
import { approveAgent } from "./approve-agent";
import { createVault } from "./create-vault";
import { Stop, type Io } from "./io";
import { ENV } from "./labels";
import { keygen } from "./keygen";
import { makeIdentity } from "./make-identity";
import { listNotes, readNote, writeNote } from "./notes";
import { ownerSignIn } from "./owner-sign-in";
import { setUpAgent } from "./set-up-agent";
import { signIn } from "./sign-in";

const USAGE = `nexus-agent: set up an encrypted Nexus vault for an agent that holds its own key.

For the person, each step run in your own terminal:
  owner-sign-in --identity <owner>   your own token, made in one step with the owner secret (for create-vault and approve-agent)
  create-vault                       set up a server that has no vault: shows the Recovery Key here, only here
  set-up-agent --name <name>         the whole setup of an agent for a vault that exists: identity, key pair, token and approval,
                                     printed as the four values the agent needs (asks for the Recovery Key, hidden)

The same steps one at a time:
  make-identity --name <name> --kind agent|person|app
                                     make an identity (needs the owner secret)
  allow <code>                       allow a device's sign-in once you have typed yes (needs the owner secret)
  deny <code>                        turn a device's sign-in down, once you have typed yes (needs the owner secret)
  keygen                             make the agent's key pair (save the private key in your secrets manager)
  sign-in --identity <name>          sign in as an identity: you allow it on the approval page, the token is shown once
  approve-agent                      give an agent the vault key: asks for its public key and the Recovery Key (hidden)

For the agent, with credentials from the environment:
  read <path>                        print a note's text
  write <path>                       save the text on standard input as the note
  list                               print the paths of the notes

The environment variables are ${ENV.address}, ${ENV.token}, ${ENV.privateKey}, ${ENV.approval} and ${ENV.ownerSecret}. The owner secret is also asked
for at a hidden prompt, or read from standard input, when it is not set. A key or a secret is never an argument.
`;

/** The options any command knows. */
const OPTIONS: readonly string[] = ["identity", "label", "name", "kind"];

/** What each command takes after its name: the flags it knows and how many words it wants. */
function parse(args: readonly string[]): { flags: Record<string, string>; words: string[] } {
  const flags: Record<string, string> = {};
  const words: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (!OPTIONS.includes(name)) {
      if (/secret|token|key|approval|password/i.test(name)) throw new Stop("A secret is never an argument: it would show in the process list and in the shell's history. Run nexus-agent --help.");
      throw new Stop(`Unknown option --${name}. Run nexus-agent --help.`);
    }
    const value = inline ?? args[++at];
    if (value === undefined) throw new Stop(`--${name} needs a value.`);
    flags[name] = value;
  }
  return { flags, words };
}

/** Runs one command. Answers the exit code: 0 done, 1 stopped with a message, 2 not understood. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === "--help" || command === "-h" || command === "help") {
      io.stdout.write(USAGE);
      return command === undefined ? 2 : 0;
    }
    const { flags, words } = parse(rest);
    const only = (count: number, what = "path") => {
      if (words.length > count) throw new Stop(`${command} takes ${count === 0 ? "no words" : `one ${what}`} after it. Run nexus-agent --help.`);
    };
    switch (command) {
      case "keygen":
        only(0);
        return await keygen(io);
      case "sign-in":
        only(0);
        return await signIn(io, { identity: flags.identity, label: flags.label });
      case "owner-sign-in":
        only(0);
        return await ownerSignIn(io, { identity: flags.identity, label: flags.label });
      case "make-identity":
        only(0);
        return await makeIdentity(io, { name: flags.name, kind: flags.kind });
      case "allow":
        only(1, "code");
        return await allow(io, words[0]);
      case "deny":
        only(1, "code");
        return await deny(io, words[0]);
      case "set-up-agent":
        only(0);
        return await setUpAgent(io, { name: flags.name, label: flags.label });
      case "create-vault":
        only(0);
        return await createVault(io);
      case "approve-agent":
        only(0);
        return await approveAgent(io);
      case "read":
        only(1);
        return await readNote(io, words[0]);
      case "write":
        only(1);
        return await writeNote(io, words[0]);
      case "list":
        only(0);
        return await listNotes(io);
      default:
        io.stderr.write(`nexus-agent: ${command} is not a command.\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    // What a person is told is a fixed sentence, or Nexus's own words: never what a key, a token or an argument held.
    if (error instanceof Stop || error instanceof AgentError) {
      io.stderr.write(`nexus-agent: ${error.message}\n`);
      return 1;
    }
    io.stderr.write("nexus-agent: something went wrong that this command did not expect, so it stopped. Nothing it was working on was kept.\n");
    return 1;
  }
}
