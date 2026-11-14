import sodium from "libsodium-wrappers-sumo";

export type Sodium = typeof sodium;

/** Waits for libsodium's WebAssembly to load, then hands back the library. */
export async function loadSodium(): Promise<Sodium> {
  await sodium.ready;
  return sodium;
}
