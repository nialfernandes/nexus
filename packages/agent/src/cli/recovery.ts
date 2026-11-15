// The two steps `approve-agent` and `set-up-agent` share when they open the vault key: read the Recovery wrap Nexus holds, and open it
// with the Recovery Key a person typed. Each says in plain words why it stopped, and neither prints or keeps a key.

import { newestRecoveryWrap, openRecoveryWrap, type OpenedVault, type RecoveryWrapHeld } from "../setup";
import { Stop } from "./io";

const SET_UP_FIRST = "Set the vault up first (nexus-agent create-vault).";

/** The Recovery wrap in what Nexus holds (the answer of `wraps`), or a Stop that says what is missing. */
export function recoveryWrapHeld(held: { wraps?: unknown; vaultId?: unknown }): RecoveryWrapHeld {
  const found = newestRecoveryWrap(held);
  if (found.ok) return found.held;
  if (found.reason === "no-vault-id") throw new Stop(`This server holds no vault id, so there is nothing to approve an agent for. ${SET_UP_FIRST}`);
  if (found.reason === "no-recovery-wrap") throw new Stop(`This server holds no Recovery wrap, so the vault key cannot be opened. ${SET_UP_FIRST}`);
  throw new Stop("The Recovery wrap Nexus holds is not base64, so it cannot be opened.");
}

/** The vault key, opened with the Recovery Key as typed (null when the input ended). The caller overwrites the vault key it is given. */
export async function openWithTypedKey(held: RecoveryWrapHeld, typedKey: string | null): Promise<OpenedVault> {
  const opened = await openRecoveryWrap(held, typedKey ?? "");
  if (opened.ok) return opened.keys;
  if (opened.reason === "empty") throw new Stop("No Recovery Key was given. Nothing was made.");
  if (opened.reason === "incomplete") throw new Stop("That is not a whole Recovery Key: a character is missing or mistyped. Nothing was made.");
  throw new Stop("That Recovery Key does not open this vault's Recovery wrap, so it is not this vault's Recovery Key. Nothing was made.");
}
