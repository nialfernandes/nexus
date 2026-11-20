// A new device is given the vault key by a device that already has it: the owner approves it, and it can unlock the vault
// with no Recovery Key typed. This file is the engine of that exchange, both halves of it. The setup controller (vault-setup.ts) drives it, and the screens in src/screens draw that.
//
//   THE NEW DEVICE (`signInForKey`). It makes an X25519 key pair for this attempt, keeps the private half in memory only, and
//   asks Nexus for a sign-in with the public half. It shows the person the link and a DEVICE CODE (a short code of its own
//   public key, the key code); the person types that code, and only that, on the approving device. When the owner's device allows it, the first poll hands over the token and the approval: the vault key
//   sealed to the device's public key. The device opens the approval, works out a MATCHING CODE from both devices' public
//   keys and the sealed bytes, and then holds everything back. It uses nothing from the approval (no key, not even the token)
//   until the person types, on this device, the matching code the approving device shows, and `confirm` finds it is the same.
//
//   THE APPROVING DEVICE (`approveDevice`). It is unlocked. The person has read the DEVICE CODE (the key code) off the new device and
//   types only that here. Nexus is asked which sign-ins are waiting (GET /device/waiting) and, for each, for the public key it was
//   given. Nexus cannot be trusted with those keys: a key of its own put in a new device's place would be sent the vault key. So this
//   device works out the key code of every key it was given itself and takes the sign-in whose key has the code the person typed, and
//   seals nothing if there is none. Then it seals the vault key to that key, with the vault id and the kid, and sends the approval with
//   the allow, and a public key of its own for this approval. It shows the person the matching code.
//
// What a hostile server can and cannot do (docs/FORMAT.md section 7.4): it cannot get the vault key by swapping the new
// device's key (the approving device refuses); it cannot get a device to use a key of its own by making or swapping an
// approval (the codes differ and the person types the approving device's, which it cannot match); it can only refuse to deliver.
//
// No key pair, key or approval is written anywhere: not to the plugin's data, not to the vault, not to a log. The private half
// of the new device's key pair is dropped as soon as the approval is open, and a key that was refused is overwritten with zeros.
// Only a key that was confirmed is handed on, to the unlock port (src/unlock.ts), which keeps it in memory.

import {
  NexusCryptoError, approvalCode, deviceKeyCode, generateDeviceKeyPair, openApproval, readApprovalCode, sealApproval,
} from "@nexus/crypto";
import { decodeBase64, encodeBase64 } from "./base64";
import { startAndPoll, stillAgainst, type Allowed } from "./sign-in";
import { NOT_SET_UP, isSetUp } from "./state";
import type { Http, HttpResponse, PluginData, SignInDeps } from "./types";
import type { KeyReceiver, Unlock } from "./unlock";

// ── the new device ───────────────────────────────────────────────────────────

export interface KeySignInDeps extends SignInDeps {
  /** Where the vault key is put, once the person has confirmed the matching code. Nothing is put there before. */
  unlock: KeyReceiver;
}

/** How many wrong matching codes an approval takes: the third one closes it, as `refuse` does, and a new approval has to be asked for. */
export const MATCHING_CODE_TRIES = 3;

/** What was handed to the new device, held back until the person has checked the code. */
export interface PendingApproval {
  /** The matching code this device worked out. A screen may show it for the person to compare. */
  code: string;
  /**
   * The person typed the code the approving device shows. If it is the one worked out here, the token is kept and the key is put
   * in the unlock port: "unlocked". If it is not (or is not a code), nothing happens and the person may try again: "mismatch".
   * "changed" means the address or user name was changed meanwhile, so everything is dropped. "closed" means it was refused already.
   * A wrong code uses up one of MATCHING_CODE_TRIES: the last one answers "mismatch" and closes the approval, the key overwritten, so
   * every later call answers "closed". A mismatch is a typing mistake or an approval a server swapped, and a swapped one never matches.
   */
  confirm(typed: string): Promise<"unlocked" | "mismatch" | "changed" | "closed">;
  /** The person says the codes did not match, or gives up: the token and the key are forgotten. */
  refuse(): void;
  /** How many wrong codes are still allowed: MATCHING_CODE_TRIES at first, 0 once the approval is closed. */
  readonly triesLeft: number;
}

export type KeySignIn =
  /** Allowed with no key left for this device (from the approval page, say): signed in, still locked. The Recovery Key is the way in. */
  | { result: "signed-in" }
  | { result: "denied" | "expired" | "changed" }
  /** Nexus handed over an approval that did not open for this device, or is not the shape of one. Nothing was kept. */
  | { result: "bad-approval" }
  | { result: "check-code"; approval: PendingApproval };

