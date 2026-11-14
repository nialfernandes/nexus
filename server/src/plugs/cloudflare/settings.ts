// The settings plug: reads what the person running Nexus chose from the Worker's variables. Each one is optional and
// left out means none (ports.ts says what none means for each). A value that is there but cannot be used is an
// error, not a quiet none: a typo in the owner's name must not leave Nexus closed (or open) without anyone knowing.
//
//   NEXUS_OWNER    the owner's identity name: lower case letters, digits and hyphens, such as `owner`.
//   NEXUS_ADDRESS  the public address of this Nexus, such as https://nexus.example.org (only the scheme, host and
//                  port are kept).

import { NAME } from "../../identities";
import type { NexusSettings } from "../../ports";

/** The variables this plug reads for the settings. */
export interface SettingsEnv {
  NEXUS_OWNER?: string;
  NEXUS_ADDRESS?: string;
}

/** A variable's text with the spaces around it taken off, or undefined when it is not set or is blank. */
const variable = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

export function settingsFromEnv(env: unknown): NexusSettings {
  const { NEXUS_OWNER, NEXUS_ADDRESS } = env as SettingsEnv;

  const owner = variable(NEXUS_OWNER) ?? null;
  if (owner !== null && !NAME.test(owner)) {
    throw new Error("NEXUS_OWNER has to be lower case letters, digits and hyphens, such as owner.");
  }

  let address: string | null = null;
  const given = variable(NEXUS_ADDRESS);
  if (given !== undefined) {
    let url: URL;
    try {
      url = new URL(given);
    } catch {
      throw new Error("NEXUS_ADDRESS has to be a web address, such as https://nexus.example.org.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("NEXUS_ADDRESS has to start with https:// (or http:// for a local test).");
    }
    address = url.origin;
  }

  return { owner, address };
}
