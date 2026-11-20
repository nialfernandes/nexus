// What every Copy button of the plugin says, and for how long it says Copied: the Recovery Key's, the codes on the setup screens' and
// the sign-in code in the settings. One place, so a button never says it a second way.

/** How long a Copy button says Copied before it says Copy again. */
export const COPIED_FOR_MS = 2_000;

/** The words on a Copy button, and on it after the copy. */
export const COPY_WORDS = { copy: "Copy", copied: "Copied" } as const;
