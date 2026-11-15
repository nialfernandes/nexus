// A transcript note the model cannot read must not stop the notes after it being linked. The job's own record of the notes that failed (one
// note, `Linker/State.md`) is what lets a run take the notes never tried first, then the failed ones the longest ago tried first, and
// leave alone a note that has failed too often. All of it against the real server code and a stand-in model.

import { afterEach, describe, expect, it } from "vitest";
import { fetchOverNexus } from "../../agent/tests/world";
import { DEFAULT_MAX_FAILURES, DEFAULT_STATE_NOTE } from "../src/settings";
import { failuresIn } from "../src/state";
import { hushPath, transcriptNote } from "./fixtures";
import { openLab, type Lab } from "./lab";

const labs: Lab[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.close();
});
async function lab(env: Record<string, string> = {}): Promise<Lab> {
  const opened = await openLab(env);
  labs.push(opened);
  return opened;
}

const A = hushPath("A");
const B = hushPath("B");
const C = hushPath("C");
const D = hushPath("D");
const PODCAST = (name: string) => `Pod/2026_11_10 - A Show - ${name}.md`;

/** A transcript note whose spoken words name it, so the model can be told which ones it cannot read. */
const noteNamed = (name: string) => transcriptNote({ title: name, spoken: [`Words of ${name}.`] });

/** A model that answers with garbage for the named notes, and with nothing mentioned for the rest. */
const cannotRead = (...names: string[]) => (transcript: string) => (names.some((name) => transcript === `Words of ${name}.`) ? "garbage" : "[]");

/** The notes the model was asked about, in order, by name. */
const askedAbout = (l: Lab): string[] => l.model.asked.map((asked) => /Words of (\w+)\./.exec(asked.body.messages[1]!.content)?.[1] ?? `something else: ${asked.body.messages[1]!.content}`);

/** The state note's failures, by the path of the note that failed. */
async function failuresByPath(l: Lab): Promise<Record<string, number>> {
  const text = (await l.texts())[DEFAULT_STATE_NOTE];
  return Object.fromEntries([...failuresIn(text ?? "").values()].map((failure) => [failure.path, failure.tries]));
}

