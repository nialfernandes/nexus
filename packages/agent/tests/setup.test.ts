// The key steps `nexus-agent create-vault` and `approve-agent` share with the plugin's setup controller (src/setup.ts), one at a time:
// a new vault's keys and the check characters, the Recovery wrap's request, reading the wrap Nexus holds, opening it with a typed Recovery
// Key, and the approval for an agent. The commands' own tests (cli.test.ts, refusals.test.ts) hold what they print.

import { devicePublicKey, generateDeviceKeyPair, generateRecoveryKey, formatRecoveryKey, openApproval, parseRecoveryKey, unwrapVaultKeyWithRecoveryKey } from "@nexus/crypto";
import { describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64 } from "../src/base64";
import {
  FIRST_KID, RECOVERY_KEY_GROUPS, TYPE_BACK_GROUPS, TYPE_BACK_TRIES, approvalForAgent, forgetNewVault, groupsToTypeBack, holdsAVault, holdsAWrap,
  isTypedBack, makeNewVault, newestPasswordWrap, newestRecoveryWrap, openPasswordWrapHeld, openRecoveryWrap, passwordWrapRequest,
  publicKeyCode, readAgentPublicKey, recoveryWrapRequest, wrongGroups,
} from "../src/setup";

describe("a new vault", () => {
  it("has a vault key, a Recovery Key written in 14 groups of 4, a url-safe vault id of 16 random bytes and the first key number", async () => {
    const vault = await makeNewVault();
    expect(vault.vaultKey).toHaveLength(32);
    expect(vault.recoveryKey).toHaveLength(32);
    expect(vault.recoveryKeyText).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){13}$/);
    expect(vault.vaultId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(vault.kid).toBe(FIRST_KID);
    expect(vault.checkGroup).toBe(vault.recoveryKeyText.split("-").at(-1));
    expect(Array.from(await parseRecoveryKey(vault.recoveryKeyText)), "the text is the key").toEqual(Array.from(vault.recoveryKey));
    const other = await makeNewVault();
    expect(other.vaultId).not.toBe(vault.vaultId);
    expect(other.recoveryKeyText).not.toBe(vault.recoveryKeyText);
  });

  it("is forgotten by overwriting both keys", async () => {
    const vault = await makeNewVault();
    forgetNewVault(vault);
    expect(vault.vaultKey.every((byte) => byte === 0)).toBe(true);
    expect(vault.recoveryKey.every((byte) => byte === 0)).toBe(true);
  });

  it("is typed back with small letters, capitals, hyphens or spaces, and O for 0, I or L for 1; nothing else passes; three tries", async () => {
    expect(TYPE_BACK_TRIES).toBe(3);
    const vault = await makeNewVault();
    const group = vault.checkGroup;
    expect(isTypedBack(group, group)).toBe(true);
    expect(isTypedBack(` ${group.toLowerCase()} `, group)).toBe(true);
    expect(isTypedBack(`${group.slice(0, 2)}-${group.slice(2)}`, group)).toBe(true);
    expect(isTypedBack(group.replace(/0/g, "O").replace(/1/g, "l"), group)).toBe(true);
    expect(isTypedBack("", group)).toBe(false);
    expect(isTypedBack(group.slice(1), group)).toBe(false);
    expect(isTypedBack(`${group}A`, group)).toBe(false);
    expect(isTypedBack(`${group[0] === "9" ? "8" : "9"}${group.slice(1)}`, group)).toBe(false);
  });

  it("makes the request `POST /wrap` takes: the Recovery wrap the Recovery Key opens, sent with the vault id and the key number", async () => {
    const vault = await makeNewVault();
    const request = await recoveryWrapRequest(vault);
    expect(Object.keys(request).sort()).toEqual(["kid", "kind", "vaultId", "wrap"]);
    expect(request).toMatchObject({ kid: 1, kind: "recovery", vaultId: vault.vaultId });
    const opened = await unwrapVaultKeyWithRecoveryKey(vault.recoveryKey, decodeBase64(request.wrap)!, { vaultId: vault.vaultId, kid: 1 });
    expect(Array.from(opened)).toEqual(Array.from(vault.vaultKey));
  });
});

