// The settings the person running Nexus chooses, as the Cloudflare plug reads them from the Worker's variables: the
// owner's name and the public address. Each is optional and left out means none. A value that is there but cannot be
// used is an error that says which variable is wrong, never a quiet none.

import { describe, expect, it } from "vitest";
import { settingsFromEnv } from "./plugs/cloudflare/settings";

describe("with nothing set", () => {
  it("has no owner and no address", () => {
    expect(settingsFromEnv({})).toEqual({ owner: null, address: null });
  });

  it("treats variables that are blank, or not text, as not set", () => {
    expect(settingsFromEnv({ NEXUS_OWNER: "", NEXUS_ADDRESS: "   " })).toEqual({ owner: null, address: null });
    expect(settingsFromEnv({ NEXUS_OWNER: 7, NEXUS_ADDRESS: null })).toEqual({ owner: null, address: null });
  });
});

describe("the owner", () => {
  it("is the name given, with the spaces around it taken off", () => {
    expect(settingsFromEnv({ NEXUS_OWNER: " alice-2 " }).owner).toBe("alice-2");
  });

  it("has to be a name an identity can have: lower case letters, digits and hyphens", () => {
    for (const bad of ["Alice", "a b", "-alice", "alice_2", "a".repeat(41), "alice/bob"]) {
      expect(() => settingsFromEnv({ NEXUS_OWNER: bad }), bad).toThrow(/NEXUS_OWNER/);
    }
  });
});

describe("the address", () => {
  it("keeps only the scheme, host and port, so a link built on it is never doubled up", () => {
    expect(settingsFromEnv({ NEXUS_ADDRESS: "https://nexus.example.org/some/path?x=1#top" }).address).toBe("https://nexus.example.org");
    expect(settingsFromEnv({ NEXUS_ADDRESS: "http://localhost:8787/" }).address).toBe("http://localhost:8787");
  });

  it("has to be a web address", () => {
    for (const bad of ["nexus.example.org", "not a web address", "ftp://nexus.example.org", "javascript:alert(1)"]) {
      expect(() => settingsFromEnv({ NEXUS_ADDRESS: bad }), bad).toThrow(/NEXUS_ADDRESS/);
    }
  });
});
