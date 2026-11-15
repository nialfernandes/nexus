// `nexus-agent keygen`: makes one agent's key pair. The private half is shown once, on its own line, to be saved in the person's
// secrets manager; the public half is what `approve-agent` asks for. Nothing is sent anywhere and nothing is written.

import { deviceKeyCode, generateDeviceKeyPair } from "@nexus/crypto";
import { encodeBase64 } from "../base64";
import type { Io } from "./io";
import { LABEL } from "./labels";

export async function keygen(io: Io): Promise<number> {
  const pair = await generateDeviceKeyPair();
  io.stderr.write("A new key pair for one agent. The private key is shown here once and is kept nowhere else: save it in your secrets manager now.\n");
  io.stderr.write("The public key is not secret. `nexus-agent approve-agent` asks for it.\n\n");
  io.stdout.write(`${LABEL.privateKey}: ${encodeBase64(pair.privateKey)}\n`);
  io.stdout.write(`${LABEL.publicKey}: ${encodeBase64(pair.publicKey)}\n`);
  io.stdout.write(`${LABEL.publicKeyCode}: ${await deviceKeyCode(pair.publicKey)}\n`);
  pair.privateKey.fill(0);
  return 0;
}
