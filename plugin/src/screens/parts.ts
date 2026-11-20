// The pieces every screen is made of: the teal slab with its nexus mark and lowercase title, the white card, the pill buttons, the
// sand-grey panels, the round marks, and the code boxes (read to be copied, or typed into). A screen is these pieces in order; none of
// them holds a state of its own: the code boxes show what their `CodeEntry` holds, and every button calls what it is given.

import { COPY_WORDS } from "../copied";
import { CodeEntry, type Edit } from "./code-entry";
import { el, icon } from "./dom";

type Child = Node | string | null | false | undefined;

/** The word the slab starts with: the mark. */
export const MARK = "nexus";

/**
 * The whole screen: the slab (one slim line: the mark, a thin divider, the title), then the body holding the line under the title and
 * the cards. The line used to sit in the slab; the boards now draw it as the first line of the body, and still call it the slab line.
 */
export function screen(title: string, line: string, ...cards: Child[]): HTMLElement {
  return el(
    "div",
    { class: "nx-screen" },
    el(
      "div",
      { class: "nx-slab" },
      el(
        "div",
        { class: "nx-slab__bar" },
        el("div", { class: "nx-slab__name" }, el("span", { class: "nx-slab__mark" }, MARK), el("span", { class: "nx-slab__divider", "aria-hidden": "true" }), el("h2", { class: "nx-slab__title" }, title)),
        // Where the estate's top bar keeps its controls: none on these screens, but the line is drawn with room for them.
        el("div", { class: "nx-slab__tools" }),
      ),
    ),
    el("div", { class: "nx-body" }, el("p", { class: "nx-slab__line" }, line), ...cards),
  );
}

export const card = (...children: Child[]): HTMLElement => el("div", { class: "nx-card" }, ...children);
export const text = (words: string): HTMLElement => el("p", { class: "nx-text" }, words);
export const small = (words: string): HTMLElement => el("p", { class: "nx-small" }, words);
/** The red line that says what went wrong. */
export const faultLine = (words: string): HTMLElement => el("p", { class: "nx-fault-line", role: "alert" }, words);
export const label = (words: string): HTMLElement => el("span", { class: "nx-label" }, words);
export const actions = (...pills: Child[]): HTMLElement => el("div", { class: "nx-actions" }, ...pills);

/** A cream box that warns, or (`fault`) a red one that says what a fault could mean. */
export function note(head: string, words: string, fault = false): HTMLElement {
  return el("div", { class: fault ? "nx-note nx-note--fault" : "nx-note" }, el("p", { class: "nx-note__head" }, head), el("p", { class: "nx-small" }, words));
}

export interface PillOptions {
  /** Dim, and ignoring taps. */
  dim?: boolean;
  /** Not stretched across the card: sits at its left. */
  start?: boolean;
  /** Names the button for the screen to find it again after it draws itself anew (and for a test). */
  key?: string;
  /** What a screen reader calls the button when its words alone do not say what it is for (Copy, for which code). */
  label?: string;
}

/** A pill button: the main one is ink with white words, the quiet one has a soft outline. A dim one ignores taps. */
export function pill(words: string, kind: "main" | "quiet", onClick: () => void, options: PillOptions = {}): HTMLButtonElement {
  return el(
    "button",
    {
      type: "button",
      class: `nx-pill nx-pill--${kind}${options.start ? " nx-pill--start" : ""}`,
      "aria-disabled": options.dim ? "true" : undefined,
      "aria-label": options.label,
      "data-key": options.key,
      on: { click: () => (options.dim ? undefined : onClick()) },
    },
    words,
  );
}

/** An underlined text link that is a button. */
export function link(words: string, onClick: () => void, key?: string): HTMLButtonElement {
  return el("button", { type: "button", class: "nx-link", "data-key": key, on: { click: onClick } }, words);
}

// ── the round marks ──────────────────────────────────────────────────────────────

const circle = (kind: "done" | "fault" | "neutral", mark: SVGSVGElement): HTMLElement => el("div", { class: `nx-circle nx-circle--${kind}` }, mark);

