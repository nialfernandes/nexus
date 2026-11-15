// `nexus-agent create-vault`: sets up the vault on a server that has none. It makes the vault key, the vault id and the Recovery Key,
// shows the Recovery Key on this terminal only, asks for the check characters back, and only then sends the Recovery wrap (and the
// vault id with it) with the owner's token. The vault key is not shown or kept: it is in memory long enough to be locked under the
// Recovery Key, and whoever holds the Recovery Key opens it again with the wrap.
//
// Nothing is sent before the person has typed the check characters back, and nothing is sent at all to a server that already has a
// wrap or a vault id.

import {
  formatRecoveryKey, generateRecoveryKey, generateVaultKey, normaliseRecoveryText, wrapVaultKeyWithRecoveryKey,
} from "@nexus/crypto";
import { encodeBase64, encodeBase64Url } from "../base64";
import { Nexus, refusal } from "../nexus";
import { Stop, type Io } from "./io";
import { ENV, LABEL } from "./labels";
import { Prompter } from "./prompt";
import { need } from "./settings";

/** The number of the first vault key. */
export const FIRST_KID = 1;
/** How many times the check characters may be typed before the command gives up. */
export const TYPE_BACK_TRIES = 3;

export async function createVault(io: Io): Promise<number> {
  const settings = need(io, [ENV.address, ENV.token]);
  // The key is shown on a screen a person is looking at and nowhere else: not into a file, a pipe or a log.
  if (io.stdout.isTTY !== true) {
    throw new Stop("create-vault shows the Recovery Key on this terminal only. Run it in a terminal, not piped or redirected.");
  }
  const nexus = new Nexus(settings[ENV.address], settings[ENV.token], io.fetch);

  // Everything that can be refused is asked before the key is shown, so the person never writes down a key for nothing.
  const held = await nexus.get("wraps");
  if (held.status !== 200) throw new Stop(refusal(held, "tell what it holds").message);
  if ((Array.isArray(held.json.wraps) && held.json.wraps.length > 0) || typeof held.json.vaultId === "string") {
    throw new Stop("This server already holds a vault (a wrap or a vault id). create-vault sets up a server that has none, so nothing was made.");
  }
  const owner = await nexus.get("tokens");
  if (owner.status === 403) throw new Stop("This token is not the owner's, and only the owner may set up the vault. Sign in as the owner (nexus-agent sign-in --identity <the owner's name>).");
  if (owner.status !== 200) throw new Stop(refusal(owner, "check the token").message);

  const vaultKey = await generateVaultKey();
  const recoveryKey = await generateRecoveryKey();
  const prompter = new Prompter(io.stdin, io.stderr);
  try {
    const vaultId = encodeBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const written = await formatRecoveryKey(recoveryKey);
    const checkGroup = written.slice(written.lastIndexOf("-") + 1);

    io.stderr.write("\nThis is your Recovery Key. It opens your notes if every approved device is lost. Write it down now, in your password manager and on paper if you like.\n");
    io.stderr.write("It is shown here only, now. Nexus cannot show it again or reset it: if you lose it and every approved device, the notes are gone.\n\n");
    io.stdout.write(`${LABEL.recoveryKey}: ${written}\n\n`);

    let typedBack = false;
    for (let attempt = 1; attempt <= TYPE_BACK_TRIES && !typedBack; attempt++) {
      const typed = await prompter.line("To check you have it, type the last 4 characters of the Recovery Key (the last group): ");
      if (typed === null) break;
      typedBack = normaliseRecoveryText(typed) === normaliseRecoveryText(checkGroup);
      if (!typedBack) io.stderr.write("Those are not the last four characters of the key. Nothing was sent.\n");
    }
    if (!typedBack) throw new Stop("The check characters were not typed back, so the vault was not set up and nothing was sent. Run create-vault again for a new key.");

    const wrap = await wrapVaultKeyWithRecoveryKey(recoveryKey, vaultKey, { vaultId, kid: FIRST_KID });
    const kept = await nexus.post("wrap", { kid: FIRST_KID, kind: "recovery", wrap: encodeBase64(wrap), vaultId });
    if (kept.status === 409) throw new Stop("This server already holds a vault with another vault id, so this one was not kept.");
    if (kept.status !== 200) throw new Stop(refusal(kept, "keep the Recovery wrap").message);

    io.stdout.write(`${LABEL.vaultId}: ${vaultId}\n`);
    io.stderr.write("The vault is set up. Approve each device and each agent from the Recovery Key (nexus-agent approve-agent).\n");
    return 0;
  } finally {
    vaultKey.fill(0);
    recoveryKey.fill(0);
    prompter.close();
  }
}
