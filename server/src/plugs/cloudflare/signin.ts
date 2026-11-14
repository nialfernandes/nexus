// The sign-in plug: the owner's browser session, as the identity named by the `owner` setting.
//
// A Cloudflare Worker has no accounts of its own, so this plug keeps the smallest thing that works: the owner holds a
// long secret (the Worker secret NEXUS_OWNER_SECRET) and presents it in the cookie `nexus_owner`. The cookie is the
// owner's session. Nobody else has the secret, so nobody else is let in. A bearer token is not checked here: Nexus
// checks those itself, against its own tokens (identities.ts).
//
// With no owner set, or no secret set, nobody is let in by a cookie. The secret is compared by its hash, so the time
// the comparison takes says nothing about how much of a guess was right.

import type { NexusSettings, NexusSignIn, Secrets } from "../../ports";
import { workerSecrets } from "./secrets";

/** The cookie the owner's secret travels in. */
export const OWNER_COOKIE = "nexus_owner";

/** The shortest secret that is accepted: 32 characters, such as the output of `openssl rand -hex 32`. */
export const MIN_SECRET_LENGTH = 32;

/** The variable this plug reads for the owner's secret. */
export interface SignInEnv {
  NEXUS_OWNER_SECRET?: string;
}

/** The value of one cookie in a request, or undefined when it is not there. */
function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** True when two texts of the same length are the same, looking at all of both however early they differ. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export function ownerSignIn(env: SignInEnv, settings: NexusSettings, secrets: Secrets = workerSecrets): NexusSignIn {
  const secret = typeof env.NEXUS_OWNER_SECRET === "string" ? env.NEXUS_OWNER_SECRET : "";
  if (secret !== "" && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`NEXUS_OWNER_SECRET has to be at least ${MIN_SECRET_LENGTH} characters. Make one with: openssl rand -hex 32`);
  }
  return {
    async identify(request) {
      if (settings.owner === null || secret === "") return null;
      const given = cookieValue(request, OWNER_COOKIE);
      if (given === undefined || given === "") return null;
      // Both are hashed to the same length first, so the comparison never depends on how long the guess was.
      return sameText(await secrets.hash(given), await secrets.hash(secret)) ? { identity: settings.owner } : null;
    },
  };
}
