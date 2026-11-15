// Asking a person for a line, and keeping a typed secret from showing.
//
// On a terminal the keys are read one at a time with the terminal's own echo off (raw mode), so a hidden answer is never written
// anywhere: not to the screen, not to the output, not into the process list. The question goes to the error stream, so what the
// command prints to its output stays clean. When the input is not a terminal (a pipe, a file) a line is read as it comes and nothing
// is echoed, which is how a secrets manager can feed the command: never as an argument.

import type { Input, Output } from "./io";
import { Stop } from "./io";

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = ["\u007f", "\b"];
const ESCAPE = "\u001b";

export class Prompter {
  readonly #input: Input;
  readonly #output: Output;
  readonly #tty: boolean;
  #buffer = "";
  #ended = false;
  #wake: (() => void) | null = null;

  constructor(input: Input, output: Output) {
    this.#input = input;
    this.#output = output;
    this.#tty = input.isTTY === true && typeof input.setRawMode === "function";
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      this.#buffer += chunk;
      this.#wake?.();
    });
    input.on("end", () => {
      this.#ended = true;
      this.#wake?.();
    });
    input.on("error", () => {
      this.#ended = true;
      this.#wake?.();
    });
  }

  /**
   * Asks `question` and answers the line typed, or null when the input ended before a line was begun. A `hidden` answer is not echoed
   * to the screen, whatever is typed. Ctrl-C stops the command.
   */
  async line(question: string, options: { hidden?: boolean } = {}): Promise<string | null> {
    this.#output.write(question);
    if (this.#tty) this.#input.setRawMode?.(true);
    let value = "";
    let began = false;
    try {
      for (;;) {
        const next = this.#take();
        if (next === null) {
          if (this.#ended) return began ? value : null;
          await this.#more();
          continue;
        }
        if (next === "\n" || next === "\r") {
          if (next === "\r" && this.#buffer.startsWith("\n")) this.#buffer = this.#buffer.slice(1);
          return value;
        }
        began = true;
        if (!this.#tty) {
          value += next;
          continue;
        }
        if (next === CTRL_C) throw new Stop("Stopped.");
        if (next === CTRL_D) {
          if (value === "") return null;
          continue;
        }
        if (BACKSPACE.includes(next)) {
          if (value !== "") {
            value = [...value].slice(0, -1).join("");
            if (!options.hidden) this.#output.write("\b \b");
          }
          continue;
        }
        if (next === ESCAPE) {
          this.#skipEscape();
          continue;
        }
        if (next < " ") continue;
        value += next;
        if (!options.hidden) this.#output.write(next);
      }
    } finally {
      if (this.#tty) {
        this.#input.setRawMode?.(false);
        this.#output.write("\n");
      }
    }
  }

  /** Everything left to read, to the end of the input. */
  async rest(): Promise<string> {
    while (!this.#ended) await this.#more();
    const text = this.#buffer;
    this.#buffer = "";
    return text;
  }

  /** Lets go of the input, so the command can end. */
  close(): void {
    this.#input.pause();
  }

  /** The next character (a whole code point), or null when none has arrived. */
  #take(): string | null {
    if (this.#buffer === "") return null;
    const next = String.fromCodePoint(this.#buffer.codePointAt(0)!);
    this.#buffer = this.#buffer.slice(next.length);
    return next;
  }

  /** Drops the rest of an arrow key's or function key's escape sequence, so it is not taken for text. */
  #skipEscape(): void {
    if (!this.#buffer.startsWith("[") && !this.#buffer.startsWith("O")) return;
    const match = /^.[0-9;]*[@-~]/.exec(this.#buffer);
    this.#buffer = this.#buffer.slice(match === null ? 1 : match[0].length);
  }

  #more(): Promise<void> {
    return new Promise((resolve) => {
      this.#wake = () => {
        this.#wake = null;
        resolve();
      };
      this.#input.resume();
    });
  }
}
