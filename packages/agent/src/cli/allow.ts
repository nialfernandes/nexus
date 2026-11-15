// `nexus-agent allow <code>` and `deny <code>`: answer a device's sign-in with the owner's secret. The command shows what Nexus says is
// asking (the identity and the label) and asks the person to type `yes`. Anything else, and an input that ends first, answers nothing.

import { Stop, type Io } from "./io";
import { ENV } from "./labels";
import { asOwner, checkOwnerSecret, ownerRefusal, printable, readOwnerSecret } from "./owner";
import { Prompter } from "./prompt";
import { need } from "./settings";

const WORDS = {
  allow: { route: "device/approve", asked: "allow", done: "Allowed" },
  deny: { route: "device/deny", asked: "deny", done: "Denied" },
} as const;

async function answer(io: Io, command: keyof typeof WORDS, code: string | undefined): Promise<number> {
  if (code === undefined) throw new Stop(`Say which sign-in: nexus-agent ${command} <code>. The code is the one the device was shown.`);
  const words = WORDS[command];
  const address = need(io, [ENV.address])[ENV.address];
  const prompter = new Prompter(io.stdin, io.stderr);
  try {
    const owner = asOwner(io, address, await readOwnerSecret(io, prompter));
    await checkOwnerSecret(owner);

    const asking = await owner.get("device/pending", { code });
    if (asking.status !== 200) throw ownerRefusal(asking, "look up that sign-in");
    io.stderr.write(`This sign-in is waiting for an answer:\n  as the identity: ${printable(asking.json.identity)}\n  label: ${printable(asking.json.label)}\n  code: ${printable(code)}\n`);
    if (typeof asking.json.deviceKey === "string") {
      io.stderr.write("  The device sent a key of its own to be sealed to. This command sends no approval: the device is signed in and holds no vault key.\n");
    }
    io.stderr.write(`Whoever started it is signed in as that identity the moment you allow it. Check that the label is the device you meant.\n`);

    const typed = await prompter.line(`Type yes to ${words.asked} it: `);
    if (typed?.trim().toLowerCase() !== "yes") {
      throw new Stop(`That was not "yes", so the sign-in was not ${command === "allow" ? "allowed" : "denied"}. Nothing was changed.`);
    }
    const done = await owner.post(words.route, { code });
    if (done.status !== 200) throw ownerRefusal(done, `${words.asked} the sign-in`);
    io.stderr.write(`${words.done} the sign-in for ${printable(asking.json.identity)}.\n`);
    return 0;
  } finally {
    prompter.close();
  }
}

export const allow = (io: Io, code: string | undefined): Promise<number> => answer(io, "allow", code);
export const deny = (io: Io, code: string | undefined): Promise<number> => answer(io, "deny", code);
