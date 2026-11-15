// The `nexus-linker` command: one pass of the job from a terminal. Everything it works with comes in as `io`, so the command a test
// runs is the command a person runs. Its settings are the environment's: a key is never an argument, which would show in the process list.

import type { FetchLike } from "@nexus/agent";
import { runJob } from "./job";
import type { ModelFetch } from "./model";
import { summaryOf } from "./run";
import { DEFAULT_MAX_CHECKS, DEFAULT_MAX_NOTES, SETTING, SettingsError, VAULT_SETTING } from "./settings";

export interface Output {
  write(text: string): unknown;
}

export interface Io {
  env: Readonly<Record<string, string | undefined>>;
  stdout: Output;
  stderr: Output;
  /** How Nexus is reached; the runtime's `fetch` when left out. */
  fetchNexus?: FetchLike;
  /** How the model is reached; the runtime's `fetch` when left out. */
  fetchModel?: ModelFetch;
}

const USAGE = `nexus-linker: join each new transcript note in the vault to the books, websites, quotes and people it mentions.

  nexus-linker run        one pass: link every transcript note not yet linked, up to ${SETTING.maxNotes} of them (${DEFAULT_MAX_NOTES} unless set)

Each thing mentioned gets one note in Mentions/, found again by its title the next time it is mentioned. The transcript note gets a
"## Mentions" section of links and the front matter line "mentions: linked", so it is never done twice. Nothing is ever deleted.

The vault is read and written as an agent, so these are set in the environment:
  ${VAULT_SETTING.address}, ${VAULT_SETTING.token}, ${VAULT_SETTING.privateKey}, ${VAULT_SETTING.approval}
and so is the job's own:
  ${SETTING.folders}            the folders of transcript notes, comma separated, such as Transcripts/
  ${SETTING.modelAddress}      the chat endpoint's address, such as https://models.example.org/v1
  ${SETTING.modelKey}          its key
  ${SETTING.modelName}         the model's name (there is no default)
and, if you want them: ${SETTING.maxNotes}, ${SETTING.maxChecks} (${DEFAULT_MAX_CHECKS} unless set), ${SETTING.modelWindow}, ${SETTING.modelTimeout}.
A key is never an argument.
`;

/** Runs the command. Answers the exit code: 0 done, 1 stopped with a message or a note that could not be linked, 2 not understood. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== "run" || rest.length > 0) {
    // What was typed is not repeated: a key given as an argument by mistake would be printed back.
    io.stderr.write(`nexus-linker: that is not a command.\n\n${USAGE}`);
    return 2;
  }
  try {
    const report = await runJob({
      env: io.env,
      log: (line) => io.stderr.write(`${line}\n`),
      ...(io.fetchNexus === undefined ? {} : { fetchNexus: io.fetchNexus }),
      ...(io.fetchModel === undefined ? {} : { fetchModel: io.fetchModel }),
    });
    for (const line of summaryOf(report)) io.stdout.write(`${line}\n`);
    return report.failed.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof SettingsError || (error instanceof Error && error.name === "AgentError")) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