describe("typing back three groups of the Recovery Key", () => {
  it("asks for three different groups of the fourteen, by number, in the order they are written, a different three for different random bytes", () => {
    expect(RECOVERY_KEY_GROUPS).toBe(14);
    expect(TYPE_BACK_GROUPS).toBe(3);
    expect(groupsToTypeBack(Uint8Array.of(0, 0, 0))).toEqual([1, 2, 3]);
    expect(groupsToTypeBack(Uint8Array.of(13, 12, 11))).toEqual([12, 13, 14]);
    expect(groupsToTypeBack(Uint8Array.of(2, 6, 9))).toEqual([3, 8, 12]);
    for (let seed = 0; seed < 256; seed++) {
      const asked = groupsToTypeBack(Uint8Array.of(seed, (seed * 7) % 256, (seed * 13) % 256));
      expect(new Set(asked).size, `${asked}`).toBe(3);
      expect(asked, `${asked}`).toEqual([...asked].sort((a, b) => a - b));
      expect(asked.every((group) => group >= 1 && group <= 14), `${asked}`).toBe(true);
    }
  });

  it("finds the groups typed wrong: none when all three match, however they are typed, and the group numbers when not", async () => {
    const vault = await makeNewVault();
    const groups = vault.recoveryKeyText.split("-");
    const asked = [3, 8, 12];
    const right = asked.map((group) => groups[group - 1]).join("");
    expect(wrongGroups(right, vault.recoveryKeyText, asked)).toEqual([]);
    expect(wrongGroups(` ${right.toLowerCase().replace(/(.{4})/g, "$1 ")}`, vault.recoveryKeyText, asked), "small letters and spaces").toEqual([]);
    const slip = (group: string) => `${group[0] === "9" ? "8" : "9"}${group.slice(1)}`;
    expect(wrongGroups([groups[2], slip(groups[7]!), groups[11]].join(""), vault.recoveryKeyText, asked)).toEqual([8]);
    expect(wrongGroups([slip(groups[2]!), groups[7], slip(groups[11]!)].join(""), vault.recoveryKeyText, asked)).toEqual([3, 12]);
    expect(wrongGroups(groups[2]!, vault.recoveryKeyText, asked), "groups not typed yet are wrong").toEqual([8, 12]);
    expect(wrongGroups("", vault.recoveryKeyText, asked)).toEqual([3, 8, 12]);
    expect(wrongGroups(groups[0] + groups[1] + groups[2], vault.recoveryKeyText, asked), "the right groups in the wrong places are wrong").toEqual([3, 8, 12]);
  });
});

