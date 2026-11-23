// The network plug: who a request came from, on Cloudflare. Like the rest of this folder it is the only Nexus code that reads
// a Cloudflare header, so the logic (devices.ts) stays portable and another host can give its own.
//
// Cloudflare gives `cf-connecting-ip` as the address the visitor called from (its HTTP headers page says so; it does not say in so many
// words that a value a visitor sends is replaced, which this relies on: see the assumptions in server/README.md). Run anywhere else
// (a test, a copy behind another proxy) the header is not there, or is whatever the proxy made of it: a value that is not an address is
// no address, and Nexus then applies only its limits that need no caller.
//
// An IPv4 address is the caller as it stands. A caller on IPv6 usually holds a whole /64 (billions of addresses) and can
// change the end of its address at will, so it is told by its /64: the first four groups.

import type { NexusNetwork } from "../../ports";

const HEADER = "cf-connecting-ip";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const GROUP = /^[0-9a-f]{1,4}$/i;

/** An IPv4 address written as four numbers, as it stands, or null when it is not one. */
function ipv4(text: string): string | null {
  const match = IPV4.exec(text);
  if (match === null) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((n) => n <= 255) ? octets.join(".") : null;
}

/** The eight 16-bit groups of an IPv6 address, or null when the text is not one. A tail such as ::ffff:1.2.3.4 is two groups. */
function ipv6Groups(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const read = (part: string): number[] | null => {
    if (part === "") return [];
    const words = part.split(":");
    const last = words[words.length - 1]!;
    if (last.includes(".")) {
      const v4 = ipv4(last);
      if (v4 === null) return null;
      const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
      words.splice(words.length - 1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
    }
    return words.every((w) => GROUP.test(w)) ? words.map((w) => parseInt(w, 16)) : null;
  };
  const head = read(halves[0]!);
  const tail = halves.length === 2 ? read(halves[1]!) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  return missing < 1 ? null : [...head, ...Array<number>(missing).fill(0), ...tail];
}

/** The text that stands for one caller, from the address Cloudflare gave: the address (IPv4) or its /64 (IPv6), or null. */
export function callerOf(address: string | null): string | null {
  const text = address?.trim() ?? "";
  if (text === "" || text.length > 45) return null;
  const v4 = ipv4(text);
  if (v4 !== null) return v4;
  const groups = ipv6Groups(text);
  if (groups === null) return null;
  // ::ffff:1.2.3.4 is an IPv4 caller written the long way.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

export const cloudflareNetwork: NexusNetwork = {
  callerAddress: (request) => callerOf(request.headers.get(HEADER)),
};
