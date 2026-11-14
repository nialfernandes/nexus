import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ERROR_CODES, FORMAT_VERSION, PASSWORD_KDF, PASSWORD_KDF_LIMITS, RECOVERY_ALPHABET,
} from "../src/index.js";
import { MAX_ID_BYTES, MIN_PADDED_RECORD_BYTES, RECOVERY_CHECK_LABEL, RECOVERY_KDF_LABEL, Kind } from "../src/constants.js";
import { MIN_NOTE_BLOB_BYTES } from "../src/note.js";
import { PASSWORD_WRAP_BYTES, RECOVERY_WRAP_BYTES } from "../src/wraps.js";
import { NOTE_BLOB_HEX, PASSWORD_WRAP_HEX, RECOVERY_KEY_TEXT, RECOVERY_WRAP_HEX } from "./fixtures.js";

const doc = readFileSync(new URL("../../../docs/FORMAT.md", import.meta.url), "utf8");
const docWithoutLineBreaks = doc.replace(/\n/g, "");

describe("docs/FORMAT.md says what the code does", () => {
  it("lists every error code as a row of the errors table", () => {
    for (const code of ERROR_CODES) expect(doc, code).toContain(`| \`${code}\` |`);
  });

  it("holds the pinned worked examples byte for byte", () => {
    for (const hex of [NOTE_BLOB_HEX, RECOVERY_WRAP_HEX, PASSWORD_WRAP_HEX]) expect(docWithoutLineBreaks).toContain(hex);
    expect(doc).toContain(RECOVERY_KEY_TEXT);
  });

  it("states the version, labels, alphabet and limits the code uses", () => {
    expect(FORMAT_VERSION).toBe(1);
    expect(doc).toContain("`0x01`");
    expect(doc).toContain(`"${RECOVERY_KDF_LABEL}"`);
    expect(doc).toContain(`"${RECOVERY_CHECK_LABEL}"`);
    expect(doc).toContain(RECOVERY_ALPHABET);
    expect(doc).toContain(`${MAX_ID_BYTES} UTF-8 bytes`);
    expect(doc).toContain(`\`m = ${PASSWORD_KDF.memoryKiB}\``);
    expect(doc).toMatch(new RegExp(`\`m\` from ${PASSWORD_KDF_LIMITS.memoryKiB.min} to ${PASSWORD_KDF_LIMITS.memoryKiB.max}`));
    expect(doc).toMatch(new RegExp(`\`t\` from ${PASSWORD_KDF_LIMITS.iterations.min} to ${PASSWORD_KDF_LIMITS.iterations.max}`));
  });

  it("states the padding floor, the kid in the header and the approval caveat", () => {
    expect(doc).toContain(`padme(max(n + 1, ${MIN_PADDED_RECORD_BYTES}))`);
    expect(doc).toContain(`at least ${MIN_PADDED_RECORD_BYTES} bytes`);
    expect(doc).toContain(`at least ${1 + 4 + 24 + MIN_PADDED_RECORD_BYTES + 16}`);
    expect(doc).toMatch(/1\s+4\s+kid, the number of the vault key/);
    expect(doc).toMatch(/5\s+24\s+nonce/);
    expect(doc).toMatch(/29\s+n \+ 16\s+AEAD ciphertext/);
    expect(doc).toContain("An approval alone is not authenticated.");
  });

  it("states the kind bytes and the sizes", () => {
    expect(doc).toContain(`\`0x0${Kind.note}\` | note blob`);
    expect(doc).toContain(`\`0x0${Kind.recoveryWrap}\` | recovery wrap`);
    expect(doc).toContain(`\`0x0${Kind.passwordWrap}\` | password wrap`);
    expect(doc).toContain(`\`0x0${Kind.approval}\` | sealed approval`);
    expect(doc).toContain(`shortest blob a reader can open is ${MIN_NOTE_BLOB_BYTES} bytes`);
    expect(doc).toContain(`Recovery wrap (${RECOVERY_WRAP_BYTES} bytes)`);
    expect(doc).toContain(`Password wrap (${PASSWORD_WRAP_BYTES} bytes)`);
  });
});
