// Where Nexus answers. Every address is under one prefix, `/nexus`: the API at `/nexus/api/...` and the device approval
// page at `/nexus/approve`. The prefix used to be `/apps/nexus`, a name that belonged to the host this server began
// on. The old prefix keeps answering, with the same handlers, for one release so a device that has not been updated
// still reaches the server (server/README.md says so). Nothing else in Nexus writes these strings.

/** The prefix every address starts with. */
export const NEXUS_PREFIX = "/nexus";

/** The old prefix, answered for one release and then removed. */
export const LEGACY_PREFIX = "/apps/nexus";

/** Both prefixes, the one to use first. */
export const PREFIXES: readonly string[] = [NEXUS_PREFIX, LEGACY_PREFIX];

/** The API's base address: a route called `save` is at `/nexus/api/save`. */
export const NEXUS_BASE = `${NEXUS_PREFIX}/api`;

/** The API's base address under the old prefix. */
export const LEGACY_BASE = `${LEGACY_PREFIX}/api`;

/** Where the approval page lives: the link a device is handed opens it. */
export const APPROVE_PATH = `${NEXUS_PREFIX}/approve`;

/** The path after the API's base address, or null when the address is not under either base. `/nexus/api/save` is `save`. */
export function routeName(pathname: string): string | null {
  for (const base of [NEXUS_BASE, LEGACY_BASE]) {
    if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length + 1);
  }
  return null;
}