/** A teal circle with an ink tick. */
export const doneCircle = (): HTMLElement =>
  circle("done", icon(18, "0 0 20 20", [{ shape: "path", attributes: { d: "M4 10.5l4 4L16 6", fill: "none", stroke: "currentColor", "stroke-width": "2.4", "stroke-linecap": "round", "stroke-linejoin": "round" } }]));

/** A light red circle with a red clock: time ran out. */
export const clockCircle = (): HTMLElement =>
  circle(
    "fault",
    icon(18, "0 0 20 20", [
      { shape: "circle", attributes: { cx: "10", cy: "10", r: "7.5", fill: "none", stroke: "currentColor", "stroke-width": "2" } },
      { shape: "path", attributes: { d: "M10 5.5V10l3 2", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" } },
    ]),
  );

/** A grey circle with an ink cross: a choice, or something that is not allowed, and nothing is broken. */
export const crossCircle = (): HTMLElement =>
  circle("neutral", icon(16, "0 0 14 14", [{ shape: "path", attributes: { d: "M2 2l10 10M12 2L2 12", fill: "none", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round" } }]));

/** The tick inside a ticked box. */
export const tickMark = (): SVGSVGElement =>
  icon(12, "0 0 12 12", [{ shape: "path", attributes: { d: "M2 6.3l2.6 2.6L10 3.4", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" } }]);

// ── codes ────────────────────────────────────────────────────────────────────────

/** How many boxes in each group of a code of `length` characters: 4, 4, 2 for a ten-character code, 4, 4 for an eight-character one. */
export function groupsOf(length: number): number[] {
  const groups: number[] = [];
  for (let left = length; left > 0; left -= 4) groups.push(Math.min(4, left));
  return groups;
}

const groupClass = (size: number): string => `nx-code__group nx-code__group--${size}`;

/** The Copy button beside a code that is read: what it says now, and what it does. */
export interface CopyButton {
  /** Names the button for the screen to find it again after it draws itself anew (and for a test). */
  key: string;
  /** True while it says Copied. */
  copied: boolean;
  /** Called with the code exactly as the boxes show it. */
  onCopy: (code: string) => void;
}

/**
 * A code to be read and copied, not typed: sand-grey boxes, one per character. The whole code is one label to a screen reader. The boxes
 * are text a person can select (one tap selects the whole code, and copying it gives the characters with nothing between them, where
 * a plain copy of boxes would put a line break after each), and `copy` puts a Copy button on the label's row that puts the same
 * characters on the clipboard. The boards draw no Copy beside a code, so it is the quiet pill of board 7's Copy key, made the same way.
 */
export function readCode(name: string, code: string, copy?: CopyButton): HTMLElement {
  const characters = [...code];
  const whole = characters.join("");
  let at = 0;
  const groups = groupsOf(characters.length).map((size) => {
    const boxes = characters.slice(at, at + size).map((character) => el("div", { class: "nx-box nx-box--read", "aria-hidden": "true" }, character));
    at += size;
    return el("div", { class: groupClass(size) }, ...boxes);
  });
  const head = el(
    "div",
    { class: "nx-field__head" },
    label(name),
    copy
      ? pill(copy.copied ? COPY_WORDS.copied : COPY_WORDS.copy, "quiet", () => copy.onCopy(whole), { key: copy.key, label: `${copy.copied ? COPY_WORDS.copied : COPY_WORDS.copy} ${name}` })
      : null,
  );
  const boxes = el("div", { class: "nx-code nx-code--read", on: { copy: (event) => copySelected(event, whole) } }, ...groups);
  return el("div", { class: "nx-field", role: "group", "aria-label": `${name} ${characters.join(" ")}` }, head, boxes);
}

/** A copy of what is selected in a code: its characters with no line breaks between boxes, or the whole code when nothing readable is selected. */
function copySelected(event: Event, whole: string): void {
  const data = (event as ClipboardEvent).clipboardData;
  if (!data) return;
  const picked = (event.currentTarget as Node | null)?.ownerDocument?.getSelection?.()?.toString().replace(/\s+/g, "") ?? "";
  data.setData("text/plain", picked === "" ? whole : picked);
  event.preventDefault();
}

/** What a typed code needs from the screen that holds it. */
export interface CodeFieldOptions {
  /** Tells the field's boxes apart from every other field's: `id:index` is each box's key. */
  id: string;
  /** What the field is called, for a screen reader. */
  name: string;
  entry: CodeEntry;
  /** Called after every edit, with what it did and the box it was made in. */
  onEdit: (edit: Edit, box: number) => void;
}

/** Where a box of a field is, as the key the screen puts the caret back with after it draws itself anew. */
export const boxKey = (id: string, index: number): string => `${id}:${index}`;

/** One typed box: a wrapper that is drawn as the box, and an input that has the characters. */
function editBox(options: CodeFieldOptions, index: number, wrong: boolean): HTMLElement {
  const { id, name, entry, onEdit } = options;
  const input = el("input", {
    type: "text",
    class: "nx-box__input",
    value: entry.at(index),
    placeholder: " ",
    autocomplete: "off",
    autocapitalize: "characters",
    spellcheck: "false",
    "aria-label": `${name}, box ${index + 1} of ${entry.boxes}`,
    "data-key": boxKey(id, index),
    on: {
      input: (event) => onEdit(entry.type(index, (event.target as HTMLInputElement).value), index),
      paste: (event) => {
        event.preventDefault();
        onEdit(entry.paste(index, (event as ClipboardEvent).clipboardData?.getData("text") ?? ""), index);
      },
      keydown: (event) => {
        const key = (event as KeyboardEvent).key;
        if (key === "Backspace" && (event.target as HTMLInputElement).value === "") {
          event.preventDefault();
          onEdit(entry.backspace(index), index);
        } else if (key === "ArrowLeft" && index > 0) {
          event.preventDefault();
          onEdit({ focus: index - 1, complete: false }, index);
        } else if (key === "ArrowRight" && index < entry.boxes - 1) {
          event.preventDefault();
          onEdit({ focus: index + 1, complete: false }, index);
        }
      },
      focus: (event) => (event.target as HTMLInputElement).select(),
    },
  });
  input.value = entry.at(index);
  return el("div", { class: `nx-box nx-box--edit${wrong ? " nx-box--wrong" : ""}` }, input);
}

/** A code typed in, one box per character, grouped 4, 4, 2. Typing the last character, or pasting the whole code, is for the screen to check. */
export function codeField(options: CodeFieldOptions, title: string): HTMLElement {
  const { entry } = options;
  let at = 0;
  const groups = groupsOf(entry.boxes).map((size) => {
    const boxes = Array.from({ length: size }, (_, offset) => editBox(options, at + offset, entry.wrong));
    at += size;
    return el("div", { class: groupClass(size) }, ...boxes);
  });
  return el("div", { class: "nx-field" }, label(title), el("div", { class: "nx-code" }, ...groups));
}

/**
 * The Recovery Key typed in: one box for each group of four characters, four to a row, the last row two boxes. `wrongBoxes` are the
 * boxes drawn red (the last group, when the key's own check does not agree).
 */
export function keyField(options: CodeFieldOptions, title: string, wrongBoxes: ReadonlySet<number>): HTMLElement {
  const { entry } = options;
  const rows: HTMLElement[] = [];
  for (let first = 0; first < entry.boxes; first += 4) {
    const boxes: HTMLElement[] = [];
    for (let index = first; index < Math.min(first + 4, entry.boxes); index++) boxes.push(editBox(options, index, wrongBoxes.has(index)));
    // A short last row keeps its boxes the width of the others.
    for (let blank = boxes.length; blank < 4; blank++) boxes.push(el("div", { class: "nx-keyrow__rest" }));
    rows.push(el("div", { class: "nx-keyrow" }, ...boxes));
  }
  return el("div", { class: "nx-field" }, label(title), el("div", { class: "nx-keyrows" }, ...rows));
}

/** Three groups typed back: a name to the left of each row of four square boxes. `wrongRows` are the rows drawn red. */
export function groupRows(options: CodeFieldOptions, names: readonly string[], wrongRows: ReadonlySet<number>): HTMLElement {
  const rows = names.map((name, row) =>
    el(
      "div",
      { class: "nx-group" },
      label(name),
      ...Array.from({ length: 4 }, (_, offset) => editBox(options, row * 4 + offset, wrongRows.has(row))),
    ),
  );
  return el("div", { class: "nx-groups" }, ...rows);
}
