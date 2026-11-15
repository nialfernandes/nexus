// `nexus-agent approve-agent`: gives one agent the vault key. The person pastes the agent's public key and types the Recovery Key
// at a hidden prompt (never an argument, never shown). The command fetches the Recovery wrap and the vault id from Nexus, opens the
// vault key with the Recovery Key, seals it to the agent's public key, and PRINTS the sealed approval for the person to save beside
// the agent's private key.
//
// Nexus never sees the approval, so it cannot swap one: the person carries it from this terminal to the agent's secrets themselves
// (docs/THREAT-MODEL.md, "An agent's approval"). That is why this needs no matching code, as a device approval does.

import { Nexus, refusal } from "../nexus";
import { approvalForAgent, publicKeyCode, readAgentPublicKey } from "../setup";
import { Stop, type Io } from "./io";
import { ENV, LABEL } from "./labels";
import { Prompter } from "./prompt";
import { openWithTypedKey, recoveryWrapHeld } from "./recovery";
import { need } from "./settings";

export async function approveAgent(io: Io): Promise<number> {
  const settings = need(io, [ENV.address, ENV.token]);
  const nexus = new Nexus(settings[ENV.address], settings[ENV.token], io.fetch);

  const held = await nexus.get("wraps");
  if (held.status !== 200) throw new Stop(refusal(held, "tell what it holds").message);
  const found = recoveryWrapHeld(held.json);

  const prompter = new Prompter(io.stdin, io.stderr);
  try {
    const typedPublic = await prompter.line("The agent's public key (the PUBLIC KEY line of `nexus-agent keygen`): ");
    const publicKey = typedPublic === null ? null : readAgentPublicKey(typedPublic);
    if (publicKey === null) {
      throw new Stop("That is not an agent's public key: it is 32 bytes written as base64, the PUBLIC KEY line of `nexus-agent keygen`. Nothing was made.");
    }
    io.stderr.write(`Public key code: ${await publicKeyCode(publicKey)} (it matches the PUBLIC KEY CODE keygen printed, if you pasted the right key)\n`);

    const typedKey = await prompter.line("Recovery Key (typing is hidden): ", { hidden: true });
    const keys = await openWithTypedKey(found, typedKey);
    try {
      io.stdout.write(`${LABEL.approval}: ${await approvalForAgent(publicKey, keys)}\n`);
    } finally {
      keys.vaultKey.fill(0);
    }
    io.stderr.write(`Approved for the key above. Save the approval beside the agent's private key (it is the ${ENV.approval} the agent reads). Nexus never sees it.\n`);
    return 0;
  } finally {
    prompter.close();
  }
}
