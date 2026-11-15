import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ERROR_CODES, FORMAT_VERSION, PASSWORD_KDF, PASSWORD_KDF_LIMITS, RECOVERY_ALPHABET, encryptNote,
} from "../src/index.js";
import { APPROVAL_CODE_LABEL, APPROVAL_CODE_SYMBOLS, MAX_ID_BYTES, MIN_PADDED_RECORD_BYTES, RECOVERY_CHECK_LABEL, RECOVERY_KDF_LABEL, Kind } from "../src/constants.js";
import { MIN_NOTE_BLOB_BYTES } from "../src/note.js";
import { PASSWORD_WRAP_BYTES, RECOVERY_WRAP_BYTES } from "../src/wraps.js";
import * as format from "../src/format.js";
import { fromHex } from "./helpers.js";
import { APPROVAL_CODE_TEXT, NOTE_BLOB_HEX, NOTE_CONTEXT, PASSWORD_WRAP_HEX, RECOVERY_KEY_TEXT, RECOVERY_WRAP_HEX, VAULT_KEY } from "./fixtures.js";

const doc = readFileSync(new URL("../../../docs/FORMAT.md", import.meta.url), "utf8");
const docWithoutLineBreaks = doc.replace(/\n/g, "");

describe("docs/FORMAT.md says what the code does", () => {
  it("lists every error code as a row of the errors table", () => {
    for (const code of ERROR_CODES) expect(doc, code).toContain(`| \`${code}\` |`);
  });

  it("holds the pinned worked examples byte for byte", () => {
    for (const hex of [NOTE_BLOB_HEX, RECOVERY_WRAP_HEX, PASSWORD_WRAP_HEX]) expect(docWithoutLineBreaks).toContain(hex);
    expect(doc).toContain(RECOVERY_KEY_TEXT);
    expect(doc).toContain(APPROVAL_CODE_TEXT);
  });

  it("writes the matching code's derivation: its label, how many symbols and what goes into the hash", () => {
    expect(doc).toContain(`"${APPROVAL_CODE_LABEL}"`);
    expect(doc).toContain(`the first ${APPROVAL_CODE_SYMBOLS * 5} bits of digest, as ${APPROVAL_CODE_SYMBOLS} symbols`);
    expect(doc).toContain(`The label is the ${APPROVAL_CODE_LABEL.length} ASCII bytes`);
    expect(doc).toContain('digest = SHA-256( "nexus v1 approval code" || N || A || kid (4) || SHA-256(S) )');
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

describe("the numbers a part of Nexus that never opens a blob takes from @nexus/crypto/format (src/format.ts)", () => {
  it("are the version, the kind bytes and the sizes the code writes and the document states", async () => {
    expect(format.FORMAT_VERSION).toBe(FORMAT_VERSION);
    expect(format.Kind).toBe(Kind);
    expect(format.RECOVERY_WRAP_BYTES).toBe(RECOVERY_WRAP_BYTES);
    expect(format.PASSWORD_WRAP_BYTES).toBe(PASSWORD_WRAP_BYTES);
    expect(format.RECOVERY_WRAP_BYTES).toBe(fromHex(RECOVERY_WRAP_HEX).length);
    expect(format.PASSWORD_WRAP_BYTES).toBe(fromHex(PASSWORD_WRAP_HEX).length);
    expect(doc).toContain(`at least ${format.MIN_WRITTEN_NOTE_BLOB_BYTES}`);
    expect(doc).toContain(`${format.MIN_WRITTEN_NOTE_BLOB_BYTES} bytes = 1 + 4 + 24 + ${MIN_PADDED_RECORD_BYTES} + 16`);
    // The smallest note blob the library writes is exactly that long: an empty note, padded to the floor.
    const smallest = await encryptNote(VAULT_KEY, NOTE_CONTEXT, { path: "", text: "" });
    expect(smallest.length).toBe(format.MIN_WRITTEN_NOTE_BLOB_BYTES);
    expect(format.NOTE_HEADER_BYTES).toBe(1 + 4 + 24);
    expect(smallest.length).toBeGreaterThan(MIN_NOTE_BLOB_BYTES);
  });
});
