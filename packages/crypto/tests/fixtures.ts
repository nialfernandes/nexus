import { sequence } from "./helpers.js";

/** Fixed inputs for the worked examples in docs/FORMAT.md. Never use fixed keys or nonces outside tests. */
export const VAULT_KEY = sequence(32, 0x00);
export const RECOVERY_KEY = sequence(32, 0x20);
export const NONCE = sequence(24, 0x40);
export const SALT = sequence(16, 0x60);
export const PASSWORD = "correct horse battery staple";
export const VAULT_ID = "vault-1";
export const NOTE_ID = "note-1";
export const KID = 1;
export const NOTE_CONTEXT = { vaultId: VAULT_ID, noteId: NOTE_ID, kid: KID };
export const VAULT_CONTEXT = { vaultId: VAULT_ID, kid: KID };
export const RECORD = { path: "Daily/2026-11-15.md", text: "hello" };

/** Made once by the code under test, then reproduced independently by tests/noble-cross-check.test.ts. */
export const NOTE_BLOB_HEX =
  "0100000001404142434445464748494a4b4c4d4e4f5051525354555657af1b7511a4885b2cadb0e6d7c3e54aa0a2889be922687eab5f1f90212b2801e47381764c6fb0ec7593de9b6e775adaf19b6b7de86f85b49cb6fc08f413b24c545a2bf87214b345c88503b0ffdc799ceff6c7062b283d647750a30794c56533252675b7c9b8e56bb6dda1629a4717c98b9ff313de29ca83e00cbf571222c77b9fdf51470ed1ded6b0a0a0f23069a7de50ee2768ff352c5c1d4d2aa1b93ddb0ab139fc04bc7e42e07e51fdcec36bd73cfe81eacae18ce1f48ee9c2078f1a952a99aafdb4a3937724fa7b33296dcddd0570c8406b44d2f9a12aa38e4cf7ec3d3ead1f0568e31a097342d0f62a600b2351762db7ddff84d44d905575c69e440ccab611d58c25e4543bf16b90c265a965aa8e";
export const RECOVERY_WRAP_HEX =
  "0102404142434445464748494a4b4c4d4e4f50515253545556576b8543b518c8ccac275ec522b35b7f022a002d3520e1a34decd6e7f43506268ae474daa36ba121bd2171400eb138c499";
export const PASSWORD_WRAP_HEX =
  "0103000100000000000300000001606162636465666768696a6b6c6d6e6f404142434445464748494a4b4c4d4e4f5051525354555657aabf5c2ca8ef548a032d84583b467a725f7ea0806abae90239ab5a435b4058049f3b818e5a531fd658577e560d8eeb0f";
export const RECOVERY_KEY_TEXT = "40GJ-48S4-4MK2-EA19-58NJ-RB9E-5WR3-2CHK-6GTK-CDSR-74X3-PF1X-7RZG-2M48";
