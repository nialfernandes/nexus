// `nexus-agent sign-in --identity <name>`: the device sign-in every device uses. The command asks Nexus to let it in as the
// identity, shows a link and a code, and waits while the owner opens the link (signed in) and allows it. Then it prints the token,
// once. No key is involved: this is only the token the agent signs in to Nexus with.

import { Nexus } from "../nexus";
import { Stop, type Io } from "./io";
import { ENV, LABEL } from "./labels";
import { need } from "./settings";

/** How long to wait between asking whether the owner has answered. */
export const POLL_EVERY_MS = 3_000;
/** A sign-in lasts ten minutes by Nexus's clock: a poll that still gets no answer this long after is given up on. */
const GIVE_UP_AFTER_MS = 11 * 60 * 1000;

export async function signIn(io: Io, options: { identity: string | undefined; label: string | undefined }): Promise<number> {
  if (options.identity === undefined) throw new Stop("Say which identity to sign in as: nexus-agent sign-in --identity <name>.");
  const nexus = new Nexus(need(io, [ENV.address])[ENV.address], null, io.fetch);

  const started = await nexus.post("device/start", { identity: options.identity, label: options.label ?? "nexus-agent" });
  if (started.status !== 200 || typeof started.json.secret !== "string") {
    throw new Stop(typeof started.json.error === "string" ? started.json.error : "Nexus would not start a sign-in. Check the address.");
  }
  io.stderr.write(`Open this link in a browser where you are signed in as the owner, check the code matches, and allow it:\n  ${started.json.link}\n  code: ${started.json.code}\n`);
  io.stderr.write("Waiting for you to allow it...\n");

  const giveUpAt = io.now().getTime() + GIVE_UP_AFTER_MS;
  for (;;) {
    await io.wait(POLL_EVERY_MS);
    if (io.now().getTime() > giveUpAt) throw new Stop("The sign-in ran out before it was allowed. Start again.");
    const answer = await nexus.post("device/poll", { secret: started.json.secret });
    if (answer.status === 200 && answer.json.status === "approved" && typeof answer.json.token === "string") {
      io.stdout.write(`${LABEL.token}: ${answer.json.token}\n`);
      io.stderr.write(`Signed in as ${options.identity}. The token is shown once: save it in your secrets manager. It is the ${ENV.token} the other commands read.\n`);
      return 0;
    }
    if (answer.status === 403) throw new Stop("The owner denied this sign-in.");
    if (answer.status === 404 || answer.status === 410) throw new Stop("The sign-in ran out or was already used. Start again.");
    if (answer.status === 400) throw new Stop(typeof answer.json.error === "string" ? answer.json.error : "Nexus did not understand the sign-in.");
    // pending, or Nexus had a hiccup: ask again
  }
}
