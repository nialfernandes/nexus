// Looking for what must not be anywhere: a note's path, its folder, its file name and its text, in the plain and in each way they
// could be written down (escaped for JSON, escaped for an address, or as base64 or hex). The same shapes the server's own no-plaintext
// test searches for (server/src/no-plaintext.test.ts), so the two sides are held to the same promise.

const shapesOf = (text: string): string[] => {
  const utf8 = Buffer.from(text, "utf8");
  return [
    text,
    JSON.stringify(text).slice(1, -1),
    encodeURIComponent(text),
    utf8.toString("base64"),
    utf8.toString("base64").replace(/=+$/, ""),
    utf8.toString("hex"),
  ];
};

/** What must be nowhere for these notes: each path, folder, file name, name, line of text and whole text, in every shape. */
export function needlesFor(notes: Array<{ path: string; text: string }>): string[] {
  const found: string[] = [];
  for (const note of notes) {
    const folder = note.path.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/")) : "";
    const file = note.path.slice(note.path.lastIndexOf("/") + 1);
    const name = file.replace(/\.md$/, "");
    found.push(...[note.path, folder, file, name].filter((part) => part.length > 2).flatMap(shapesOf));
    found.push(...note.text.split("\n").filter((line) => line.length > 6).flatMap(shapesOf));
    found.push(...shapesOf(note.text), ...shapesOf(JSON.stringify({ path: note.path, text: note.text })));
  }
  return [...new Set(found)];
}

/** The needles found in a text, so a failure says which. */
export const foundIn = (haystack: string, needles: string[]): string[] => needles.filter((needle) => haystack.includes(needle));
