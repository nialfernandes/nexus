// How the Cloudflare plug tells one caller from another (plugs/cloudflare/network.ts): an IPv4 address as it stands, an IPv6 address by
// its /64, and nothing at all for a header that is missing or is not an address, so that Nexus then applies only the limits that need no
// caller. The routes' use of it is in signin-caps.test.ts.

import { describe, expect, it } from "vitest";
import { callerOf, cloudflareNetwork } from "./plugs/cloudflare/network";

const requestFrom = (address?: string) => new Request("https://nexus.example.test/", { headers: address === undefined ? {} : { "cf-connecting-ip": address } });

describe("the Cloudflare network plug", () => {
  it("reads the caller from cf-connecting-ip, and gives null when the header is not there", () => {
    expect(cloudflareNetwork.callerAddress(requestFrom("203.0.113.7"))).toBe("203.0.113.7");
    expect(cloudflareNetwork.callerAddress(requestFrom())).toBeNull();
  });

  it("keeps an IPv4 address as it stands, and an IPv4 address written the long IPv6 way is the same caller", () => {
    expect(callerOf(" 198.51.100.4 ")).toBe("198.51.100.4");
    expect(callerOf("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(callerOf("::ffff:c633:6404")).toBe("198.51.100.4");
  });

  it("tells an IPv6 address by its first four groups, however it is written", () => {
    const same = ["2001:db8:1:2::1", "2001:0DB8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:2:0:0:0:0", "2001:db8:1:2::"];
    for (const address of same) expect(callerOf(address), address).toBe("2001:db8:1:2::/64");
    expect(callerOf("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(callerOf("::1")).toBe("0:0:0:0::/64");
    expect(callerOf("2001:db8::")).toBe("2001:db8:0:0::/64");
  });

  it("gives null for anything that is not an address", () => {
    for (const bad of [null, "", "  ", "unknown", "999.1.1.1", "1.2.3", "1.2.3.4.5", "2001:db8:::1", "2001:db8::1::2", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", "g::1", "12345::1", "1.2.3.4, 5.6.7.8", "x".repeat(100)]) {
      expect(callerOf(bad), String(bad)).toBeNull();
    }
  });
});
