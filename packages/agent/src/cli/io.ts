// What a command is given to work with, so a test can run the real command over its own streams, environment and `fetch`, and the
// process's own are handed over in one place (bin.ts).

import type { Readable } from "node:stream";
import type { FetchLike } from "../nexus";

/** A stream the command reads. A terminal also says so and can be put in raw mode, which is how a typed key is kept from showing. */
export interface Input extends Readable {
  isTTY?: boolean;
  setRawMode?: (on: boolean) => unknown;
}

export interface Output {
  write(text: string): unknown;
  isTTY?: boolean;
}

export interface Io {
  env: Readonly<Record<string, string | undefined>>;
  stdin: Input;
  stdout: Output;
  stderr: Output;
  /** The runtime's `fetch` when left out. */
  fetch?: FetchLike;
  /** Pauses between polls. */
  wait: (ms: number) => Promise<void>;
  now: () => Date;
}

/** Said by a command that has to stop with a message and no more. The message is printed to the error stream and the command exits 1. */
export class Stop extends Error {}