describe("the password wrap", () => {
  const PASSWORD = "correct horse battery staple";

  it("makes the request `POST /wrap` takes for a password wrap, with the vault id and the key number, that only the password opens", async () => {
    const vault = await makeNewVault();
    const request = await passwordWrapRequest(vault, PASSWORD);
    expect(Object.keys(request).sort()).toEqual(["kid", "kind", "vaultId", "wrap"]);
    expect(request).toMatchObject({ kid: 1, kind: "password", vaultId: vault.vaultId });
    const found = newestPasswordWrap({ vaultId: vault.vaultId, wraps: [request] });
    if (!found.ok) throw new Error("the wrap was not found");
    const opened = await openPasswordWrapHeld(found.held, PASSWORD);
    expect(opened.ok && Array.from(opened.keys.vaultKey)).toEqual(Array.from(vault.vaultKey));
    expect(opened.ok && opened.keys).toMatchObject({ vaultId: vault.vaultId, kid: 1 });
    expect(await openPasswordWrapHeld(found.held, "correct horse battery stapl"), "another password").toEqual({ ok: false, reason: "wrong" });
    expect(await openPasswordWrapHeld(found.held, ""), "nothing typed").toEqual({ ok: false, reason: "empty" });
    expect(await openPasswordWrapHeld({ ...found.held, vaultId: "another-vault" }, PASSWORD), "another vault's id").toEqual({ ok: false, reason: "wrong" });
  }, 30_000);

  it("is opened by the same words however the keyboard wrote them (NFKC): a full-width letter is the letter", async () => {
    const vault = await makeNewVault();
    const request = await passwordWrapRequest(vault, "Passw0rd long enough");
    const found = newestPasswordWrap({ vaultId: vault.vaultId, wraps: [request] });
    if (!found.ok) throw new Error("the wrap was not found");
    expect((await openPasswordWrapHeld(found.held, "Ｐassw0rd long enough")).ok).toBe(true);
  }, 30_000);

  it("refuses a wrap that asks for Argon2id settings the encryption does not accept, and says it is the wrap, not the password", async () => {
    const vault = await makeNewVault();
    const request = await passwordWrapRequest(vault, PASSWORD);
    const bytes = decodeBase64(request.wrap)!;
    bytes[5] = 0; // the memory setting is a number at bytes 2 to 5: this one asks for less than the floor
    bytes[4] = 0;
    bytes[3] = 0;
    bytes[2] = 0;
    const found = newestPasswordWrap({ vaultId: vault.vaultId, wraps: [{ ...request, wrap: encodeBase64(bytes) }] });
    if (!found.ok) throw new Error("the wrap was not found");
    expect(await openPasswordWrapHeld(found.held, PASSWORD)).toEqual({ ok: false, reason: "bad-wrap" });
  });

  it("is found among what Nexus holds, the newest one, and the Recovery wrap is not mistaken for it", () => {
    const wrap = (n: number) => encodeBase64(new Uint8Array([n, n, n]));
    const held = { vaultId: "v", wraps: [{ kid: 1, kind: "password", wrap: wrap(1) }, { kid: 3, kind: "recovery", wrap: wrap(9) }, { kid: 2, kind: "password", wrap: wrap(2) }] };
    expect(holdsAWrap(held, "password")).toBe(true);
    expect(holdsAWrap({ vaultId: "v", wraps: [{ kid: 1, kind: "recovery", wrap: wrap(1) }] }, "password")).toBe(false);
    expect(holdsAWrap({ vaultId: "v" }, "password")).toBe(false);
    expect(holdsAWrap(held, "recovery")).toBe(true);
    const found = newestPasswordWrap(held);
    expect(found).toMatchObject({ ok: true, held: { vaultId: "v", kid: 2 } });
    expect(found.ok && Array.from(found.held.wrap)).toEqual([2, 2, 2]);
    expect(newestPasswordWrap({ vaultId: null, wraps: [] })).toEqual({ ok: false, reason: "no-vault-id" });
    expect(newestPasswordWrap({ vaultId: "v", wraps: [{ kid: 1, kind: "recovery", wrap: wrap(1) }] })).toEqual({ ok: false, reason: "no-password-wrap" });
    expect(newestPasswordWrap({ vaultId: "v", wraps: [{ kid: 1, kind: "password", wrap: "not base64!" }] })).toEqual({ ok: false, reason: "bad-wrap" });
  });
});

describe("what Nexus holds", () => {
  it("holds a vault when it has a wrap or a vault id, and none when it has neither", () => {
    expect(holdsAVault({ vaultId: null, wraps: [] })).toBe(false);
    expect(holdsAVault({})).toBe(false);
    expect(holdsAVault({ vaultId: "v", wraps: [] })).toBe(true);
    expect(holdsAVault({ vaultId: null, wraps: [{ kid: 1, kind: "recovery", wrap: "AA==" }] })).toBe(true);
  });

  it("answers the newest Recovery wrap and the vault id, or says which is missing", () => {
    const wrap = (n: number) => encodeBase64(new Uint8Array([n, n, n]));
    const found = newestRecoveryWrap({
      vaultId: "v",
      wraps: [{ kid: 1, kind: "recovery", wrap: wrap(1) }, { kid: 3, kind: "password", wrap: wrap(9) }, { kid: 2, kind: "recovery", wrap: wrap(2) }],
    });
    expect(found).toMatchObject({ ok: true, held: { vaultId: "v", kid: 2 } });
    expect(found.ok && Array.from(found.held.wrap)).toEqual([2, 2, 2]);
    expect(newestRecoveryWrap({ vaultId: null, wraps: [] })).toEqual({ ok: false, reason: "no-vault-id" });
    expect(newestRecoveryWrap({ vaultId: "v", wraps: [{ kid: 1, kind: "password", wrap: wrap(1) }] })).toEqual({ ok: false, reason: "no-recovery-wrap" });
    expect(newestRecoveryWrap({ vaultId: "v" })).toEqual({ ok: false, reason: "no-recovery-wrap" });
    expect(newestRecoveryWrap({ vaultId: "v", wraps: [{ kid: 1, kind: "recovery", wrap: "not base64!" }] })).toEqual({ ok: false, reason: "bad-wrap" });
  });
});

