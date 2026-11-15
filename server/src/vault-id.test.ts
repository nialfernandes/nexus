// The vault id, kept beside the wraps. A wrap opens only with the vault id it was made with, so a device or an agent that holds
// only the Recovery Key needs the server to say which id that was. The owner sends it with each wrap: the first one sets it,
// GET /wraps answers it to any identity, another id is refused (409) and nothing is kept, and it stays when every wrap is removed.
// Through the Nexus Worker (see __fixtures__/identity-world.ts).

import { beforeAll, describe, expect, it } from "vitest";
import { PASSWORD_WRAP, RECOVERY_WRAP, RECOVERY_WRAP_KID_2, VAULT_ID } from "./__fixtures__/device-blobs";
import { API, bodyOf, expectRefusal, setUpNexus, signInOwner } from "./__fixtures__/nexus-world";
import { manage, sendAs, tokenFor, vaultAs, type Who } from "./__fixtures__/identity-world";
import { MAX_VAULT_ID_BYTES } from "./fields";

let owner: Who;
let agents: Who;

beforeAll(async () => {
  await setUpNexus();
  const ownerCookie = (await signInOwner()).cookie;
  owner = { cookie: ownerCookie };
  agents = tokenFor(() => ownerCookie, "agents", "vault-id agents");
});

describe("the vault id beside the wraps", () => {
  it("is null before any wrap is kept", async () => {
    expect(bodyOf(await vaultAs(owner).wraps())).toEqual({ vaultId: null, wraps: [] });
  });

  it("is what the first wrap was sent with, and GET /wraps answers it to any identity", async () => {
    expect(bodyOf(await manage(owner).setWrap(1, "recovery", RECOVERY_WRAP, VAULT_ID))).toEqual({ result: "saved", kid: 1, kind: "recovery" });
    const asAgent = bodyOf(await vaultAs(agents).wraps());
    expect(asAgent.vaultId).toBe(VAULT_ID);
    expect(asAgent.wraps).toHaveLength(1);
    expect(bodyOf(await vaultAs(owner).wraps()).vaultId).toBe(VAULT_ID);
  });

  it("takes the same id again, for another wrap or the same one", async () => {
    bodyOf(await manage(owner).setWrap(1, "password", PASSWORD_WRAP, VAULT_ID));
    bodyOf(await manage(owner).setWrap(1, "recovery", RECOVERY_WRAP, VAULT_ID));
    expect(bodyOf(await vaultAs(owner).wraps()).wraps).toHaveLength(2);
  });

  it("refuses a wrap sent with another vault id (409), keeps nothing of it, and leaves the id as it was", async () => {
    const before = bodyOf(await vaultAs(owner).wraps());
    expectRefusal(await manage(owner).setWrap(2, "recovery", RECOVERY_WRAP_KID_2, "another-vault"), 409, "a second, different vault id");
    expectRefusal(await manage(owner).setWrap(1, "recovery", RECOVERY_WRAP, "another-vault"), 409, "a different id for a wrap that is already kept");
    const after = bodyOf(await vaultAs(owner).wraps());
    expect(after, "no wrap was kept or changed, and the id is the first one").toEqual(before);
    expect(after.vaultId).toBe(VAULT_ID);
  });

  it("does not repeat the id it was sent in the refusal", async () => {
    const refused = await manage(owner).setWrap(2, "recovery", RECOVERY_WRAP_KID_2, "an-id-that-must-not-be-echoed");
    expect(refused.status).toBe(409);
    expect(refused.text).not.toContain("an-id-that-must-not-be-echoed");
  });

  it("is a required field of a wrap, and a bad one is refused (400) before anything is kept", async () => {
    expectRefusal(await sendAs("POST", `${API}/wrap`, owner, { kid: 3, kind: "recovery", wrap: RECOVERY_WRAP }), 400, "a wrap with no vault id");
    expectRefusal(await manage(owner).setWrap(3, "recovery", RECOVERY_WRAP, ""), 400, "an empty vault id");
    expectRefusal(await sendAs("POST", `${API}/wrap`, owner, { kid: 3, kind: "recovery", wrap: RECOVERY_WRAP, vaultId: 7 }), 400, "a vault id that is not text");
    expectRefusal(await manage(owner).setWrap(3, "recovery", RECOVERY_WRAP, "x".repeat(MAX_VAULT_ID_BYTES + 1)), 400, "a vault id over the format's limit");
    expect((await manage(owner).setWrap(3, "recovery", RECOVERY_WRAP, "é".repeat(MAX_VAULT_ID_BYTES / 2 + 1))).status, "the limit is in bytes, not characters").toBe(400);
    expect(bodyOf(await vaultAs(owner).wraps()).wraps.map((w: { kid: number }) => w.kid)).not.toContain(3);
  });

  it("is still only the owner's to send: another identity is turned away, and the id stays", async () => {
    expectRefusal(await manage(agents).setWrap(1, "recovery", RECOVERY_WRAP, VAULT_ID), 403, "an agent keeping a wrap");
    expectRefusal(await manage(agents).setWrap(1, "recovery", RECOVERY_WRAP, "agents-own-vault"), 403, "an agent trying its own vault id");
    expect(bodyOf(await vaultAs(agents).wraps()).vaultId).toBe(VAULT_ID);
  });

  it("stays when every wrap is removed, because it names the vault the notes belong to", async () => {
    for (const wrap of bodyOf(await vaultAs(owner).wraps()).wraps as Array<{ kid: number; kind: string }>) {
      bodyOf(await manage(owner).removeWrap(wrap.kid, wrap.kind));
    }
    expect(bodyOf(await vaultAs(owner).wraps())).toEqual({ vaultId: VAULT_ID, wraps: [] });
    expectRefusal(await manage(owner).setWrap(1, "recovery", RECOVERY_WRAP, "a-new-vault"), 409, "a different id after the wraps were removed");
    bodyOf(await manage(owner).setWrap(1, "recovery", RECOVERY_WRAP, VAULT_ID));
  });
});
