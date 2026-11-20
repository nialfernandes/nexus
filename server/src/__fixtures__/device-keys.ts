// A new device's public key and the code that device shows for it, made by the real @nexus/crypto, for the server's tests. The server
// holds no encryption library and its tests need none, so these are pinned here, as the encrypted blobs are in device-blobs.ts.
//
// HOW THEY WERE MADE (once, then pinned here): packages/crypto built with `npm ci && npm run build --workspace @nexus/crypto`, then a
// short script called generateDeviceKeyPair() three times and wrote each public key as base64 beside deviceKeyCode(publicKey), which is
// what a new device shows on its screen (docs/FORMAT.md section 7.4). The fourth is the key the format document and the encryption
// package's tests pin: the 32 bytes 0x10, 0x11, ... 0x2f, whose code the document gives.

export interface KeyAndCode {
  /** The device's public key, 32 bytes as base64, as it sends it when it starts a sign-in. */
  key: string;
  /** The code the device shows for it: ten symbols, two groups of five. */
  code: string;
}

export const DEVICE_KEYS: readonly KeyAndCode[] = [
  { key: "VDpzOdVNk5HCX/pw4SUzKXSdtlE1boxNAInF5nXJWAE=", code: "NW18D-NK7HZ" },
  { key: "5llLKWhsDDRsdhs/vobuPJWhwHuW9FWMt6MNR4Hz81A=", code: "8AYVX-D679Z" },
  { key: "zb9oUDJdN0yeyflpX/0+0cDxSn6FFeVIJ017Kagr/FQ=", code: "30146-EWX2M" },
];

/** The key and code of docs/FORMAT.md section 7.4's example. */
export const PINNED_KEY: KeyAndCode = {
  key: Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => 0x10 + index)).toString("base64"),
  code: "3X1TB-8BMC4",
};
