import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_CHECKS, DEFAULT_MAX_NOTES, DEFAULT_TIMEOUT_SECONDS, DEFAULT_WINDOW_CHARS, foldersOf, readSettings, readVaultSettings, SETTING, SettingsError, VAULT_SETTING } from "../src/settings";

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
      model: { address: "https://models.example.org/v1", key: "sekret-key-value", name: "some-model", windowChars: DEFAULT_WINDOW_CHARS, timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000 },
    });
    expect([DEFAULT_MAX_NOTES, DEFAULT_MAX_CHECKS, DEFAULT_WINDOW_CHARS, DEFAULT_TIMEOUT_SECONDS]).toEqual([10, 20, 12000, 60]);
  });

  it("take the optional ones from the environment", () => {
    const settings = readSettings({ ...MINIMUM, [SETTING.maxNotes]: "3", [SETTING.maxChecks]: "0", [SETTING.modelWindow]: "800", [SETTING.modelTimeout]: "5" });
    expect([settings.maxNotes, settings.maxChecks, settings.model.windowChars, settings.model.timeoutMs]).toEqual([3, 0, 800, 5000]);
  });

  it("name every required one that is missing or blank, and have no default for the model", () => {
    expect(() => readSettings({})).toThrow(new SettingsError(`Set ${SETTING.folders}, ${SETTING.modelAddress}, ${SETTING.modelKey}, ${SETTING.modelName} first (see the package's README).`));
    const { [SETTING.modelName]: _name, ...noModel } = MINIMUM;
    expect(() => readSettings(noModel)).toThrow(`Set ${SETTING.modelName} first`);
    expect(() => readSettings({ ...MINIMUM, [SETTING.modelName]: "  " })).toThrow(`Set ${SETTING.modelName} first`);
    expect(() => readSettings({ ...MINIMUM, [SETTING.modelKey]: 7 })).toThrow(`Set ${SETTING.modelKey} first`);
  });

  it("refuse a number that is not one, naming the setting and never its value", () => {
    for (const [name, bad] of [[SETTING.maxNotes, "ten"], [SETTING.maxNotes, "0"], [SETTING.maxNotes, "-1"], [SETTING.maxChecks, "1.5"], [SETTING.modelWindow, "100"], [SETTING.modelTimeout, "0"]] as const) {
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
