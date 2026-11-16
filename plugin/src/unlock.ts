// The one door to the vault key. The sync engine never makes, stores or asks for a key: each time it has to encrypt or
// decrypt it asks this port what is unlocked right now, and uses the answer for that one job.
//
// The key holder (key-holder.ts) is the one object behind this port, and the setup controller (vault-setup.ts) is what fills it:
// when a person unlocks the vault the key is put here, and when they lock it, or the plugin unloads, it is taken away. While it
// holds none the plugin syncs nothing and says that the vault is locked. The screens that drive the controller are in src/screens.
//
// THE KEY LIVES IN MEMORY ONLY. Nothing in this plugin writes it anywhere: not to the data file, not to local storage,
// not to the vault. A port that held it on disk would be a different port, and a later piece of work would have to say so.

/** What is needed to encrypt and decrypt one vault's notes. */
export interface VaultKeys {
  /** The vault key: 32 bytes. */
  vaultKey: Uint8Array;
  /**
   * Names the vault. It is part of what every note is bound to, so every device of a vault has to use the same one. It is not secret.
   * The setup controller makes it, once, when the vault is made, and sends it with the first wrap, so the server keeps it beside the
   * wraps; a device that unlocks with the Recovery Key reads it there, and a new device is handed it in its approval. This plugin
   * stores it nowhere else: it travels with the key, and this port is the only place the engine gets it from.
   */
  vaultId: string;
  /** The number of the vault key. It is written in every blob, and a blob under another number is refused. */
  kid: number;
}

export interface Unlock {
  /** The keys while the vault is unlocked, or null while it is locked. Asked again each time: a copy is never kept. */
  keys(): VaultKeys | null;
}

/**
 * The other direction of the same door: where a device puts the vault key when it has been given it. A new device that has
 * been approved (approval.ts) puts the key here, and only after the person has confirmed the matching code. The holder keeps
 * it in memory and nowhere else, the same as for `keys`. The bytes are handed over for good: the holder is the one that
 * overwrites them, when the vault is locked, so the caller keeps no copy and does not use them again.
 */
export interface KeyReceiver {
  unlock(keys: VaultKeys): void;
}
