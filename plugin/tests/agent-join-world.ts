// What the two agent-join tests (agent-join-worked-example.test.ts and agent-wrong-code.test.ts) share: the screens over an owner's device, a
// wait that lets the controller's calls to Nexus run, and the reading of what `nexus-agent join` printed. The agent is the real command
// (packages/agent, run by its own test world), the owner's device is the real setup controller and screens over the real server code.

import { SetupScreens } from "../src/screens/setup-screens";
import type { SetupDevice } from "./setup-world";
import { askNexus, bodyOf, type World } from "./world";

/** The screens over a device's controller, in the page the test installed, as the modal holds them. */
export function screensFor(device: SetupDevice): { screens: SetupScreens; root: HTMLElement; closed: () => number } {
  let closes = 0;
  const screens = new SetupScreens({
    setup: device.setup,
    copy: async () => undefined,
    later: (_ms, run) => {
      const timer = setTimeout(run, 2000);
      return () => clearTimeout(timer);
    },
    close: () => void closes++,
  });
  document.body.append(screens.element);
  return { screens, root: screens.element, closed: () => closes };
}

/** Waits (letting the controller's calls to Nexus run) until `done` says so. */
export async function until(what: string, done: () => boolean, where: () => unknown = () => undefined): Promise<void> {
  for (let turn = 0; turn < 400; turn++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never reached: ${what}; it is at ${JSON.stringify(where())}`);
}

/** The owner adds an agent by name, as the page does (POST identity as the owner). */
export async function addAgent(world: World, name: string): Promise<void> {
  bodyOf(await askNexus("POST", "identity", { cookie: world.ownerCookie }, { name, kind: "agent" }));
}

/** The agent code `join` printed, as the ten characters a person types. */
export function agentCodeIn(stderr: string): string {
  const printed = /agent code: ([0-9A-Z]{5}-[0-9A-Z]{5})/.exec(stderr)?.[1];
  if (printed === undefined) throw new Error(`join has not printed an agent code: ${stderr}`);
  return printed.replace("-", "");
}

/** The same code with its last character changed: a wrong try that is one slip away from the right one. */
export const slipped = (code: string): string => `${code.slice(0, 9)}${code[9] === "Z" ? "Y" : "Z"}`;

/** The four values `join` printed, as the environment the agent's other commands read. */
export function environmentOf(stdout: string): Record<string, string> {
  return Object.fromEntries(stdout.trimEnd().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

/**
 * What the owner does while `join` waits, run inside the command's own pause. The command turns any error thrown there into its plain
 * "something went wrong" line and a failed exit, which a test that expects a failed exit would take for the result it wanted. So the first
 * error is kept and `check()`, called after the run, throws it again as it was.
 */
export function whileWaiting(body: (printed: { stdout: string; stderr: string }) => Promise<void>): {
  onWait: (printed: { stdout: string; stderr: string }) => Promise<void>;
  check: () => void;
} {
  let failure: unknown = null;
  return {
    onWait: async (printed) => {
      try {
        await body(printed);
      } catch (error) {
        failure ??= error;
        throw error;
      }
    },
    check: () => {
      if (failure !== null) throw failure;
    },
  };
}
