// `nexus-agent approve-agent`: gives one agent the vault key. The person pastes the agent's public key and types the Recovery Key
// at a hidden prompt (never an argument, never shown). The command fetches the Recovery wrap and the vault id from Nexus, opens the
// vault key with the Recovery Key, seals it to the agent's public key, and PRINTS the sealed approval for the person to save beside
// the agent's private key.
//
// Nexus never sees the approval, so it cannot swap one: the person carries it from this terminal to the agent's secrets themselves
// (docs/THREAT-MODEL.md, "An agent's approval"). That is why this needs no matching code, as a device approval does.

import { Nexus, refusal } from "../nexus";
import { approvalForAgent, newestRecoveryWrap, openRecoveryWrap, publicKeyCode, readAgentPublicKey } from "../setup";
import { Stop, type Io } from "./io";
import { ENV, LABEL } from "./labels";
import { Prompter } from "./prompt";
import { need } from "./settings";

export async function approveAgent(io: Io): Promise<number> {
  const settings = need(io, [ENV.address, ENV.token]);
  const nexus = new Nexus(settings[ENV.address], settings[ENV.token], io.fetch);

  const held = await nexus.get("wraps");
  if (held.status !== 200) throw new Stop(refusal(held, "tell what it holds").message);
  const found = newestRecoveryWrap(held.json);
  if (!found.ok) {
    if (found.reason === "no-vault-id") throw new Stop("This server holds no vault id, so there is nothing to approve an agent for. Set the vault up first (nexus-agent create-vault).");
    if (found.reason === "no-recovery-wrap") throw new Stop("This server holds no Recovery wrap, so the vault key cannot be opened. Set the vault up first (nexus-agent create-vault).");
    throw new Stop("The Recovery wrap Nexus holds is not base64, so it cannot be opened.");
  }

  const prompter = new Prompter(io.stdin, io.stderr);
  try {
    const typedPublic = await prompter.line("The agent's public key (the PUBLIC KEY line of `nexus-agent keygen`): ");
    const publicKey = typedPublic === null ? null : readAgentPublicKey(typedPublic);
    if (publicKey === null) {
      throw new Stop("That is not an agent's public key: it is 32 bytes written as base64, the PUBLIC KEY line of `nexus-agent keygen`. Nothing was made.");
    }
    io.stderr.write(`Public key code: ${await publicKeyCode(publicKey)} (it matches the PUBLIC KEY CODE keygen printed, if you pasted the right key)\n`);

    const typedKey = await prompter.line("Recovery Key (typing is hidden): ", { hidden: true });
    const opened = await openRecoveryWrap(found.held, typedKey ?? "");
    if (!opened.ok) {
      if (opened.reason === "empty") throw new Stop("No Recovery Key was given. Nothing was made.");
      if (opened.reason === "incomplete") throw new Stop("That is not a whole Recovery Key: a character is missing or mistyped. Nothing was made.");
      throw new Stop("That Recovery Key does not open this vault's Recovery wrap, so it is not this vault's Recovery Key. Nothing was made.");
    }
    try {
      io.stdout.write(`${LABEL.approval}: ${await approvalForAgent(publicKey, opened.keys)}\n`);
    } finally {
      opened.keys.vaultKey.fill(0);
    }
    io.stderr.write(`Approved for the key above. Save the approval beside the agent's private key (it is the ${ENV.approval} the agent reads). Nexus never sees it.\n`);
    return 0;
  } finally {
    prompter.close();
  }
}
