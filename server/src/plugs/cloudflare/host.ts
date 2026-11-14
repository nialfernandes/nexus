// Builds a NexusHost from a Cloudflare Worker's bindings and variables. This and its siblings are the ONLY code in
// Nexus that names a Cloudflare type or reads `env`, and this is the one place that names the database binding.

import type { NexusHost, SqlDb } from "../../ports";
import { d1Sql } from "./d1";
import { workerSecrets } from "./secrets";
import { settingsFromEnv, type SettingsEnv } from "./settings";
import { ownerSignIn, type SignInEnv } from "./signin";

/** Everything Nexus reads from the Worker. Every one is optional on the type, so a Worker missing one still loads. */
export interface NexusEnv extends SettingsEnv, SignInEnv {
  /** Nexus's own D1 database. */
  NEXUS_DB?: D1Database;
  /** The static assets (wrangler.jsonc `assets`): the device approval page. */
  ASSETS?: Fetcher;
}

/** What stands in when no database is bound: every question fails, and Nexus answers that it cannot answer. */
const noDatabase: SqlDb = {
  first: () => Promise.reject(new Error("NEXUS_DB is not bound")),
  all: () => Promise.reject(new Error("NEXUS_DB is not bound")),
  run: () => Promise.reject(new Error("NEXUS_DB is not bound")),
  batch: () => Promise.reject(new Error("NEXUS_DB is not bound")),
};

/** The database, the clock, the secrets and the settings from the Worker's bindings: all an app inside the Worker needs. */
export function hostFromEnv(env: unknown): Omit<NexusHost, "signIn"> {
  const db = (env as NexusEnv).NEXUS_DB;
  return {
    sql: db ? d1Sql(db) : noDatabase,
    clock: { now: () => Date.now() },
    secrets: workerSecrets,
    settings: settingsFromEnv(env),
  };
}

export function cloudflareHost(env: NexusEnv): NexusHost {
  const host = hostFromEnv(env);
  return { ...host, signIn: ownerSignIn(env, host.settings) };
}
