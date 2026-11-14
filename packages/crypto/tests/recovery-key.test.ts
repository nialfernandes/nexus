import { describe, expect, it } from "vitest";
import {
  formatRecoveryKey,
  generateRecoveryKey,
  NexusCryptoError,
  parseRecoveryKey,
  RECOVERY_ALPHABET,
} from "../src/index.js";
import { RECOVERY_KEY, RECOVERY_KEY_TEXT } from "./fixtures.js";
import { toHex } from "./helpers.js";

async function refusal(promise: Promise<unknown>): Promise<NexusCryptoError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NexusCryptoError);
    return error as NexusCryptoError;
  }
  throw new Error("expected the call to be refused");
}

/** The pinned text with the character at `index` (counting only symbols, not hyphens) replaced. */
function withSymbol(text: string, index: number, symbol: string): string {
  const symbols = text.replace(/-/g, "");
  return (symbols.slice(0, index) + symbol + symbols.slice(index + 1)).replace(/(.{4})(?=.)/g, "$1-");
}

describe("the written Recovery Key", () => {
  it("is 14 groups of 4 symbols from the alphabet, and reads back to the same bytes", async () => {
    const text = await formatRecoveryKey(RECOVERY_KEY);
    expect(text).toBe(RECOVERY_KEY_TEXT);
    expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(toHex(await parseRecoveryKey(text))).toBe(toHex(RECOVERY_KEY));
  });

  it("round-trips many random keys", async () => {
    for (let i = 0; i < 50; i++) {
      const key = await generateRecoveryKey();
      expect(key.length).toBe(32);
      expect(toHex(await parseRecoveryKey(await formatRecoveryKey(key)))).toBe(toHex(key));
    }
  });

  it("round-trips the extreme keys", async () => {
    for (const fill of [0x00, 0xff]) {
      const key = new Uint8Array(32).fill(fill);
      expect(toHex(await parseRecoveryKey(await formatRecoveryKey(key)))).toBe(toHex(key));
    }
  });

  it("uses the same 32 symbols as the approval codes: no I, L, O or U", () => {
    expect(RECOVERY_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
  });

  it("reads small letters, spaces, line breaks, and O, I, L for 0, 1, 1", async () => {
    const lower = RECOVERY_KEY_TEXT.toLowerCase().replace(/-/g, " \n");
    expect(toHex(await parseRecoveryKey(lower))).toBe(toHex(RECOVERY_KEY));
    const confusable = await formatRecoveryKey(new Uint8Array(32)); // all zero symbols
    expect(toHex(await parseRecoveryKey(confusable.replace(/0/g, "O")))).toBe(toHex(new Uint8Array(32)));
  });

  it("catches every single mistyped symbol of the pinned key (a miss is about one in a million for any other key)", async () => {
    for (let index = 0; index < 56; index++) {
      const original = RECOVERY_KEY_TEXT.replace(/-/g, "")[index]!;
      for (const symbol of RECOVERY_ALPHABET) {
        if (symbol === original) continue;
        const error = await refusal(parseRecoveryKey(withSymbol(RECOVERY_KEY_TEXT, index, symbol)));
        expect(error.code, `symbol ${index} -> ${symbol}`).toBe("bad-recovery-key");
      }
    }
  });

  it("catches two swapped neighbouring symbols", async () => {
    const symbols = RECOVERY_KEY_TEXT.replace(/-/g, "");
    for (let i = 0; i < 55; i++) {
      if (symbols[i] === symbols[i + 1]) continue;
      const swapped = symbols.slice(0, i) + symbols[i + 1] + symbols[i] + symbols.slice(i + 2);
      expect((await refusal(parseRecoveryKey(swapped))).code, `swap ${i}`).toBe("bad-recovery-key");
    }
  });

  it("refuses a wrong length, a foreign character, and text that is not text", async () => {
    expect((await refusal(parseRecoveryKey(RECOVERY_KEY_TEXT.slice(0, -1)))).code).toBe("bad-recovery-key");
    expect((await refusal(parseRecoveryKey(RECOVERY_KEY_TEXT + "0"))).code).toBe("bad-recovery-key");
    expect((await refusal(parseRecoveryKey(""))).code).toBe("bad-recovery-key");
    expect((await refusal(parseRecoveryKey(withSymbol(RECOVERY_KEY_TEXT, 3, "U")))).message).toMatch(/character 4/);
    expect((await refusal(parseRecoveryKey(null as unknown as string))).code).toBe("bad-recovery-key");
  });

  it("refuses a last key symbol that sets the unused bits, even with matching check characters", async () => {
    // Symbol 52 holds one key bit and four unused zero bits. Setting an unused bit
    // would read as the same key, so the text is refused as not canonical.
    const symbols = RECOVERY_KEY_TEXT.replace(/-/g, "");
    const last = RECOVERY_ALPHABET.indexOf(symbols[51]!);
    const altered = RECOVERY_ALPHABET[last | 1]!;
    const error = await refusal(parseRecoveryKey(withSymbol(RECOVERY_KEY_TEXT, 51, altered)));
    expect(error.code).toBe("bad-recovery-key");
  });

  it("refuses a key that is not 32 bytes", async () => {
    expect((await refusal(formatRecoveryKey(new Uint8Array(31)))).code).toBe("invalid-argument");
  });
});
