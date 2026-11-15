// A device whose key comes from the real key holder (src/key-holder.ts) and which has the real setup controller (src/vault-setup.ts)
// over it, on the same test world as every other device (world.ts): the real server code, an in-memory vault, the plugin's own sync
// engine. Nothing is stood in for but Obsidian and the clock. The engine is given the holder, so a vault the controller unlocks is a
// vault this engine syncs, and one it locks is one this engine leaves alone.
//
// `whenWaiting` is what the person does while a device waits for the other one: a sign-in polls, and each time it pauses this is
// called with the number of the pause. It stands in for the person walking to the other device.

import { KeyHolder } from "../src/key-holder";
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

/** A device with a key holder and a setup controller. It starts locked, whatever else is given; `token: null` is a new device. */
export async function setupDevice(world: World, options: DeviceOptions = {}): Promise<SetupDevice> {
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
    http: device.deps.http,
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

/** The last group of four characters of a Recovery Key as it is shown: what the person types back. */
export const lastGroup = (recoveryKey: string): string => recoveryKey.split("-").at(-1)!;

/** Four characters that are not the last group of `recoveryKey`. */
export function notTheLastGroup(recoveryKey: string): string {
  const group = lastGroup(recoveryKey);
  return `${group[0] === "Z" ? "Y" : "Z"}${group.slice(1)}`;
}

/** A device that has made the vault, the way a person's first device does: asked, shown the key, typed the check characters back. Answers the Recovery Key it was shown. */
export async function firstRun(world: World, options: DeviceOptions = {}): Promise<{ device: SetupDevice; recoveryKey: string }> {
  const device = await setupDevice(world, options);
  await device.setup.begin();
  await device.setup.startFirstRun();
  const { recoveryKey } = at(device, "show-key");
  await device.setup.typeBack(lastGroup(recoveryKey));
  if (device.setup.state.step !== "unlocked") throw new Error(`the first run did not unlock: ${JSON.stringify(device.setup.state)}`);
  return { device, recoveryKey };
}
