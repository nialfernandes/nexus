import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_CHECKS, DEFAULT_MAX_FAILURES, DEFAULT_MAX_NOTES, DEFAULT_STATE_NOTE, DEFAULT_TIMEOUT_SECONDS, DEFAULT_WINDOW_CHARS, foldersOf, readSettings, readVaultSettings, SETTING, SettingsError, VAULT_SETTING, withModelKeyRead } from "../src/settings";

const MINIMUM = {
  [SETTING.folders]: "Transcripts/",
  [SETTING.modelAddress]: "https://models.example.org/v1",
  [SETTING.modelKey]: "sekret-key-value",
  [SETTING.modelName]: "some-model",
};

describe("the job's settings", () => {
  it("are read, with the documented defaults for the ones that are left out", () => {
    expect(readSettings(MINIMUM)).toEqual({
      folders: ["Transcripts/"],
      maxNotes: DEFAULT_MAX_NOTES,
      maxChecks: DEFAULT_MAX_CHECKS,
      stateNote: DEFAULT_STATE_NOTE,
      maxFailures: DEFAULT_MAX_FAILURES,
      model: { address: "https://models.example.org/v1", key: "sekret-key-value", name: "some-model", windowChars: DEFAULT_WINDOW_CHARS, timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000 },
    });
    expect([DEFAULT_MAX_NOTES, DEFAULT_MAX_CHECKS, DEFAULT_WINDOW_CHARS, DEFAULT_TIMEOUT_SECONDS, DEFAULT_MAX_FAILURES, DEFAULT_STATE_NOTE]).toEqual([10, 20, 12000, 60, 5, "Linker/State.md"]);
  });

  it("take the optional ones from the environment", () => {
    const settings = readSettings({
      ...MINIMUM,
      [SETTING.maxNotes]: "3",
      [SETTING.maxChecks]: "0",
      [SETTING.maxFailures]: "2",
      [SETTING.stateNote]: "Jobs/Linker/Failed.md",
      [SETTING.modelWindow]: "800",
      [SETTING.modelTimeout]: "5",
    });
    expect([settings.maxNotes, settings.maxChecks, settings.maxFailures, settings.stateNote, settings.model.windowChars, settings.model.timeoutMs]).toEqual([3, 0, 2, "Jobs/Linker/Failed.md", 800, 5000]);
  });

  it("name every required one that is missing or blank, and have no default for the model", () => {
    expect(() => readSettings({})).toThrow(new SettingsError(`Set ${SETTING.folders}, ${SETTING.modelAddress}, ${SETTING.modelKey}, ${SETTING.modelName} first (see the package's README).`));
    const { [SETTING.modelName]: _name, ...noModel } = MINIMUM;
    expect(() => readSettings(noModel)).toThrow(`Set ${SETTING.modelName} first`);
    expect(() => readSettings({ ...MINIMUM, [SETTING.modelName]: "  " })).toThrow(`Set ${SETTING.modelName} first`);
    expect(() => readSettings({ ...MINIMUM, [SETTING.modelKey]: 7 })).toThrow(`Set ${SETTING.modelKey} first`);
  });

  it("refuse a number that is not one, naming the setting and never its value", () => {
    for (const [name, bad] of [[SETTING.maxNotes, "ten"], [SETTING.maxNotes, "0"], [SETTING.maxNotes, "-1"], [SETTING.maxChecks, "1.5"], [SETTING.maxFailures, "0"], [SETTING.maxFailures, "five"], [SETTING.modelWindow, "100"], [SETTING.modelTimeout, "0"]] as const) {
      expect(() => readSettings({ ...MINIMUM, [name]: bad }), `${name}=${bad}`).toThrow(name);
    }
  });

  it("refuse an address that is not a web address, without saying the key", () => {
    for (const bad of ["not an address", "ftp://models.example.org", "models.example.org/v1"]) {
      const failure = (() => {
        try {
          readSettings({ ...MINIMUM, [SETTING.modelAddress]: bad });
        } catch (error) {
          return error as Error;
        }
      })();
      expect(failure, bad).toBeInstanceOf(SettingsError);
      expect(failure!.message).not.toContain("sekret-key-value");
    }
  });
});

