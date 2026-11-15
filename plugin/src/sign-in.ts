// Signing in once, the way every device gets a token from Nexus: the plugin asks for an approval for the user the
// person named in the settings, labelled with the device's name, and shows the link and the code. That user opens the
// link while signed in to Nexus and allows it; the plugin polls until the approval is allowed, denied or has run out,
// and keeps the token it is handed once. The token goes into the plugin's data, which main.ts keeps in this device's
// local storage and nowhere else: it is not shown, not put in a notice and not logged.
//
// There is no default user and no default address: a sign-in before both are set is refused, and nothing is sent.
//
// A sign-in belongs to the address and the user it started with. Its calls go to that address, and a token it is handed is
// only kept while the address and the user are still those: if the person changed either while it waited, the sign-in is
// dropped and the token, which is for a different server or a different user, is thrown away.
//
// `startAndPoll` is the part both ways of signing in share: this file's `signIn`, which keeps a token and nothing else, and
// approval.ts's `signInForKey`, which also asks to be sent the vault key and keeps nothing until the person has checked a code.

import { NOT_SET_UP, isSetUp } from "./state";
import type { HttpResponse, SignInDeps } from "./types";

/** How long to wait between asking whether the approval has been answered: no tight loop, and no long wait once it has. */
export const POLL_EVERY_MS = 3_000;
/** A sign-in lasts ten minutes by Nexus's clock. A poll that still gets no answer this long after is given up on. */
const LOCAL_GRACE_MS = 60_000;

const json = (response: HttpResponse): any => {
  try {
    return response.json;
  } catch {
    return {};
  }
};

/** What a sign-in that was allowed was handed, once. `approval` and `approverKey` are base64, or null when the owner's device left none. */
export interface Allowed {
  token: string;
  approval: string | null;
  approverKey: string | null;
}

export type Answered = Allowed | "denied" | "expired" | "changed";

/** What a sign-in began against. */
export interface StartedAgainst {
  address: string;
  user: string;
}

/** True while the plugin still has the address and the user a sign-in began with. */
export const stillAgainst = (deps: Pick<SignInDeps, "data">, began: StartedAgainst): boolean =>
  deps.data.address === began.address && deps.data.user === began.user;

/**
 * Starts a sign-in, shows the person the link and the code, and polls until it is answered. `deviceKey` (base64, an X25519 public
 * key) asks to be sent the vault key sealed to it, and `keyCode` is the code of that key to show with the link. Nothing is kept here:
 * the caller decides what to do with what was handed over, and must check `stillAgainst` before it keeps any of it.
 */
export async function startAndPoll(deps: SignInDeps, options: { deviceKey?: string; keyCode?: string } = {}): Promise<Answered> {
  if (!isSetUp(deps.data)) throw new Error(NOT_SET_UP);
  const began: StartedAgainst = { address: deps.data.address, user: deps.data.user };
  const base = began.address.replace(/\/+$/, "");
  const post = (route: string, body: object) =>
    deps.http({ url: `${base}/${route}`, method: "POST", contentType: "application/json", body: JSON.stringify(body), throw: false });

  let started: HttpResponse;
  try {
    started = await post("device/start", {
      identity: began.user.trim(),
      label: deps.device,
      ...(options.deviceKey === undefined ? {} : { deviceKey: options.deviceKey }),
    });
  } catch {
    throw new Error("Nexus could not be reached, so the sign-in did not start. Check you are online and the address is right.");
  }
  const begun = json(started);
  if (started.status !== 200 || typeof begun.secret !== "string") {
    throw new Error(typeof begun.error === "string" ? begun.error : "Nexus would not start a sign-in. Check the address is right.");
  }
  if (!stillAgainst(deps, began)) return "changed";

  deps.show(begun.link, begun.code, options.keyCode);
  deps.open(begun.link);

  for (;;) {
    await deps.wait(POLL_EVERY_MS);
    if (!stillAgainst(deps, began)) return "changed";
    if (Date.now() > Number(begun.expiresAt) + LOCAL_GRACE_MS) return "expired";

    let answer: HttpResponse;
    try {
      answer = await post("device/poll", { secret: begun.secret });
    } catch {
      continue; // no network for a moment: ask again
    }
    // The answer came from the server this sign-in began against, but the person may have changed the address or the user while it was on the way.
    if (!stillAgainst(deps, began)) return "changed";
    const said = json(answer);
    if (answer.status === 200 && said.status === "approved" && typeof said.token === "string") {
      return {
        token: said.token,
        approval: typeof said.approval === "string" ? said.approval : null,
        approverKey: typeof said.approverKey === "string" ? said.approverKey : null,
      };
    }
    if (answer.status === 403) return "denied";
    if (answer.status === 410 || answer.status === 404) return "expired";
    if (answer.status === 400) throw new Error(typeof said.error === "string" ? said.error : "Nexus did not understand the sign-in.");
    // pending, or Nexus had a hiccup: ask again
  }
}

/** Signs in for a token and nothing else. Returns "changed" when the address or the user was changed while it waited: the token is then not kept. */
export async function signIn(deps: SignInDeps): Promise<"signed-in" | "denied" | "expired" | "changed"> {
  const answered = await startAndPoll(deps);
  if (typeof answered === "string") return answered;
  deps.data.token = answered.token;
  await deps.persist(deps.data);
  return "signed-in";
}
