// Where Nexus answers. Every address is under one prefix, `/nexus`: the API at `/nexus/api/...` and the device approval
// page at `/nexus/approve`. The prefix used to be `/apps/nexus`, a name that belonged to the host this server began on.
// That prefix is gone: an address under it is not Nexus's, and is a 404 like any other. Nothing else in Nexus writes
// these strings.

/** The prefix every address starts with. */
export const NEXUS_PREFIX = "/nexus";

/** The API's base address: a route called `save` is at `/nexus/api/save`. */
export const NEXUS_BASE = `${NEXUS_PREFIX}/api`;

/** Where the approval page lives: the link a device is handed opens it. */
export const APPROVE_PATH = `${NEXUS_PREFIX}/approve`;

/** The path after the API's base address, or null when the address is not under it. `/nexus/api/save` is `save`. */
export function routeName(pathname: string): string | null {
  return pathname.startsWith(`${NEXUS_BASE}/`) ? pathname.slice(NEXUS_BASE.length + 1) : null;
}