describe("a note the model cannot read", () => {
  it("does not keep a new note from being linked: the notes never tried come first, then the failed ones the longest ago tried", async () => {
    const l = await lab({ LINKER_MAX_NOTES: "2" });
    // The model fails on the first two by path, and there are two more after them.
    for (const name of ["A", "B", "C", "D"]) await l.seed(hushPath(name), noteNamed(name));
    l.model.answer(cannotRead("A", "B"));

    const first = await l.run();
    expect(askedAbout(l)).toEqual(["A", "B"]);
    expect(first.report.failed.map((one) => one.path)).toEqual([A, B]);
    expect(first.report.linked).toEqual([]);

    // Without a record of failures the second run takes A and B again, and C and D are never reached.
    l.model.asked.length = 0;
    const second = await l.run();
    expect(askedAbout(l)).toEqual(["C", "D"]);
    expect(second.report.linked).toEqual([C, D]);

    // Nothing new is left, so now the failed ones are tried, the one tried longest ago first (A and B were tried in that order).
    l.model.asked.length = 0;
    const third = await l.run();
    expect(askedAbout(l)).toEqual(["A", "B"]);
    expect(third.report.failed.map((one) => one.path)).toEqual([A, B]);
    expect(await failuresByPath(l)).toEqual({ [A]: 2, [B]: 2 });
  });

  it("is tried after the new note in the very next run, and the failed ones take turns", async () => {
    const l = await lab({ LINKER_MAX_NOTES: "2" });
    await l.seed(A, noteNamed("A"));
    await l.seed(B, noteNamed("B"));
    l.model.answer(cannotRead("A", "B"));
    await l.run();

    await l.seed(C, noteNamed("C"));
    l.model.asked.length = 0;
    const second = await l.run();
    // C first, and then one place left for the failed notes: A, the first of the two that was tried.
    expect(askedAbout(l)).toEqual(["C", "A"]);
    expect(second.report.linked).toEqual([C]);

    // The run after it: nothing is new, so B (tried before A was tried again) comes before A.
    l.model.asked.length = 0;
    await l.run();
    expect(askedAbout(l)).toEqual(["B", "A"]);
    expect(await failuresByPath(l)).toEqual({ [A]: 3, [B]: 2 });
  });

  it("is written in one note of its own, with its id, how many times it failed, when and why, and no other note is changed", async () => {
    const l = await lab();
    const made = await l.seed(A, noteNamed("A"));
    await l.seed(B, noteNamed("B"));
    l.model.answer(cannotRead("A"));
    const before = await l.texts();
    await l.run();
    const texts = await l.texts();
    const state = texts[DEFAULT_STATE_NOTE]!;
    expect(state).toMatch(/^# Linker state\n/);
    // The date is the lab's clock: a second after it was set.
    expect(state).toContain(`- ${made.id} | failed 1 | 2026-11-16T00:00:`);
    expect(state).toContain(` | The model's answer was not a JSON list. | ${A}\n`);
    expect(state).not.toContain(B);
    // The transcript note that failed is as it was, and the one that was linked has only its own change.
    expect(texts[A]).toBe(before[A]);
    expect(texts[B]).toContain("mentions: linked");
    expect(Object.keys(texts).sort()).toEqual([A, B, DEFAULT_STATE_NOTE].sort());
  });

  it("is never read as a transcript note, even when the state note is in a folder the job reads", async () => {
    const l = await lab({ LINKER_FOLDERS: "Hush/,Linker/" });
    await l.seed(A, noteNamed("A"));
    l.model.answer(cannotRead("A"));
    await l.run();
    const state = (await l.texts())[DEFAULT_STATE_NOTE]!;
    l.model.asked.length = 0;
    await l.run();
    // Only A was asked about, and the state note is the state note still, with A's line counted up.
    expect(askedAbout(l)).toEqual(["A"]);
    expect((await l.texts())[DEFAULT_STATE_NOTE]).toMatch(/^# Linker state\n/);
    expect((await l.texts())[DEFAULT_STATE_NOTE]).not.toContain("mentions: linked");
    expect(state).toContain("failed 1");
    expect(await failuresByPath(l)).toEqual({ [A]: 2 });
  });

  it("is left out of the run altogether when it has failed as often as it may, so the notes after it are reached", async () => {
    const l = await lab({ LINKER_MAX_NOTES: "1", LINKER_MAX_CHECKS: "0", LINKER_MAX_FAILURES: "1" });
    await l.seed(A, noteNamed("A"));
    await l.seed(B, noteNamed("B"));
    l.model.answer(cannotRead("A"));
    await l.run();
    l.model.asked.length = 0;
    // One read a run is all there is (1 note + 0 checks), and A, skipped, does not use it up.
    const second = await l.run();
    expect(askedAbout(l)).toEqual(["B"]);
    expect(second.report.linked).toEqual([B]);
  });
});

describe("a note that has failed too often", () => {
  it("is skipped after 5 failures, and tried again once its line is taken out of the state note", async () => {
    expect(DEFAULT_MAX_FAILURES).toBe(5);
    const l = await lab();
    await l.seed(A, noteNamed("A"));
    l.model.answer(cannotRead("A"));
    for (let run = 1; run <= 5; run++) expect((await l.run()).report.failed.map((one) => one.path), `run ${run}`).toEqual([A]);
    expect(askedAbout(l)).toEqual(["A", "A", "A", "A", "A"]);
    expect(await failuresByPath(l)).toEqual({ [A]: 5 });

    // The sixth run does not ask about it, and says why it did not.
    const sixth = await l.run();
    expect(askedAbout(l)).toHaveLength(5);
    expect(sixth.report).toEqual({ linked: [], failed: [], changedMeanwhile: [], tried: 0 });
    expect(sixth.logs).toEqual([`${A}: failed 5 times, so it is skipped until its line is taken out of ${DEFAULT_STATE_NOTE} (The model's answer was not a JSON list.)`]);

    // A person takes the line out, with the model now able to read it, and it is linked.
    const ref = (await l.refs()).find((one) => one.path === DEFAULT_STATE_NOTE)!;
    const state = await l.writer.readNote(ref.id);
    const edited = state.text.split("\n").filter((line) => !line.includes(` | ${A}`)).join("\n");
    expect(edited).not.toBe(state.text);
    expect((await l.writer.updateNote(ref.id, state.version, edited)).result).toBe("saved");
    l.model.answer(() => "[]");
    const seventh = await l.run();
    expect(askedAbout(l)).toHaveLength(6);
    expect(seventh.report.linked).toEqual([A]);
    expect(await failuresByPath(l)).toEqual({});
  });

  it("starts its count again from nothing when its line is taken out, so it fails 5 more times before it is skipped", async () => {
    const l = await lab({ LINKER_MAX_FAILURES: "2" });
    await l.seed(A, noteNamed("A"));
    l.model.answer(cannotRead("A"));
    await l.run();
    await l.run();
    expect((await l.run()).report.tried).toBe(0);
    const ref = (await l.refs()).find((one) => one.path === DEFAULT_STATE_NOTE)!;
    const state = await l.writer.readNote(ref.id);
    await l.writer.updateNote(ref.id, state.version, state.text.split("\n").filter((line) => !line.includes(` | ${A}`)).join("\n"));
    expect((await l.run()).report.tried).toBe(1);
    expect(await failuresByPath(l)).toEqual({ [A]: 1 });
    expect((await l.run()).report.tried).toBe(1);
    expect((await l.run()).report.tried).toBe(0);
  });

  it("has its line taken out when it is linked after all, so a note that failed and then worked leaves no line behind", async () => {
    const l = await lab();
    await l.seed(A, noteNamed("A"));
    l.model.answer(cannotRead("A"));
    await l.run();
    await l.run();
    expect(await failuresByPath(l)).toEqual({ [A]: 2 });
    l.model.answer(() => "[]");
    expect((await l.run()).report.linked).toEqual([A]);
    expect(await failuresByPath(l)).toEqual({});
  });

  it("does not hold a person's own words in the state note against it", async () => {
    const l = await lab();
    await l.seed(A, noteNamed("A"));
    l.model.answer(cannotRead("A"));
    await l.run();
    const ref = (await l.refs()).find((one) => one.path === DEFAULT_STATE_NOTE)!;
    const state = await l.writer.readNote(ref.id);
    await l.writer.updateNote(ref.id, state.version, `${state.text}\nA is the one with the bad audio.\n- not a failure | at all\n`);
    await l.run();
    const text = (await l.texts())[DEFAULT_STATE_NOTE]!;
    expect(text).toContain("\nA is the one with the bad audio.\n- not a failure | at all\n");
    expect(await failuresByPath(l)).toEqual({ [A]: 2 });
  });
});

describe("two runs at once", () => {
  /**
   * A way to reach Nexus that holds each run's first save until both runs have one to make, so both have read the state note (or found there
   * is none) before either has changed it, and the two collide however the scheduler runs them.
   */
  function meetingAtTheFirstSave(): ReturnType<typeof fetchOverNexus> {
    let waiting = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    return fetchOverNexus({
      before: async ({ route }) => {
        if (route !== "save" || waiting >= 2) return;
        waiting++;
        if (waiting === 2) release();
        await both;
      },
    });
  }

  /** The two runs: each looks in a folder of its own, where one note fails. */
  async function twoFailing(l: Lab, how: { fetchNexus: ReturnType<typeof fetchOverNexus>["fetch"] }) {
    return Promise.all([l.run({ LINKER_FOLDERS: "Hush/" }, how), l.run({ LINKER_FOLDERS: "Pod/" }, how)]);
  }

  it("leave one state note with both runs' lines when neither found the state note there", async () => {
    const l = await lab();
    await l.seed(A, noteNamed("A"));
    await l.seed(PODCAST("P"), noteNamed("P"));
    l.model.answer(cannotRead("A", "P"));
    const meeting = meetingAtTheFirstSave();

    const [one, other] = await twoFailing(l, { fetchNexus: meeting.fetch });
    expect(one.logs.concat(other.logs).join("\n")).not.toMatch(/could not be written/);

    // Both made the state note at the same moment: the one that lost found the one that won, and added its line to it.
    expect((await l.refs()).filter((ref) => ref.path === DEFAULT_STATE_NOTE)).toHaveLength(1);
    expect(await failuresByPath(l)).toEqual({ [A]: 1, [PODCAST("P")]: 1 });
    expect(meeting.seen.filter((call) => call.route === "save")).toHaveLength(3);
  });

  it("leave one state note with both runs' lines, and the line that was there, when both changed it from the same version", async () => {
    const l = await lab();
    await l.seed(A, noteNamed("A"));
    l.model.answer(cannotRead("A", "P"));
    // An earlier run failed on A, so there is a state note to change.
    await l.run({ LINKER_FOLDERS: "Hush/" });
    expect(await failuresByPath(l)).toEqual({ [A]: 1 });
    await l.seed(PODCAST("P"), noteNamed("P"));
    const meeting = meetingAtTheFirstSave();

    const [one, other] = await twoFailing(l, { fetchNexus: meeting.fetch });
    expect(one.logs.concat(other.logs).join("\n")).not.toMatch(/could not be written/);

    expect((await l.refs()).filter((ref) => ref.path === DEFAULT_STATE_NOTE)).toHaveLength(1);
    // The Hush/ run tried A again (the only note it had) and the Pod/ run tried P.
    expect(await failuresByPath(l)).toEqual({ [A]: 2, [PODCAST("P")]: 1 });
    // Both saved from the one version, so one was refused and made its change again on what the other had saved.
    expect(meeting.seen.filter((call) => call.route === "save")).toHaveLength(3);
  });
});
