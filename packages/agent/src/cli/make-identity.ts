// `nexus-agent make-identity --name <name> --kind agent|person|app`: makes an identity on Nexus with the owner's secret, the request
// the server's README once had a person write by hand.

import { Stop, type Io } from "./io";
import { ENV } from "./labels";
import { asOwner, requireSecureAddress, checkOwnerSecret, ownerRefusal, readOwnerSecret } from "./owner";
import { need } from "./settings";

/** The kinds of identity Nexus knows (server/src/identities.ts). */
export const KINDS = ["agent", "person", "app"] as const;

export async function makeIdentity(io: Io, options: { name: string | undefined; kind: string | undefined }): Promise<number> {
  if (options.name === undefined) throw new Stop("Say the identity's name: nexus-agent make-identity --name <name> --kind agent|person|app.");
  if (options.kind === undefined || !(KINDS as readonly string[]).includes(options.kind)) {
    throw new Stop("Say the identity's kind, one of agent, person or app: nexus-agent make-identity --name <name> --kind agent|person|app.");
  }
  const address = need(io, [ENV.address])[ENV.address];
  requireSecureAddress(address);
  const owner = asOwner(io, address, await readOwnerSecret(io));
  await checkOwnerSecret(owner);

  const made = await owner.post("identity", { name: options.name, kind: options.kind });
  if (made.status !== 200) throw ownerRefusal(made, "make the identity");
  io.stderr.write(`Made the identity ${options.name} (kind ${options.kind}). Sign it in with: nexus-agent sign-in --identity ${options.name}\n`);
  return 0;
}
