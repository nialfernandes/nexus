// Nexus for an app inside the same Worker. An app calls `nexusAsApp(env, "scribe")` with the Worker's own bindings and
// gets the store's calls under that identity's name: no token, and the same calls as a token holder
// (app-store.ts says what each call gives back and how it is refused).
//
//   const nexus = nexusAsApp(env, "scribe");
//   await nexus.save({ id, base: 0, kid, blob });

import { appStore, type AppStore } from "../../app-store";
import { hostFromEnv } from "./host";

export function nexusAsApp(env: unknown, identity: string): AppStore {
  const host = hostFromEnv(env);
  // An app is never signed in with a session, so there is nobody for the sign-in to name.
  return appStore({ ...host, signIn: { identify: async () => null } }, identity);
}
