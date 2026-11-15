// Asking a person for a line: on a terminal a hidden answer is never written to the screen, and on a pipe a line is read as it comes.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Stop } from "../src/cli/io";
import { Prompter } from "../src/cli/prompt";
import { fakeTerminal } from "./world";

const kept = () => {
  let text = "";
  return { write: (chunk: string) => ((text += chunk), true), get text() { return text; } };
};

describe("a hidden answer on a terminal", () => {
  it("is never echoed: the screen shows the question and a new line, and nothing the person typed", async () => {
    const { input, rawModes } = fakeTerminal();
    const screen = kept();
    const prompter = new Prompter(input, screen);
    const answered = prompter.line("Recovery Key (typing is hidden): ", { hidden: true });
    input.write("AB12-");
    input.write("CD34");
    input.write("\u007fX\r");
    expect(await answered).toBe("AB12-CD3X");
    expect(screen.text).toBe("Recovery Key (typing is hidden): \n");
    expect(rawModes, "the terminal's own echo was off while it was typed, and is back on after").toEqual([true, false]);
    prompter.close();
  });

  it("takes a whole key pasted in one piece, with its line end", async () => {
    const { input } = fakeTerminal();
    const screen = kept();
    const prompter = new Prompter(input, screen);
    input.write("0123-4567-89AB-CDEF\r\n");
    expect(await prompter.line("Key: ", { hidden: true })).toBe("0123-4567-89AB-CDEF");
    input.write("next line\r");
    expect(await prompter.line("Next: ")).toBe("next line");
    expect(screen.text, "a line that is not hidden is shown as it is typed").toBe("Key: \nNext: next line\n");
    prompter.close();
  });

  it("drops arrow keys and other control keys instead of taking them as text", async () => {
    const { input } = fakeTerminal();
    const prompter = new Prompter(input, kept());
    input.write("a\u001b[Ab\u001b[1;5Cc\u0001d\r");
    expect(await prompter.line("? ", { hidden: true })).toBe("abcd");
    prompter.close();
  });

  it("stops the command on Ctrl-C, with the terminal given back", async () => {
    const { input, rawModes } = fakeTerminal();
    const screen = kept();
    const prompter = new Prompter(input, screen);
    const answered = prompter.line("? ", { hidden: true });
    input.write("secret\u0003");
    await expect(answered).rejects.toBeInstanceOf(Stop);
    expect(rawModes.at(-1)).toBe(false);
    expect(screen.text).not.toContain("secret");
    prompter.close();
  });

  it("answers null on Ctrl-D with nothing typed", async () => {
    const { input } = fakeTerminal();
    const prompter = new Prompter(input, kept());
    const answered = prompter.line("? ");
    input.write("\u0004");
    expect(await answered).toBeNull();
    prompter.close();
  });
});

describe("an answer on a pipe", () => {
  it("is read a line at a time, with nothing echoed, whichever line end it has", async () => {
    const input = new PassThrough();
    const screen = kept();
    const prompter = new Prompter(input as never, screen);
    input.write("first\nsecond\r\nthird");
    input.end();
    expect(await prompter.line("1: ")).toBe("first");
    expect(await prompter.line("2: ", { hidden: true })).toBe("second");
    expect(await prompter.line("3: ")).toBe("third");
    expect(await prompter.line("4: "), "the input has ended").toBeNull();
    expect(screen.text).toBe("1: 2: 3: 4: ");
  });

  it("hands over the rest of the input as text", async () => {
    const input = new PassThrough();
    const prompter = new Prompter(input as never, kept());
    input.write("line one\nline two\n");
    expect(await prompter.line("? ")).toBe("line one");
    setTimeout(() => input.end("line three\n"), 5);
    expect(await prompter.rest()).toBe("line two\nline three\n");
  });
});