describe("opening the Recovery wrap with a typed Recovery Key", () => {
  async function held() {
    const vault = await makeNewVault();
    const request = await recoveryWrapRequest(vault);
    const found = newestRecoveryWrap({ vaultId: vault.vaultId, wraps: [request] });
    if (!found.ok) throw new Error("the wrap was not found");
    return { vault, held: found.held };
  }

  it("opens with the key as it was written, however it is typed, and answers the vault key, vault id and key number", async () => {
    const { vault, held: wrap } = await held();
    for (const typed of [vault.recoveryKeyText, vault.recoveryKeyText.toLowerCase(), vault.recoveryKeyText.replace(/-/g, " ")]) {
      const opened = await openRecoveryWrap(wrap, typed);
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(Array.from(opened.keys.vaultKey)).toEqual(Array.from(vault.vaultKey));
        expect(opened.keys).toMatchObject({ vaultId: vault.vaultId, kid: 1 });
      }
    }
  });

  it("refuses: nothing typed, a key that is not whole or mistyped, and a whole key that is another vault's", async () => {
    const { vault, held: wrap } = await held();
    expect(await openRecoveryWrap(wrap, "")).toEqual({ ok: false, reason: "empty" });
    expect(await openRecoveryWrap(wrap, " - - ")).toEqual({ ok: false, reason: "empty" });
    expect(await openRecoveryWrap(wrap, vault.recoveryKeyText.slice(0, -1))).toEqual({ ok: false, reason: "incomplete" });
    const last = vault.recoveryKeyText.slice(-1);
    expect(await openRecoveryWrap(wrap, vault.recoveryKeyText.slice(0, -1) + (last === "2" ? "3" : "2"))).toEqual({ ok: false, reason: "incomplete" });
    expect(await openRecoveryWrap(wrap, await formatRecoveryKey(await generateRecoveryKey()))).toEqual({ ok: false, reason: "wrong" });
    expect(await openRecoveryWrap({ ...wrap, vaultId: "another-vault" }, vault.recoveryKeyText), "a wrap opens only with the vault id it was made with").toEqual({ ok: false, reason: "wrong" });
  });
});

describe("an agent's approval", () => {
  it("reads a public key as the PUBLIC KEY line of keygen prints it: 32 bytes of standard base64, padding and all", async () => {
    const pair = await generateDeviceKeyPair();
    const written = encodeBase64(pair.publicKey);
    expect(Array.from(readAgentPublicKey(written)!)).toEqual(Array.from(pair.publicKey));
    expect(readAgentPublicKey(`  ${written}\n`)).not.toBeNull();
    for (const typed of ["", "not base64!", encodeBase64(new Uint8Array(31)), encodeBase64(new Uint8Array(33)), written.replace(/=+$/, "")]) {
      expect(readAgentPublicKey(typed), `"${typed}"`).toBeNull();
    }
    expect(await publicKeyCode(pair.publicKey)).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  });

  it("seals the vault key to the agent's public key, as base64, so that only the agent's private key opens it", async () => {
    const vault = await makeNewVault();
    const pair = await generateDeviceKeyPair();
    const approval = await approvalForAgent(pair.publicKey, { vaultKey: vault.vaultKey, vaultId: vault.vaultId, kid: 1 });
    const opened = await openApproval({ publicKey: await devicePublicKey(pair.privateKey), privateKey: pair.privateKey }, decodeBase64(approval)!);
    expect(Array.from(opened.vaultKey)).toEqual(Array.from(vault.vaultKey));
    expect(opened).toMatchObject({ vaultId: vault.vaultId, kid: 1 });

    const stranger = await generateDeviceKeyPair();
    await expect(openApproval(stranger, decodeBase64(approval)!)).rejects.toThrow();
  });
});