/** Asks to be signed in and sent the vault key. */
export async function signInForKey(deps: KeySignInDeps): Promise<KeySignIn> {
  const pair = await generateDeviceKeyPair();
  const keyCode = await deviceKeyCode(pair.publicKey);
  const began = { address: deps.data.address, user: deps.data.user };
  let answered: Allowed | "denied" | "expired" | "changed";
  try {
    answered = await startAndPoll(deps, { deviceKey: encodeBase64(pair.publicKey), keyCode });
  } catch (error) {
    pair.privateKey.fill(0);
    throw error;
  }
  if (typeof answered === "string") {
    pair.privateKey.fill(0);
    return { result: answered };
  }

  const keepToken = async (): Promise<boolean> => {
    if (!stillAgainst(deps, began)) return false;
    deps.data.token = answered.token;
    await deps.persist(deps.data);
    return true;
  };

  if (answered.approval === null || answered.approverKey === null) {
    pair.privateKey.fill(0);
    return (await keepToken()) ? { result: "signed-in" } : { result: "changed" };
  }

  const sealed = decodeBase64(answered.approval);
  const approverKey = decodeBase64(answered.approverKey);
  let opened: Awaited<ReturnType<typeof openApproval>>;
  let code: string;
  try {
    if (sealed === null || approverKey === null) throw new NexusCryptoError("malformed", "the approval is not base64");
    // The vault is not known yet, so none is named: the approval says which it is for, and the person's check covers it.
    opened = await openApproval(pair, sealed);
    code = await approvalCode({ newDevicePublicKey: pair.publicKey, approverPublicKey: approverKey, kid: opened.kid, sealed });
  } catch (error) {
    if (error instanceof NexusCryptoError) return { result: "bad-approval" };
    throw error;
  } finally {
    pair.privateKey.fill(0);
  }

  let open = true;
  let triesLeft = MATCHING_CODE_TRIES;
  const refuse = (): void => {
    if (!open) return;
    open = false;
    triesLeft = 0;
    opened.vaultKey.fill(0);
  };
  return {
    result: "check-code",
    approval: {
      code,
      async confirm(typed) {
        if (!open) return "closed";
        if (readApprovalCode(typed) !== code) {
          if (--triesLeft <= 0) refuse();
          return "mismatch";
        }
        if (!(await keepToken())) {
          refuse();
          return "changed";
        }
        open = false;
        deps.unlock.unlock({ vaultKey: opened.vaultKey, vaultId: opened.vaultId, kid: opened.kid });
        return "unlocked";
      },
      refuse,
      get triesLeft() {
        return triesLeft;
      },
    },
  };
}

// ── the approving device ─────────────────────────────────────────────────────

/** What is said when Nexus cannot be reached. */
export const UNREACHABLE = "Nexus could not be reached. Check you are online.";

/** Why a device could not be approved, in words a person can read. `reason` is for a screen that wants to act on it. */
export class ApprovalError extends Error {
  constructor(
    readonly reason: "locked" | "signed-out" | "not-set-up" | "unreachable" | "no-such-code" | "gone" | "not-allowed" | "wrong-key-code" | "refused",
    message: string,
  ) {
    super(message);
  }
}

export interface ApproveDeps {
  http: Http;
  /** The address and the token of the approving device: it is signed in as the owner. */
  data: Pick<PluginData, "address" | "user" | "token">;
  /** Where the vault key is: this device has to be unlocked. */
  unlock: Unlock;
}

export interface Approved {
  /** The matching code: shown on this device for the person to type on the new one. */
  code: string;
  /** The label the new device asked with. */
  label: string;
}

const body = (response: HttpResponse): any => {
  try {
    return response.json;
  } catch {
    return {};
  }
};

type Call = (request: Parameters<Http>[0]) => Promise<HttpResponse>;

/** What Nexus says about a sign-in that waits to be approved. */
interface PendingSignIn {
  label: string;
  /** The public key the new device asked to be sent the vault key with, as Nexus gave it, or null when it sent none. */
  deviceKey: Uint8Array | null;
}

