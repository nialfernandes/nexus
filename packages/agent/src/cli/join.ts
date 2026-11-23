// `nexus-agent join <name>`: run on the agent itself, it joins the vault as the identity <name> and is given the key, with no Recovery
// Key and no value copied by hand.
//
//   1. It makes the agent's key pair and starts a device sign-in for <name> with the public half (the same `device/start` every device
//      uses), so the owner can seal the vault key to it.
//   2. It prints two codes: the AGENT CODE (a short code of that public key) and the sign-in's own code. The owner, in Obsidian on a
//      device that holds the vault key, types the agent code, and that device checks it against the key Nexus lists for this
//      sign-in before it seals anything: so the key goes to this agent and not to a key Nexus put in its place.
//   3. It waits while the owner does that. A sign-in that is turned down, or runs out, or was used already, ends with Nexus's own words.
//   4. The first poll after the allow hands over the token and the sealed key. The agent opens the sealed key with its own private key
//      (to be sure it is one it can use; the opened key is overwritten at once, nothing is read with it here) and prints the four values
//      the other commands read from the environment, on standard output only. Everything a person reads goes to standard error, so
//      `nexus-agent join scribe > scribe.env` keeps the values out of the terminal.
//
// Nothing is written to a file by this command (the command writes no file), and the private key is overwritten when it is done.

import { NexusCryptoError, deviceKeyCode, generateDeviceKeyPair, openApproval } from "@nexus/crypto";
import { decodeBase64, encodeBase64 } from "../base64";
import { cleanAddress, Nexus } from "../nexus";
import { writeAgentValues } from "./agent-values";
import { Stop, type Io } from "./io";
import { ENV } from "./labels";
import { GIVE_UP_AFTER_MS, POLL_EVERY_MS, pollForJoin, startSignIn, type Collected } from "./sign-in";
import { need } from "./settings";

/** The labels of the two codes the agent prints. The owner types the agent code; the sign-in code is Nexus's own name for the sign-in. */
export const JOIN_LABEL = { agentCode: "agent code", signInCode: "sign-in code" } as const;

/** What is said when the owner let the agent in but gave it no key (allowed from a page, not from a device that holds the key). */
const NO_KEY =
  "The owner let this agent sign in but did not give it the key, so it cannot read any notes. Nothing was kept. Remove the agent's device on the Nexus page, then run join again and have the owner type the agent code in Obsidian.";
/** What is said when the key Nexus handed over does not open with this agent's own private key. */
const KEY_DID_NOT_OPEN = "The key Nexus handed over does not open with this agent's own key, so it was not used. Nothing was kept. Run join again.";

export async function join(io: Io, options: { name: string | undefined; label: string | undefined }): Promise<number> {
  if (options.name === undefined) throw new Stop("Say the agent's name: nexus-agent join <name>.");
  const name = options.name;
  const address = cleanAddress(need(io, [ENV.address])[ENV.address]);
  const nexus = new Nexus(address, null, io.fetch);

  const pair = await generateDeviceKeyPair();
  try {
    const started = await startSignIn(nexus, name, options.label ?? name, encodeBase64(pair.publicKey));
    io.stderr.write(`${name} is asking to join. In Obsidian, on a device that holds the vault key, open the Nexus command "Approve a device" and type this code:\n`);
    io.stderr.write(`  ${JOIN_LABEL.agentCode}: ${await deviceKeyCode(pair.publicKey)}\n`);
    io.stderr.write(`  ${JOIN_LABEL.signInCode}: ${started.code}\n`);
    io.stderr.write(`Waiting for the owner to give ${name} the key (this lasts ten minutes)...\n`);

    const collected = await waitForOwner(io, nexus, started.secret);
    if (collected.approval === null) throw new Stop(NO_KEY);
    await checkItOpens(pair, collected.approval);

    writeAgentValues(io, { address, token: collected.token, privateKey: encodeBase64(pair.privateKey), approval: collected.approval });
    io.stderr.write(`Done. ${name} has joined and holds the key. The four values above are ${name}, shown once and not kept anywhere by this command: they went to standard output, so run it as \`nexus-agent join ${name} > ${name}.env\` to keep them out of the terminal, then load that file (set -a; . ./${name}.env) before read, write and list.\n`);
    return 0;
  } finally {
    pair.privateKey.fill(0);
  }
}

/** Asks every few seconds until the owner has answered; a refusal, or the ten minutes being up, is a Stop. */
async function waitForOwner(io: Io, nexus: Nexus, secret: string): Promise<Collected> {
  const giveUpAt = io.now().getTime() + GIVE_UP_AFTER_MS;
  for (;;) {
    await io.wait(POLL_EVERY_MS);
    if (io.now().getTime() > giveUpAt) throw new Stop("The sign-in ran out before it was allowed. Start again.");
    const answer = await pollForJoin(nexus, secret);
    if (answer !== null) return answer;
  }
}

/** Opens the sealed key with the agent's own private key to be sure it is one this agent can use, and overwrites what it opened. */
async function checkItOpens(pair: Awaited<ReturnType<typeof generateDeviceKeyPair>>, approval: string): Promise<void> {
  const sealed = decodeBase64(approval);
  if (sealed === null) throw new Stop(KEY_DID_NOT_OPEN);
  try {
    // The vault is not known to this agent yet, so none is named: read, write and list check the approval against the vault they open.
    (await openApproval(pair, sealed)).vaultKey.fill(0);
  } catch (error) {
    if (error instanceof NexusCryptoError) throw new Stop(KEY_DID_NOT_OPEN);
    throw error;
  }
}
