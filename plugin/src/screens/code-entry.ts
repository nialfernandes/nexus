// What a code field is, with no look and no element: a row of boxes, each holding up to `capacities[i]` characters, typed into one at a
// time or pasted into all at once. A code is one box per character (the sign-in code, the device code, the matching code, the three
// groups of the Recovery Key that are typed back), and the Recovery Key itself is one box per group of four. Typing the last character,
// or pasting the whole code into any box, is a complete entry: the screen then asks the controller to check it, so there is no button.
//
// Only letters and digits are taken. Capitals and small letters both count (small ones are shown as capitals), and spaces and hyphens
// are ignored, so a code can be pasted as it was written. The controller reads the text the same way (O as 0, I and L as 1).

/** The characters a code takes out of whatever was typed or pasted: capitals and digits, nothing else. */
export const codeCharacters = (typed: string): string => typed.toUpperCase().replace(/[^0-9A-Z]/g, "");

/** What an edit did, for the screen to act on: the box to put the caret in, and whether the entry is now whole. */
export interface Edit {
  /** The box that should have the caret now. */
  focus: number;
  /** Every box is full. */
  complete: boolean;
}

export class CodeEntry {
  readonly #capacities: readonly number[];
  readonly #cells: string[];
  /** True while the entry is shown as wrong (red); the first edit clears it. */
  wrong = false;

  /** `capacities` is how many characters each box holds: a one-box-per-character code is all ones. */
  constructor(capacities: readonly number[]) {
    this.#capacities = capacities;
    this.#cells = capacities.map(() => "");
  }

  get boxes(): number {
    return this.#capacities.length;
  }

  /** What box `index` holds. */
  at(index: number): string {
    return this.#cells[index] ?? "";
  }

  /** Everything typed, box after box, with no gaps. */
  get text(): string {
    return this.#cells.join("");
  }

  /** Every box is full. */
  get complete(): boolean {
    return this.#cells.every((cell, index) => cell.length === this.#capacities[index]);
  }

  /** The person typed into box `index`, and its field now says `value`: it keeps what fits, and what does not goes on into the boxes after it. */
  type(index: number, value: string): Edit {
    this.wrong = false;
    const characters = codeCharacters(value);
    // A box that is typed over keeps the newest characters when it is a one-character box: the person replaced what was there.
    const capacity = this.#capacities[index] ?? 1;
    const kept = capacity === 1 ? characters.slice(-1) : characters;
    this.#cells[index] = "";
    return this.#fill(index, kept);
  }

  /** The person pasted `text` into box `index`. A whole code fills every box from the first; a part of one fills from the box it was pasted into. */
  paste(index: number, text: string): Edit {
    this.wrong = false;
    const characters = codeCharacters(text);
    const total = this.#capacities.reduce((sum, capacity) => sum + capacity, 0);
    const from = characters.length >= total ? 0 : index;
    for (let box = from; box < this.boxes; box++) this.#cells[box] = "";
    return this.#fill(from, characters);
  }

  /** Backspace in box `index`: it clears the last character in the box, and an empty box clears the one before it and takes the caret there. */
  backspace(index: number): Edit {
    this.wrong = false;
    const own = this.#cells[index] ?? "";
    if (own !== "") {
      this.#cells[index] = own.slice(0, -1);
      return { focus: index, complete: false };
    }
    const before = Math.max(0, index - 1);
    this.#cells[before] = (this.#cells[before] ?? "").slice(0, -1);
    return { focus: before, complete: false };
  }

  /** Empties every box and the red. */
  clear(): void {
    this.#cells.fill("");
    this.wrong = false;
  }

  /** Puts `characters` into the boxes from `index` on, each to its capacity. */
  #fill(index: number, characters: string): Edit {
    let box = index;
    let rest = characters;
    while (rest !== "" && box < this.boxes) {
      const room = this.#capacities[box]! - (this.#cells[box] ?? "").length;
      this.#cells[box] += rest.slice(0, room);
      rest = rest.slice(room);
      if (rest !== "") box++;
    }
    // The caret goes on to the next box once this one is full, and stays in the last box when there is no next one.
    const last = Math.min(box, this.boxes - 1);
    const full = (this.#cells[last] ?? "").length === this.#capacities[last];
    return { focus: full && last < this.boxes - 1 ? last + 1 : last, complete: this.complete };
  }
}
