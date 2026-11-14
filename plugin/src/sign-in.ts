// Signing in once, the way every device gets a token from Nexus: the plugin asks for an approval for the user the
// person named in the settings, labelled with the device's name, and shows the link and the code. That user opens the
// link while signed in to Nexus and allows it; the plugin polls until the approval is allowed, denied or has run out,
// and keeps the token it is handed once. The token goes into the plugin's data, which main.ts keeps in this device's
// local storage and nowhere else: it is not shown, not put in a notice and not logged.
//
// There is no default user and no default address: a sign-in before both are set is refused, and nothing is sent.

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

export async function signIn(deps: SignInDeps): Promise<"signed-in" | "denied" | "expired"> {
  if (!isSetUp(deps.data)) throw new Error(NOT_SET_UP);
  const base = deps.data.address.replace(/\/+$/, "");
  const post = (route: string, body: object) =>
    deps.http({ url: `${base}/${route}`, method: "POST", contentType: "application/json", body: JSON.stringify(body), throw: false });

  let started: HttpResponse;
  try {
    started = await post("device/start", { identity: deps.data.user.trim(), label: deps.device });
  } catch {
    throw new Error("Nexus could not be reached, so the sign-in did not start. Check you are online and the address is right.");
  }
  const begun = json(started);
  if (started.status !== 200 || typeof begun.secret !== "string") {
    throw new Error(typeof begun.error === "string" ? begun.error : "Nexus would not start a sign-in. Check the address is right.");
  }

  deps.show(begun.link, begun.code);
  deps.open(begun.link);

  for (;;) {
    await deps.wait(POLL_EVERY_MS);
    if (Date.now() > Number(begun.expiresAt) + LOCAL_GRACE_MS) return "expired";

    let answer: HttpResponse;
    try {
      answer = await post("device/poll", { secret: begun.secret });
    } catch {
      continue; // no network for a moment: ask again
    }
    const said = json(answer);
    if (answer.status === 200 && said.status === "approved" && typeof said.token === "string") {
      deps.data.token = said.token;
      await deps.persist(deps.data);
      return "signed-in";
    }
    if (answer.status === 403) return "denied";
    if (answer.status === 410 || answer.status === 404) return "expired";
    if (answer.status === 400) throw new Error(typeof said.error === "string" ? said.error : "Nexus did not understand the sign-in.");
    // pending, or Nexus had a hiccup: ask again
  }
}
