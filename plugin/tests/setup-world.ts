// A device whose key comes from the real key holder (src/key-holder.ts) and which has the real setup controller (src/vault-setup.ts)
// over it, on the same test world as every other device (world.ts): the real server code, an in-memory vault, the plugin's own sync
// engine. Nothing is stood in for but Obsidian and the clock. The engine is given the holder, so a vault the controller unlocks is a
// vault this engine syncs, and one it locks is one this engine leaves alone.
//
// `whenWaiting` is what the person does while a device waits for the other one: a sign-in polls, and each time it pauses this is
// called with the number of the pause. It stands in for the person walking to the other device.

import { KeyHolder } from "../src/key-holder";
import type { Http } from "../src/types";
import type { SetupState } from "../src/vault-setup";
import { VaultSetup } from "../src/vault-setup";
import { loadSync, makeDevice, type Device, type DeviceOptions, type World } from "./world";

export interface SetupDevice extends Omit<Device, "unlock"> {
  /** The key holder: both the engine's key and where the setup puts it. */
  holder: KeyHolder;
  unlock: KeyHolder;
  setup: VaultSetup;
  /** The links the setup asked to be opened in a browser. */
  opened: string[];
  /** Every state the setup went through, in order, as a copy. */
  states: SetupState[];
  /** What the person does at each pause of a sign-in: called with the number of the pause, from 1. */
  whenWaiting: ((pause: number) => Promise<void>) | null;
}

/**
 * A device with a key holder and a setup controller. It starts locked, whatever else is given; `token: null` is a new device.
 * `intercept` wraps the setup controller's calls to Nexus (the engine's are untouched), to make one of them fail.
 */
export async function setupDevice(world: World, options: DeviceOptions = {}, intercept?: (next: Http) => Http): Promise<SetupDevice> {
  const device = await makeDevice(world, { ...options, unlock: null });
  const { createSyncEngine } = await loadSync();
  const holder = new KeyHolder();
  const engine = createSyncEngine({ ...device.deps, unlock: holder });
  const made: SetupDevice = {
    ...device,
    engine,
    holder,
    unlock: holder,
    opened: [],
    states: [],
    whenWaiting: null,
    setup: undefined as unknown as VaultSetup,
  };
  let pauses = 0;
  made.setup = new VaultSetup({
    http: intercept ? intercept(device.deps.http) : device.deps.http,
    data: device.deps.data,
    persist: device.deps.persist,
    device: () => device.deps.device,
    keys: holder,
    open: (link) => void made.opened.push(link),
    wait: async () => {
      pauses++;
      if (pauses > 40) throw new Error("the sign-in was never answered: the test's person did nothing for 40 pauses");
      await made.whenWaiting?.(pauses);
    },
  });
  made.setup.onChange(() => void made.states.push(structuredClone(made.setup.state)));
  return made;
}

/** The step the setup is at, narrowed: fails with what it is at instead when it is not at `step`. */
export function at<S extends SetupState["step"]>(device: SetupDevice, step: S): Extract<SetupState, { step: S }> {
  const state = device.setup.state;
  if (state.step !== step) throw new Error(`the setup is at ${JSON.stringify(state)}, not at ${step}`);
  return state as Extract<SetupState, { step: S }>;
}

/** What the person types for the groups the setup asked for: those groups of the Recovery Key as it is shown, one after the other. */
export function groupsAsked(shown: { recoveryKey: string; ask: number[] }): string {
  const groups = shown.recoveryKey.split("-");
  return shown.ask.map((group) => groups[group - 1]).join("");
}

/** The same, with the first asked group slipped by a character: a wrong try that gets the other two right. */
export function groupsAskedWithASlip(shown: { recoveryKey: string; ask: number[] }): string {
  const typed = groupsAsked(shown);
  return `${typed[0] === "9" ? "8" : "9"}${typed.slice(1)}`;
}

/** A device that has made the vault, the way a person's first device does: asked, shown the key, typed the groups back, chose no password (or the one given), and is done. Answers the Recovery Key it was shown. */
export async function firstRun(world: World, options: DeviceOptions = {}, password: string | null = null): Promise<{ device: SetupDevice; recoveryKey: string }> {
  const device = await setupDevice(world, options);
  await device.setup.begin();
  await device.setup.startFirstRun();
  const shown = at(device, "show-key");
  device.setup.typeBack(groupsAsked(shown));
  at(device, "choose-password");
  await device.setup.finishSetup(password === null ? null : { password, again: password });
  at(device, "set-up");
  device.setup.done();
  if (device.setup.state.step !== "unlocked") throw new Error(`the first run did not unlock: ${JSON.stringify(device.setup.state)}`);
  return { device, recoveryKey: shown.recoveryKey };
}
