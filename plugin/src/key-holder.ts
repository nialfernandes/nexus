// The one object that holds the vault key while the vault is unlocked: the plugin's whole `Unlock` port (what the engine asks for its
// key) and `KeyReceiver` (where a key is put when a person has unlocked the vault), in memory and nowhere else. It starts locked.
//
// THE KEY IS HERE AND IN NO OTHER PLACE. Nothing in it writes the key anywhere: not to the data file, not to local storage, not to the
// vault, not to a log. It holds the bytes it was handed (it is given them for good, see KeyReceiver) and `lock()` overwrites them with
// zeros, so a key the plugin let go of is not left in memory for something else to read. The engine asks for the keys each time it
// has a note to seal or open and keeps none, and it sends nothing once `keys()` answers null, so a lock that comes while it is
// working at most spoils that one job's work, which is then not sent (sync.ts `send` asks again before every call).
//
// The vault id and the key number are not secret; they go with the key and are dropped with it.

import type { KeyReceiver, Unlock, VaultKeys } from "./unlock";

/** A key is 32 bytes: the number the encryption takes. */
const KEY_BYTES = 32;

export class KeyHolder implements Unlock, KeyReceiver {
  #held: VaultKeys | null = null;
  readonly #changed: (unlocked: boolean) => void;

  /** `changed` is told each time the vault goes from locked to unlocked or back, so the status line can say so. */
  constructor(changed: (unlocked: boolean) => void = () => undefined) {
    this.#changed = changed;
  }

  /** The keys while the vault is unlocked, or null while it is locked. */
  keys(): VaultKeys | null {
    return this.#held;
  }

  get isUnlocked(): boolean {
    return this.#held !== null;
  }

  /**
   * Unlocks the vault with `keys`, which are the holder's from now on: it overwrites them when the vault is locked, and the caller
   * keeps no copy. A key already held (another unlock, with no lock between) is overwritten first. A key that is not 32 bytes is
   * refused and the vault stays as it was.
   */
  unlock(keys: VaultKeys): void {
    if (!(keys.vaultKey instanceof Uint8Array) || keys.vaultKey.length !== KEY_BYTES) {
      throw new Error("The vault key has to be 32 bytes, so the vault was not unlocked.");
    }
    const before = this.#held;
    this.#held = { vaultKey: keys.vaultKey, vaultId: keys.vaultId, kid: keys.kid };
    if (before !== null && before.vaultKey !== keys.vaultKey) before.vaultKey.fill(0);
    if (before === null) this.#changed(true);
  }

  /** Drops the key: overwritten with zeros, and forgotten. Safe to call again, and when nothing is held. */
  lock(): void {
    const before = this.#held;
    if (before === null) return;
    this.#held = null;
    before.vaultKey.fill(0);
    this.#changed(false);
  }
}
