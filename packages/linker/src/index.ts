// What another program imports from the job: one pass over a vault, and the settings it reads.

export { runLinker, summaryOf, type RunOptions, type RunReport } from "./run";
export { runJob, type JobOptions } from "./job";
export { readSettings, readVaultSettings, SETTING, VAULT_SETTING, SettingsError, type LinkerSettings } from "./settings";
export { ModelFailure, type ModelFetch, type ModelSettings } from "./model";
export { titleKey, noteName, MENTIONS_FOLDER } from "./titles";
export type { NoteStore } from "./store";
