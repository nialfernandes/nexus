// The settings plug: reads what the person running Nexus chose from the Worker's variables. Each one is optional and
// left out means none, or for the page size its default (ports.ts says what leaving each out means). A value that is there but cannot be used is an
// error, not a quiet none: a typo in the owner's name must not leave Nexus closed (or open) without anyone knowing.
//
//   NEXUS_OWNER    the owner's identity name: lower case letters, digits and hyphens, such as `owner`.
//   NEXUS_ADDRESS  the public address of this Nexus, such as https://nexus.example.org (only the scheme, host and
//                  port are kept).
//   NEXUS_CHANGES_PAGE_BYTES
//                  the most blob text one page of the changes feed sends, in bytes: a whole number, 1 or more. Left
//                  out it is 4,000,000.

import { NAME } from "../../identities";
import type { NexusSettings } from "../../ports";
import { DEFAULT_CHANGES_PAGE_BYTES } from "../../store";

/** The variables this plug reads for the settings. */
export interface SettingsEnv {
  NEXUS_OWNER?: string;
  NEXUS_ADDRESS?: string;
  NEXUS_CHANGES_PAGE_BYTES?: string;
}

/** A variable's text with the spaces around it taken off, or undefined when it is not set or is blank. */
const variable = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

export function settingsFromEnv(env: unknown): NexusSettings {
  const { NEXUS_OWNER, NEXUS_ADDRESS, NEXUS_CHANGES_PAGE_BYTES } = env as SettingsEnv;

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

  let changesPageBytes = DEFAULT_CHANGES_PAGE_BYTES;
  const bytes = variable(NEXUS_CHANGES_PAGE_BYTES);
  if (bytes !== undefined) {
    if (!/^[1-9]\d{0,15}$/.test(bytes)) {
      throw new Error("NEXUS_CHANGES_PAGE_BYTES has to be a whole number of bytes, 1 or more, such as 4000000.");
    }
    changesPageBytes = Number(bytes);
  }

  return { owner, address, changesPageBytes };
}
