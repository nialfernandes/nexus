// The fingerprint kept with every version is SHA-256 of the encrypted blob, as 64 lower case hex characters. These are
// the published test values of FIPS 180-4 (also in RFC 6234), so a change to what is hashed or how it is written is
// caught here and not in a stored fingerprint years on. The hash is worked out by the host (the Cloudflare plug's
// secrets), through blobHash.

import { describe, expect, it } from "vitest";
import { blobHash } from "./hash";
import { workerSecrets } from "./plugs/cloudflare/secrets";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("blobHash", () => {
  it("matches the published SHA-256 values", async () => {
    expect(await blobHash(workerSecrets, bytes(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await blobHash(workerSecrets, bytes("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await blobHash(workerSecrets, bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("is 64 lower case hex characters for any bytes, every byte value included", async () => {
    const every = Uint8Array.from({ length: 256 }, (_, n) => n);
    expect(await blobHash(workerSecrets, every)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tells one blob from another, down to a single bit", async () => {
    const one = Uint8Array.from([1, 2, 3, 4]);
    const other = Uint8Array.from([1, 2, 3, 5]);
    expect(await blobHash(workerSecrets, one)).toBe(await blobHash(workerSecrets, Uint8Array.from([1, 2, 3, 4])));
    expect(await blobHash(workerSecrets, one)).not.toBe(await blobHash(workerSecrets, other));
  });
});
