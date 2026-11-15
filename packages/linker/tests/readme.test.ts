// The README and the Worker's example configuration say every setting the job reads, and the example holds no real id.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_CHECKS, DEFAULT_MAX_FAILURES, DEFAULT_MAX_NOTES, DEFAULT_STATE_NOTE, DEFAULT_TIMEOUT_SECONDS, DEFAULT_WINDOW_CHARS, SETTING, VAULT_SETTING } from "../src/settings";

const here = new URL("../", import.meta.url).pathname;
const readme = readFileSync(join(here, "README.md"), "utf8");
const example = readFileSync(join(here, "wrangler.example.toml"), "utf8");
const everySetting = [...Object.values(SETTING), ...Object.values(VAULT_SETTING)];

describe("the README", () => {
  it("names every setting, in the table of settings", () => {
    const table = readme.slice(readme.indexOf("## The settings"), readme.indexOf("## Running it"));
    for (const name of everySetting) expect(table, name).toContain(`| \`${name}\` |`);
  });

  it("says the defaults the code has", () => {
    expect(readme).toContain(`| \`LINKER_MAX_NOTES\` | The most notes a run takes on | no, ${DEFAULT_MAX_NOTES} |`);
    expect(readme).toContain(`| no, ${DEFAULT_MAX_CHECKS} |`);
    expect(readme).toContain(`| no, ${DEFAULT_MAX_FAILURES} |`);
    expect(readme).toContain(`| no, \`${DEFAULT_STATE_NOTE}\` |`);
    expect(readme).toContain(`| no, ${DEFAULT_WINDOW_CHARS} |`);
    expect(readme).toContain(`| no, ${DEFAULT_TIMEOUT_SECONDS} |`);
  });
});

describe("the Worker's example configuration", () => {
  it("names every setting, the secrets as secrets and the rest as variables", () => {
    const secrets = [VAULT_SETTING.token, VAULT_SETTING.privateKey, VAULT_SETTING.approval, SETTING.modelKey] as const;
    const vars = example.slice(example.indexOf("[vars]"));
    for (const name of everySetting) expect(example, name).toContain(name);
    for (const name of secrets) expect(vars.slice(0, vars.indexOf("# Secrets")), `${name} is not a variable`).not.toMatch(new RegExp(`^${name}\\s*=`, "m"));
    for (const name of everySetting.filter((one) => !(secrets as readonly string[]).includes(one))) expect(vars, name).toMatch(new RegExp(`^(# )?${name} = "`, "m"));
  });

  it("wakes on a cron trigger, and runs the Worker's source", () => {
    expect(example).toMatch(/^\[triggers\]\s*\ncrons = \["[^"]+"\]/m);
    expect(example).toMatch(/^main = "src\/worker\.ts"$/m);
    expect(readFileSync(join(here, "src/worker.ts"), "utf8")).toMatch(/\bscheduled\b/);
  });

  it("holds no real id, key or address: only the example's own", () => {
    expect(example).not.toMatch(/account_id|zone_id|database_id|kv_namespaces|route\s*=|\b[0-9a-f]{32}\b|nx_[0-9a-f]{8}/i);
    const addresses = [...example.matchAll(/https?:\/\/[^\s"]+/g)].map((match) => new URL(match[0]).hostname);
    for (const host of addresses) expect(host, host).toMatch(/\.example\.org$/);
  });
});
