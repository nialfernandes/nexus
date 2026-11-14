// Base64 for the blobs the server holds, written without a Node module (a phone has no `Buffer`). The server takes and gives
// standard base64 with its `=` padding and refuses anything else, so that is what is written and read. The tests compare it with
// Node's own, which the plugin never uses.

import { describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64, encodeBase64Url } from "../src/base64";

const bytesOf = (length: number): Uint8Array => Uint8Array.from({ length }, (_, i) => (i * 37 + 11) % 256);

describe("base64", () => {
  it("writes what Node writes, for every length from 0 to 70 (every padding) and for a blob of 300 000 bytes", () => {
    for (let length = 0; length <= 70; length++) expect(encodeBase64(bytesOf(length)), `length ${length}`).toBe(Buffer.from(bytesOf(length)).toString("base64"));
    const big = bytesOf(300_000);
    expect(encodeBase64(big)).toBe(Buffer.from(big).toString("base64"));
  });

  it("reads back what it wrote", () => {
    for (const length of [0, 1, 2, 3, 4, 31, 32, 33, 1000, 300_000]) {
      expect(decodeBase64(encodeBase64(bytesOf(length))), `length ${length}`).toEqual(bytesOf(length));
    }
  });

  it("refuses what the server refuses: no padding, the wrong alphabet, spaces, a bad length", () => {
    for (const text of ["QQ", "QQ=", "QUJD=", "QU-D", "QU_D", "Q U J D", "QUJD\\n", "====", "QQ==QQ==", "é", "QUJDR"]) expect(decodeBase64(text), JSON.stringify(text)).toBeNull();
    expect(decodeBase64("")).toEqual(new Uint8Array());
    expect(decodeBase64("QQ==")).toEqual(Uint8Array.of(65));
  });

  it("writes the url-safe form without padding, which is what a note id is", () => {
    const bytes = Uint8Array.of(0xfb, 0xff, 0xfe, 0x01);
    expect(Buffer.from(bytes).toString("base64")).toBe("+//+AQ==");
    expect(encodeBase64Url(bytes)).toBe("-__-AQ");
    expect(encodeBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
  });
});
