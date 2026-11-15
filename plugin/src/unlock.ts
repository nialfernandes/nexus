// The one door to the vault key. The sync engine never makes, stores or asks for a key: each time it has to encrypt or
// decrypt it asks this port what is unlocked right now, and uses the answer for that one job.
//
// The setup screens (Recovery Key, optional password, approving a device) are a later piece of work. They will fill this
// port: when a person unlocks the vault they put the key here, and when they lock it, or the plugin unloads, they take it
// away. Until then the plugin is given NEVER_UNLOCKED, so it syncs nothing and says that the vault is locked.
//
// THE KEY LIVES IN MEMORY ONLY. Nothing in this plugin writes it anywhere: not to the data file, not to local storage,
// not to the vault. A port that held it on disk would be a different port, and a later piece of work would have to say so.

/** What is needed to encrypt and decrypt one vault's notes. */
export interface VaultKeys {
  /** The vault key: 32 bytes. */
  vaultKey: Uint8Array;
  /**
   * Names the vault. It is part of what every note is bound to, so every device of a vault has to use the same one. It is not secret.
   * The setup screens make it, once, when the vault is made; it is kept in the plugin's data file (which a vault shares between its
   * devices) and beside the wraps on the server, and a new device is handed it in its approval. This plugin does none of that storing:
   * that is the setup slice's work, and until then this port is the only place the engine gets it from.
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
 * it in memory and nowhere else, the same as for `keys`.
 */
export interface KeyReceiver {
  unlock(keys: VaultKeys): void;
}

/** The port the plugin has until the setup screens exist: nothing is ever unlocked. */
export const NEVER_UNLOCKED: Unlock = { keys: () => null };
