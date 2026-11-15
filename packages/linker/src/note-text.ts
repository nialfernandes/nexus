// Reading and changing the text of a transcript note, and of a mentioned thing's note. The job changes a transcript note in two places
// only: the `## Mentions` section, and one line of its front matter, `mentions: linked`. Everything else is left byte for byte as it was,
// line endings included, so each change here is made on the text where it stands and nothing is read into a form and written back.

/** The front matter line that says a note has been linked, and so is never processed again. */
export const LINKED_LINE = "mentions: linked";

/** The heading of the section of links the job writes. */
export const MENTIONS_HEADING = "## Mentions";

/** The heading of the transcript, which the spoken words are read from. */
const TRANSCRIPT_HEADING = /^## Transcript[ \t]*\r?$/im;

/** The front matter block: the opening `---` line, the lines, and the closing `---` line. */
const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/m;

interface Front {
  /** The lines between the two `---` lines. */
  lines: string;
  /** Where the block starts and ends in the text, the closing line's line break included. */
  end: number;
  /** Where the lines end: what is put at this offset is the last line of the front matter. */
  linesEnd: number;
}

function frontOf(text: string): Front | null {
  const match = FRONT_MATTER.exec(text);
  if (match === null || match.index !== 0) return null;
  const lines = match[1]!;
  // The lines start right after the opening line's break.
  const start = text.indexOf("\n") + 1;
  return { lines, end: match[0].length, linesEnd: start + lines.length };
}

/** The line break the text uses: the first one in it. */
function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

const LINKED = /^mentions[ \t]*:[ \t]*["']?linked["']?[ \t]*\r?$/m;
const MENTIONS_KEY = /^mentions[ \t]*:.*$/m;

/** True when the front matter says the note was linked. */
export function isLinked(text: string): boolean {
  const front = frontOf(text);
  return front !== null && LINKED.test(front.lines);
}

/** True when the front matter has a line for `key`, whatever it says. */
export function hasField(text: string, key: string): boolean {
  const front = frontOf(text);
  return front !== null && new RegExp(`^${key}[ \\t]*:`, "m").test(front.lines);
}

/** True when the text has front matter at all. */
export const hasFrontMatter = (text: string): boolean => frontOf(text) !== null;

/** The value of a front matter line, as written (quotes included), or null. */
export function fieldOf(text: string, key: string): string | null {
  const front = frontOf(text);
  if (front === null) return null;
  const match = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*?)\\r?$`, "m").exec(front.lines);
  return match === null ? null : match[1]!;
}

/** The text with these lines added to the end of its front matter. A text with no front matter is not changed. */
export function withFrontLines(text: string, lines: readonly string[]): string {
  const front = frontOf(text);
  if (front === null || lines.length === 0) return text;
  const eol = eolOf(text);
  const at = front.linesEnd;
  // An empty block (`---` straight over `---`) has no line to follow: its new lines come first and are followed by the break.
  const [lead, tail] = front.lines === "" ? ["", eol] : [eol, ""];
  return text.slice(0, at) + lead + lines.join(eol) + tail + text.slice(at);
}

/** The text with `mentions: linked` in its front matter: a `mentions:` line already there says it, or is put right; a text with no front matter gets one. */
export function withLinkedMark(text: string): string {
  const front = frontOf(text);
  if (front === null) {
    const eol = eolOf(text);
    return `---${eol}${LINKED_LINE}${eol}---${eol}${text}`;
  }
  if (MENTIONS_KEY.test(front.lines)) {
    const start = text.indexOf("\n") + 1;
    // `.` stops before a carriage return, so a line's own ending is kept.
    const lines = front.lines.replace(MENTIONS_KEY, LINKED_LINE);
    return text.slice(0, start) + lines + text.slice(start + front.lines.length);
  }
  return withFrontLines(text, [LINKED_LINE]);
}

/** Where the body starts: after the front matter. */
function bodyStart(text: string): number {
  return frontOf(text)?.end ?? 0;
}

/** The value of the front matter line `link:`, the episode's own page, which is not something the episode mentions. */
export function ownLink(text: string): string | null {
  const raw = fieldOf(text, "link");
  if (raw === null) return null;
  return raw.replace(/^["']|["']$/g, "");
}

/** The note's show notes: what stands above the transcript, the description and its links. A note with no transcript heading is all show notes. */
export function showNotesOf(text: string): string {
  const body = text.slice(bodyStart(text));
  const heading = TRANSCRIPT_HEADING.exec(body);
  return heading === null ? body : body.slice(0, heading.index);
}

/** The time at the start of a paragraph, `[0:07] ` or `[1:02:03] `, and the line that stands where an ad was cut. */
const TIME_STAMP = /^\[\d+(?::\d{2}){1,2}\][ \t]*/gm;
const AD_LINE = /^\[ad removed\][ \t]*\r?$/gm;

/** The spoken words the model reads: the transcript's paragraphs without their times. A note with no transcript heading is read whole. */
export function spokenOf(text: string): string {
  const body = text.slice(bodyStart(text));
  const heading = TRANSCRIPT_HEADING.exec(body);
  const spoken = heading === null ? body : body.slice(heading.index + heading[0].length);
  return spoken.replace(AD_LINE, "").replace(TIME_STAMP, "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The name a `[[link]]` points at: without a heading or a label after it. */
const linkTarget = (inside: string): string => inside.replace(/[#|^].*$/s, "").trim();

/** The text with a `## Mentions` section that links to every name in `names`. A section already there keeps its lines and gets only the links it lacks. */
export function withMentionsSection(text: string, names: readonly string[]): string {
  if (names.length === 0) return text;
  const eol = eolOf(text);
  const heading = /^## Mentions[ \t]*\r?$/im.exec(text);
  if (heading !== null) {
    const afterHeading = heading.index + heading[0].length;
    const next = /^#{1,2}[ \t]/m.exec(text.slice(afterHeading));
    const sectionEnd = next === null ? text.length : afterHeading + next.index;
    const section = text.slice(afterHeading, sectionEnd);
    const have = new Set([...section.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => linkTarget(match[1]!).toLowerCase()));
    const missing = names.filter((name) => !have.has(name.toLowerCase()));
    if (missing.length === 0) return text;
    // The new links go after the section's last line that says anything, before the blank lines that part it from the next heading.
    const content = section.replace(/\s+$/, "");
    const at = afterHeading + content.length;
    const lead = content === "" ? eol + eol : eol;
    return text.slice(0, at) + lead + missing.map((name) => `- [[${name}]]`).join(eol) + text.slice(at);
  }
  const block = `${MENTIONS_HEADING}${eol}${eol}${names.map((name) => `- [[${name}]]`).join(eol)}${eol}${eol}`;
  const body = bodyStart(text);
  const transcript = TRANSCRIPT_HEADING.exec(text.slice(body));
  if (transcript !== null) {
    const at = body + transcript.index;
    return text.slice(0, at) + block + text.slice(at);
  }
  const end = text.replace(/\s+$/, "");
  return `${end}${eol}${eol}${block.replace(/\s+$/, "")}${eol}`;
}

/** The text of a linked transcript note: the section, and the line that says it was done. */
export const linkedText = (text: string, names: readonly string[]): string => withLinkedMark(withMentionsSection(text, names));
