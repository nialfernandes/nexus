// `nexus-agent owner-sign-in --identity <the owner's name>`: the owner's own token, made in one step, for `create-vault` and
// `approve-agent`. The command starts a sign-in for the owner's identity, allows it with the owner's secret, collects the token and
// prints it once. The person never opens the approval page for their own terminal.

import { Stop, type Io } from "./io";
import { ENV, LABEL } from "./labels";
import { asOwner, checkOwnerSecret, readOwnerSecret, signInAndAllow } from "./owner";
import { need } from "./settings";

export async function ownerSignIn(io: Io, options: { identity: string | undefined; label: string | undefined }): Promise<number> {
  if (options.identity === undefined) throw new Stop("Say the owner's name: nexus-agent owner-sign-in --identity <the owner's name>. It is the server's NEXUS_OWNER setting.");
  const address = need(io, [ENV.address])[ENV.address];
  const owner = asOwner(io, address, await readOwnerSecret(io));
  await checkOwnerSecret(owner);

  const token = await signInAndAllow(io, address, owner, options.identity, options.label ?? "owner terminal");
  io.stdout.write(`${LABEL.token}: ${token}\n`);
  io.stderr.write(`Signed in as ${options.identity}. The token is shown once: save it in your secrets manager. It is the ${ENV.token} that create-vault and approve-agent read.\n`);
  return 0;
}