/** The calls of an approving device: it has to be unlocked, set up and signed in, and Nexus is asked with its token. Throws an ApprovalError when it is not. */
function approverCalls(deps: ApproveDeps): { keys: NonNullable<ReturnType<Unlock["keys"]>>; base: string; call: Call } {
  const keys = deps.unlock.keys();
  if (keys === null) throw new ApprovalError("locked", "This device is locked, so it has no key to give. Unlock the vault first.");
  if (!isSetUp(deps.data as PluginData)) throw new ApprovalError("not-set-up", NOT_SET_UP);
  if (deps.data.token === null) throw new ApprovalError("signed-out", "This device is signed out of Nexus. Sign in first.");
  const base = deps.data.address.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${deps.data.token}` };
  const call: Call = async (request) => {
    try {
      return await deps.http({ ...request, headers, throw: false });
    } catch {
      throw new ApprovalError("unreachable", UNREACHABLE);
    }
  };
  return { keys, base, call };
}

/** Asks Nexus about the sign-in under `signInCode`. Throws a "no-such-code" or "gone" ApprovalError when it is not there or has run out. */
async function askWhatIsPending(base: string, call: Call, signInCode: string): Promise<PendingSignIn> {
  const found = await call({ url: `${base}/device/pending?code=${encodeURIComponent(signInCode)}`, method: "GET" });
  const pending = body(found);
  if (found.status === 404) throw new ApprovalError("no-such-code", "Nexus has no sign-in with that code.");
  if (found.status === 410) throw new ApprovalError("gone", GONE);
  if (found.status === 401 || found.status === 403) throw new ApprovalError("not-allowed", NOT_OWNER);
  if (found.status !== 200) throw new ApprovalError("refused", typeof pending.error === "string" ? pending.error : "Nexus would not show that sign-in.");
  const deviceKey = typeof pending.deviceKey === "string" ? decodeBase64(pending.deviceKey) : null;
  return { label: typeof pending.label === "string" ? pending.label : "", deviceKey: deviceKey !== null && deviceKey.length === 32 ? deviceKey : null };
}

/** What is said when no waiting device has the code that was typed (or what was typed is not a code): the same words either way, and nothing was sent. */
const NO_DEVICE_HAS_THAT_CODE = "No device that is waiting has that code, so nothing was sent. Check the code on the new device, and try again.";
const GONE = "That sign-in has run out or was answered already. Start it again on the new device.";
const NOT_OWNER = "Only the owner can approve a device.";

/** The sign-in a device code belongs to, as the approving device found it: never taken from Nexus's word, only from the key itself. */
interface FoundDevice {
  signInCode: string;
  label: string;
  deviceKey: Uint8Array;
}

/**
 * Finds the waiting sign-in whose public key has the key code `deviceCode` (as `readApprovalCode` wrote it). Nexus lists what waits
 * (GET /device/waiting: label and sign-in code, nothing secret) and gives each sign-in's public key (GET /device/pending). The code is
 * worked out here from each key, so Nexus is believed about nothing but which sign-ins exist: a key it swapped in has another code and
 * is never taken. A sign-in that sent no key cannot be found this way, and one that ran out while the list was read is passed over.
 * Answers null when no waiting device has that code.
 */
async function findByDeviceCode(base: string, call: Call, deviceCode: string): Promise<FoundDevice | null> {
  const listed = await call({ url: `${base}/device/waiting`, method: "GET" });
  const said = body(listed);
  if (listed.status === 401 || listed.status === 403) throw new ApprovalError("not-allowed", NOT_OWNER);
  if (listed.status !== 200) throw new ApprovalError("refused", typeof said.error === "string" ? said.error : "Nexus would not say which devices are waiting.");
  const signins: unknown[] = Array.isArray(said.signins) ? said.signins : [];
  for (const entry of signins) {
    const signInCode = typeof (entry as { code?: unknown })?.code === "string" ? (entry as { code: string }).code : null;
    if (signInCode === null) continue;
    let pending: PendingSignIn;
    try {
      pending = await askWhatIsPending(base, call, signInCode);
    } catch (error) {
      if (error instanceof ApprovalError && (error.reason === "no-such-code" || error.reason === "gone")) continue;
      throw error;
    }
    if (pending.deviceKey !== null && (await deviceKeyCode(pending.deviceKey)) === deviceCode) {
      return { signInCode, label: pending.label, deviceKey: pending.deviceKey };
    }
  }
  return null;
}

/**
 * Approves the new device that shows `typedDeviceCode` and leaves it the vault key. The person read that code off the new device's own
 * screen and types nothing else: it is the key code of the public key the new device made, and it finds the sign-in too.
 * Throws an ApprovalError, with nothing sent that could carry the key, when this device is locked or signed out, when no waiting
 * device has that code (what was typed is not a code, or Nexus has no sign-in whose key it is, or Nexus gave a key that is not the one
 * the person's code is for), or when Nexus refuses.
 */
export async function approveDevice(deps: ApproveDeps, typedDeviceCode: string): Promise<Approved> {
  const { keys, base, call } = approverCalls(deps);
  const typed = readApprovalCode(typedDeviceCode);
  if (typed === null) throw new ApprovalError("wrong-key-code", NO_DEVICE_HAS_THAT_CODE);
  const found = await findByDeviceCode(base, call, typed);
  if (found === null) throw new ApprovalError("wrong-key-code", NO_DEVICE_HAS_THAT_CODE);
  const { signInCode, deviceKey } = found;

  const sealed = await sealApproval(deviceKey, keys.vaultKey, { vaultId: keys.vaultId, kid: keys.kid });
  // A key pair for this approval alone: only its public half is used, to tie the code to this approval, and the private half is dropped.
  const mine = await generateDeviceKeyPair();
  mine.privateKey.fill(0);
  const code = await approvalCode({ newDevicePublicKey: deviceKey, approverPublicKey: mine.publicKey, kid: keys.kid, sealed });

  const answered = await call({
    url: `${base}/device/approve`,
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({ code: signInCode, approval: encodeBase64(sealed), approverKey: encodeBase64(mine.publicKey) }),
  });
  if (answered.status !== 200) {
    const said = body(answered);
    if (answered.status === 410) throw new ApprovalError("gone", GONE);
    if (answered.status === 401 || answered.status === 403) throw new ApprovalError("not-allowed", NOT_OWNER);
    throw new ApprovalError("refused", typeof said.error === "string" ? said.error : "Nexus would not take the approval.");
  }
  return { code, label: found.label };
}
