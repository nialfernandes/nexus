// What the owner's commands (make-identity, allow, deny, owner-sign-in, set-up-agent) share: getting the owner's secret, calling Nexus
// with it, and allowing a sign-in with it.
//
// The owner's secret is read from the environment or at a hidden prompt, never from an argument. It goes to Nexus only as the owner's
// cookie (the `Nexus` client sets it), and it is never printed: every message here is a fixed sentence or Nexus's own words.

import { Nexus, refusal, type Reply } from "../nexus";
import { Stop, type Io } from "./io";
import { ENV } from "./labels";
import { Prompter } from "./prompt";
import { pollForToken, startSignIn } from "./sign-in";

/** How many times to ask for a token that the owner has just allowed, and how long to pause between: the first ask is the one that answers. */
const ASKS_AFTER_ALLOW = 5;
const PAUSE_AFTER_ALLOW_MS = 1_000;

/**
 * The owner's secret: the environment's when it is set there, otherwise typed at a hidden prompt (or read from a line of standard input).
 * A command that goes on to ask something else passes its own `prompter`, because two readers of one input lose what the first buffered.
 */
export async function readOwnerSecret(io: Io, prompter?: Prompter): Promise<string> {
  const given = io.env[ENV.ownerSecret]?.trim();
  if (given !== undefined && given !== "") return given;
  const own = prompter ?? new Prompter(io.stdin, io.stderr);
  try {
    const typed = await own.line("Owner secret (typing is hidden): ", { hidden: true });
    const secret = typed?.trim() ?? "";
    if (secret === "") throw new Stop(`No owner secret was given. Nothing was changed. Set ${ENV.ownerSecret} or type it at the prompt.`);
    return secret;
  } finally {
    if (prompter === undefined) own.close();
  }
}

/** A Nexus client that calls as the owner. */
export const asOwner = (io: Io, address: string, secret: string): Nexus => new Nexus(address, null, io.fetch, secret);

/** Turns an answer that is not the one wanted into a Stop, with a sentence for a secret Nexus did not accept. */
export function ownerRefusal(reply: Reply, what: string): Stop {
  if (reply.status === 401) return new Stop(`Nexus did not accept the owner secret: it is wrong, or this server has none set (the owner's secret is the server's ${ENV.ownerSecret}).`);
  return new Stop(refusal(reply, what).message);
}

/** The first call of every owner command: a read only the owner may make, so a secret Nexus does not accept stops the command before it changes anything. */
export async function checkOwnerSecret(nexus: Nexus): Promise<void> {
  const answer = await nexus.get("tokens");
  if (answer.status === 401) throw new Stop(`${ownerRefusal(answer, "check the owner secret").message} Nothing was changed.`);
  if (answer.status !== 200) throw ownerRefusal(answer, "check the owner secret");
}

/**
 * Signs a device in as `identity` and allows it at once with the owner's secret, then hands back the token it is given (once). The
 * code the device was handed is the one allowed, so the person has no link to open and no code to check.
 */
export async function signInAndAllow(io: Io, address: string, owner: Nexus, identity: string, label: string): Promise<string> {
  const device = new Nexus(address, null, io.fetch);
  const started = await startSignIn(device, identity, label);
  const allowed = await owner.post("device/approve", { code: started.code });
  if (allowed.status !== 200) throw ownerRefusal(allowed, "allow the sign-in");
  for (let ask = 1; ask <= ASKS_AFTER_ALLOW; ask++) {
    const token = await pollForToken(device, started.secret);
    if (token !== null) return token;
    await io.wait(PAUSE_AFTER_ALLOW_MS);
  }
  throw new Stop("Nexus allowed the sign-in but did not hand the token over. Run the command again.");
}

/** Text that came from Nexus (a device chose its label) made safe to show on a terminal: control characters (escape sequences included) and characters that change the direction of the text are dropped. */
export function printable(text: unknown, longest = 80): string {
  const plain = String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "");
  return plain.length > longest ? `${plain.slice(0, longest)}...` : plain;
}
