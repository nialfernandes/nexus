// The three-way line merge behind a save that started from an older version.
//
// `base` is the version the writer started from, `ours` the note's latest text and `theirs` the text being saved.
// Each side's changes to the base are found as hunks (a stretch of base lines and what replaced it). Hunks on
// different lines are both kept. Hunks that touch the same lines differently are a clash, and the merge says so
// by answering null: the caller keeps both texts and overwrites nothing. The same change made on both sides is
// taken once.
//
// A line is kept with its line ending, so `one\n` and `one` (no final newline) are different lines, and Windows
// line ends survive the merge as they were written.

/** Base lines [start, end) replaced by `lines` (an insertion when start equals end). */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
  side: 0 | 1;
}

/** The most cells the diff will fill. A change bigger than this is too much to merge safely, so it is a clash. */
const MAX_DIFF_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      out.push(text.slice(from, i + 1));
      from = i + 1;
    }
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/** What changed from `base` to `other`, as hunks in base coordinates, or null when the change is too big to follow. */
function hunksBetween(base: string[], other: string[], side: 0 | 1): Hunk[] | null {
  let prefix = 0;
  while (prefix < base.length && prefix < other.length && base[prefix] === other[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < base.length - prefix && suffix < other.length - prefix &&
    base[base.length - 1 - suffix] === other[other.length - 1 - suffix]
  ) suffix++;

  const a = base.slice(prefix, base.length - suffix);
  const b = other.slice(prefix, other.length - suffix);
  if (a.length === 0 && b.length === 0) return [];
  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) return null;

  // lcs[i][j]: how many lines the tails a[i..] and b[j..] share in order.
  const width = b.length + 1;
  const lcs = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const hunks: Hunk[] = [];
  let open: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      open = null;
      i++;
      j++;
      continue;
    }
    if (!open) {
      open = { start: prefix + i, end: prefix + i, lines: [], side };
      hunks.push(open);
    }
    if (i < a.length && (j === b.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      i++;
      open.end = prefix + i;
    } else {
      open.lines.push(b[j]);
      j++;
    }
  }
  return hunks;
}

/** Do two hunks from different sides want the same lines? An insertion only clashes with a change that spans its point. */
function overlap(x: Hunk, y: Hunk): boolean {
  const xEmpty = x.start === x.end;
  const yEmpty = y.start === y.end;
  if (xEmpty && yEmpty) return x.start === y.start;
  if (xEmpty) return y.start < x.start && x.start < y.end;
  if (yEmpty) return x.start < y.start && y.start < x.end;
  return x.start < y.end && y.start < x.end;
}

const sameChange = (x: Hunk, y: Hunk): boolean =>
  x.start === y.start && x.end === y.end && x.lines.length === y.lines.length && x.lines.every((line, n) => line === y.lines[n]);

/** The merged text, or null when the two sides changed the same lines differently. */
export function mergeText(baseText: string, oursText: string, theirsText: string): string | null {
  const base = splitLines(baseText);
  const ours = hunksBetween(base, splitLines(oursText), 0);
  const theirs = hunksBetween(base, splitLines(theirsText), 1);
  if (!ours || !theirs) return null;

  // An insertion sorts before a change that starts at the same line.
  const all = [...ours, ...theirs].sort((x, y) =>
    x.start - y.start || Number(y.start === y.end) - Number(x.start === x.end) || x.side - y.side);

  const taken: Hunk[] = [];
  for (const hunk of all) {
    const last = taken[taken.length - 1];
    if (last && last.side !== hunk.side && overlap(last, hunk)) {
      if (sameChange(last, hunk)) continue;
      return null;
    }
    taken.push(hunk);
  }

  const out: string[] = [];
  let at = 0;
  for (const hunk of taken) {
    out.push(...base.slice(at, hunk.start), ...hunk.lines);
    at = hunk.end;
  }
  out.push(...base.slice(at));
  return out.join("");
}