describe("the model's key in a Worker", () => {
  it("is a plain secret, a string, left as it is", async () => {
    const env = { ...MINIMUM, [SETTING.modelKey]: "a-plain-secret" };
    expect(await withModelKeyRead(env)).toBe(env);
    expect(readSettings(await withModelKeyRead(env)).model.key).toBe("a-plain-secret");
  });

  it("is a Secrets Store binding, an object whose get() answers it, read when the job starts", async () => {
    let asked = 0;
    const binding = { get: async () => (asked++, "a-key-from-the-store") };
    const env = await withModelKeyRead({ ...MINIMUM, [SETTING.modelKey]: binding });
    expect(asked).toBe(1);
    expect(readSettings(env).model.key).toBe("a-key-from-the-store");
    // Nothing else in the environment is changed.
    expect({ ...env, [SETTING.modelKey]: undefined }).toEqual({ ...MINIMUM, [SETTING.modelKey]: undefined });
  });

  it("is refused by name, without what the store said, when the binding cannot be read", async () => {
    const binding = { get: async () => Promise.reject(new Error("store 7 said the secret-token-value is not there")) };
    const failure = await withModelKeyRead({ ...MINIMUM, [SETTING.modelKey]: binding }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(SettingsError);
    expect((failure as Error).message).toContain(SETTING.modelKey);
    expect((failure as Error).message).not.toContain("secret-token-value");
  });

  it("is still missing when the binding answers nothing, and an object with no get() is not a binding", async () => {
    expect(() => readSettings({ ...MINIMUM, [SETTING.modelKey]: undefined })).toThrow(`Set ${SETTING.modelKey} first`);
    const nothing = await withModelKeyRead({ ...MINIMUM, [SETTING.modelKey]: { get: async () => undefined } });
    expect(() => readSettings(nothing)).toThrow(`Set ${SETTING.modelKey} first`);
    const notOne = { ...MINIMUM, [SETTING.modelKey]: { value: "x" } };
    expect(await withModelKeyRead(notOne)).toBe(notOne);
    expect(() => readSettings(notOne)).toThrow(`Set ${SETTING.modelKey} first`);
  });
});

describe("the state note's path", () => {
  it("is a note in a folder of its own, and never in Mentions/ or a hidden folder, which the plugin does not sync", () => {
    for (const bad of ["State.md", "Linker/State.txt", "Linker/", "Mentions/State.md", ".linker/state.md", "Linker/.state.md", "Linker//State.md", "/Linker/State.md", "Linker\\State.md", "Linker/../State.md"]) {
      expect(() => readSettings({ ...MINIMUM, [SETTING.stateNote]: bad }), bad).toThrow(SETTING.stateNote);
    }
    expect(() => readSettings({ ...MINIMUM, [SETTING.stateNote]: "Mentions/Linker/State.md" })).toThrow(/Mentions\//);
  });

  it("is read with blanks around it taken off, and a blank one is the default", () => {
    expect(readSettings({ ...MINIMUM, [SETTING.stateNote]: "  Jobs/State.md " }).stateNote).toBe("Jobs/State.md");
    expect(readSettings({ ...MINIMUM, [SETTING.stateNote]: "  " }).stateNote).toBe(DEFAULT_STATE_NOTE);
  });
});

describe("the folders", () => {
  it("are a comma separated list, each made to end in a slash", () => {
    expect(foldersOf("Transcripts/, Podcasts ,Videos/Talks")).toEqual(["Transcripts/", "Podcasts/", "Videos/Talks/"]);
  });

  it("are never Mentions/ or inside it, where the job writes its own notes", () => {
    for (const bad of ["Mentions", "Mentions/", "Mentions/Books"]) expect(() => foldersOf(bad), bad).toThrow(/Mentions\//);
  });

  it("are never a path that climbs out or hides", () => {
    for (const bad of ["../x", "a/../b", "/abs", ".hidden", "a//b", "a\\b", "."]) expect(() => foldersOf(bad), bad).toThrow(/not a path inside the vault/);
  });

  it("are at least one", () => {
    expect(() => foldersOf(" , ")).toThrow(/names no folder/);
  });
});

describe("the vault's settings", () => {
  it("are the agent's four, and each one missing is named", () => {
    expect(() => readVaultSettings({})).toThrow(`Set ${Object.values(VAULT_SETTING).join(", ")} first`);
    expect(readVaultSettings({ NEXUS_ADDRESS: " a ", NEXUS_TOKEN: "t", NEXUS_AGENT_PRIVATE_KEY: "k", NEXUS_AGENT_APPROVAL: "p" })).toEqual({ address: "a", token: "t", privateKey: "k", approval: "p" });
  });
});
