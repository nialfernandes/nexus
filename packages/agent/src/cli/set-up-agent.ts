// `nexus-agent set-up-agent --name <name>`: the whole setup of one agent, for a vault that exists, in one run. It makes the identity (one
// that already exists is used), makes the agent's key pair, signs the agent in and allows it with the owner's secret, seals the vault
// key to the agent's public key with the Recovery Key (typed at a hidden prompt), and prints the four values the agent needs, each on its
// own line.
//
// Everything that can be refused is asked before anything is made: the owner's secret, the vault and the Recovery Key. The token Nexus
// hands over once is made last, after the approval is sealed, so nothing can fail between the token being made and it being shown.

import { generateDeviceKeyPair } from "@nexus/crypto";
import { cleanAddress } from "../nexus";
import { encodeBase64 } from "../base64";
import { approvalForAgent } from "../setup";
import { Stop, type Io } from "./io";
import { ENV } from "./labels";
import { asOwner, checkOwnerSecret, ownerRefusal, readOwnerSecret, signInAndAllow } from "./owner";
import { Prompter } from "./prompt";
import { openWithTypedKey, recoveryWrapHeld } from "./recovery";
import { need } from "./settings";

export async function setUpAgent(io: Io, options: { name: string | undefined; label: string | undefined }): Promise<number> {
  if (options.name === undefined) throw new Stop("Say the agent's name: nexus-agent set-up-agent --name <name>.");
  const address = cleanAddress(need(io, [ENV.address])[ENV.address]);
  const prompter = new Prompter(io.stdin, io.stderr);
  let vaultKey: Uint8Array | null = null;
  let privateKey: Uint8Array | null = null;
  try {
    const owner = asOwner(io, address, await readOwnerSecret(io, prompter));
    await checkOwnerSecret(owner);

    const held = await owner.get("wraps");
    if (held.status !== 200) throw ownerRefusal(held, "tell what it holds");
    const wrap = recoveryWrapHeld(held.json);
    const keys = await openWithTypedKey(wrap, await prompter.line("Recovery Key (typing is hidden): ", { hidden: true }));
    vaultKey = keys.vaultKey;

    const made = await owner.post("identity", { name: options.name, kind: "agent" });
    if (made.status === 409) io.stderr.write(`There is already an identity called ${options.name}: it is used as it is.\n`);
    else if (made.status !== 200) throw ownerRefusal(made, "make the identity");

    const pair = await generateDeviceKeyPair();
    privateKey = pair.privateKey;
    const approval = await approvalForAgent(pair.publicKey, keys);
    const token = await signInAndAllow(io, address, owner, options.name, options.label ?? "nexus-agent");

    io.stdout.write(`${ENV.address}=${address}\n`);
    io.stdout.write(`${ENV.token}=${token}\n`);
    io.stdout.write(`${ENV.privateKey}=${encodeBase64(pair.privateKey)}\n`);
    io.stdout.write(`${ENV.approval}=${approval}\n`);
    io.stderr.write(`These four values are the agent ${options.name} and are shown once, here: save them in your secrets manager now.\n`);
    return 0;
  } finally {
    vaultKey?.fill(0);
    privateKey?.fill(0);
    prompter.close();
  }
}
