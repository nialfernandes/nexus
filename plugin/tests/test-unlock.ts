// The test-only fill for the plugin's unlock port (src/unlock.ts). The setup (through the key holder) fills the real port in use; a test of the engine on its own
// holds the key itself: it is handed in, kept in memory, and given back to the engine each time it asks. It is
// never written anywhere, and the tests check that no copy of it reaches the plugin's saved data or the vault.

import type { Unlock, VaultKeys } from "../src/unlock";

export class TestUnlock implements Unlock {
  constructor(private held: VaultKeys | null) {}

  keys(): VaultKeys | null {
    return this.held;
  }

  /** What the setup does when the person unlocks the vault. */
  unlock(keys: VaultKeys): void {
    this.held = keys;
  }

  /** What the setup does when the person locks it, or the plugin unloads. */
  lock(): void {
    this.held = null;
  }
}
