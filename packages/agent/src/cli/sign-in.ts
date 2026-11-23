// `nexus-agent sign-in --identity <name>`: the device sign-in every device uses. The command asks Nexus to let it in as the
// identity, shows a link and a code, and waits while the owner opens the link (signed in) and allows it. Then it prints the token,
// once. No key is involved: this is only the token the agent signs in to Nexus with.
//
// The two calls a device makes (start, and poll) are here for `owner-sign-in` and `set-up-agent` too, which allow the sign-in
// themselves with the owner's secret instead of waiting for the owner to open the link.

import { Nexus } from "../nexus";
import { Stop, type Io } from "./io";
import { ENV, LABEL } from "./labels";
import { need } from "./settings";

/** How long to wait between asking whether the owner has answered. */
export const POLL_EVERY_MS = 3_000;
/** A sign-in lasts ten minutes by Nexus's clock: a poll that still gets no answer this long after is given up on. */
export const GIVE_UP_AFTER_MS = 11 * 60 * 1000;

export interface StartedSignIn {
  /** Only the device knows it: it is what the token is worked out from. */
  secret: string;
  /** What the owner allows: short enough to read out and safe to show. */
  code: string;
  link: string;
}

/**
 * Asks Nexus to let a device in as `identity`. `deviceKey` is the device's public key (base64) when it wants the owner to give it the
 * vault key with the allow. A Stop in Nexus's own words when it will not.
 */
export async function startSignIn(nexus: Nexus, identity: string, label: string, deviceKey?: string): Promise<StartedSignIn> {
  const started = await nexus.post("device/start", { identity, label, ...(deviceKey === undefined ? {} : { deviceKey }) });
  if (started.status !== 200 || typeof started.json.secret !== "string" || typeof started.json.code !== "string") {
    throw new Stop(typeof started.json.error === "string" ? started.json.error : "Nexus would not start a sign-in. Check the address.");
  }
  return { secret: started.json.secret, code: started.json.code, link: String(started.json.link) };
}

/** What the owner's allow handed a device, once: the token, and the sealed vault key if the owner gave it (both null when it did not). */
export interface Collected {
  token: string;
  /** The vault key sealed to the key the device sent, as base64. Null when the owner allowed the sign-in without giving the key. */
  approval: string | null;
  /** The approving device's public key for this approval, as base64. Null with no approval. */
  approverKey: string | null;
}

/**
 * Asks whether the owner has answered: what it handed over when it has allowed it (once), null while it is still waiting. A refusal is a
 * Stop. `serverWords` says whose words: Nexus's own `error` where it sent one (which says whether the code ran out or was used), or
 * this command's fixed sentences, which is what sign-in and the owner's commands have always said.
 */
async function pollOnce(nexus: Nexus, secret: string, serverWords: boolean): Promise<Collected | null> {
  const answer = await nexus.post("device/poll", { secret });
  const said = typeof answer.json.error === "string" ? answer.json.error : null;
  if (answer.status === 200 && answer.json.status === "approved" && typeof answer.json.token === "string") {
    const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
    const approval = text(answer.json.approval);
    const approverKey = text(answer.json.approverKey);
    return { token: answer.json.token, approval: approverKey === null ? null : approval, approverKey: approval === null ? null : approverKey };
  }
  if (answer.status === 403) throw new Stop(serverWords && said !== null ? said : "The owner denied this sign-in.");
  if (answer.status === 404 || answer.status === 410) throw new Stop(serverWords && said !== null ? said : "The sign-in ran out or was already used. Start again.");
  if (answer.status === 400) throw new Stop(said ?? "Nexus did not understand the sign-in.");
  // pending, or Nexus had a hiccup: ask again
  return null;
}

/** Asks whether the owner has answered: the token when it has allowed it (handed over once), null while it is still waiting. */
export async function pollForToken(nexus: Nexus, secret: string): Promise<string | null> {
  return (await pollOnce(nexus, secret, false))?.token ?? null;
}

/** As `pollForToken`, for a device that sent its key: what was handed over with the token, and Nexus's own words when it is refused. */
export const pollForJoin = (nexus: Nexus, secret: string): Promise<Collected | null> => pollOnce(nexus, secret, true);

export async function signIn(io: Io, options: { identity: string | undefined; label: string | undefined }): Promise<number> {
  if (options.identity === undefined) throw new Stop("Say which identity to sign in as: nexus-agent sign-in --identity <name>.");
  const nexus = new Nexus(need(io, [ENV.address])[ENV.address], null, io.fetch);

  const started = await startSignIn(nexus, options.identity, options.label ?? "nexus-agent");
  io.stderr.write(`Open this link in a browser where you are signed in as the owner, check the code matches, and allow it:\n  ${started.link}\n  code: ${started.code}\n`);
  io.stderr.write("Waiting for you to allow it...\n");

  const giveUpAt = io.now().getTime() + GIVE_UP_AFTER_MS;
  for (;;) {
    await io.wait(POLL_EVERY_MS);
    if (io.now().getTime() > giveUpAt) throw new Stop("The sign-in ran out before it was allowed. Start again.");
    const token = await pollForToken(nexus, started.secret);
    if (token !== null) {
      io.stdout.write(`${LABEL.token}: ${token}\n`);
      io.stderr.write(`Signed in as ${options.identity}. The token is shown once: save it in your secrets manager. It is the ${ENV.token} the other commands read.\n`);
      return 0;
    }
  }
}
