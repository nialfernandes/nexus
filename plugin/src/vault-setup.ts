// Setting up, unlocking, approving and locking the vault: a plain state machine the setup screens will drive. It has no look and no
// words of a screen's own: a screen reads `state`, shows what it says, and calls one event when the person does something. The
// plain sentences in a state's `message` are there so nothing is ever refused without saying why; the screens' wording replaces them.
//
// Every key step is the shared one (`@nexus/agent/setup`, the same code `nexus-agent create-vault` and `approve-agent` run) or the
// approval engine's (approval.ts). Nothing here makes a key, opens a wrap or seals an approval in a way of its own, and the key goes to
// one place only: the key holder (key-holder.ts), in memory.
//
// THE STATES (what is on the screen, in plain words)
//   locked             The vault is locked and nothing is going on. This is where the plugin starts, and where lock and cancel end.
//   unlocked           The vault is unlocked and nothing is going on. The plugin syncs.
//   working            Something is being asked of Nexus or worked out; wait. `doing` says which: looking (what Nexus holds),
//                      starting-sign-in, saving (the Recovery wrap), opening (the vault key with the Recovery Key), approving (a device).
//   stopped            It cannot go on, and says why in `message` (and `reason`). Nothing was kept. `begin` starts again.
//   signed-out         This device holds no sign-in, so it cannot ask Nexus what it holds. A new device can still ask another to approve it.
//   no-vault           Nexus holds no vault yet: the person can make one (first run).
//   has-vault          Nexus holds a vault. The person can type the Recovery Key, or ask another device. `message` is why the last try
//                      was refused, or null.
//   show-key           First run: the Recovery Key is shown (`recoveryKey`) and the person types back its last group. `triesLeft`
//                      and the last refusal (`message`) are shown with it.
//   save-failed        The check characters were right but Nexus did not take the Recovery wrap (it could not be reached, or was in
//                      trouble). Nothing is unlocked; the same wrap can be sent again.
//   waiting-for-device A new device has asked another to approve it, and shows the link, the sign-in code and the key code to be
//                      typed on that device.
//   type-matching-code The approval came. The person types, here, the matching code the approving device shows. `triesLeft`.
//   approve-device     This device is unlocked and ready to approve another: the sign-in code and the key code the new device shows are typed.
//   device-approved    The other device was approved. `code` is the matching code to show here and type on the new device.
//   approve-agent      This device is unlocked and ready to approve an agent: the agent's public key is pasted.
//   agent-approved     The vault key is sealed to the agent's key. `approval` is for the person to save beside the agent's private key
//                      (the same text `nexus-agent approve-agent` prints); Nexus never sees it.
//
// THE EVENTS (what the person does; each is a method). An event that does not fit the state it arrives in is ignored.
//   begin()                       From locked, stopped, signed-out, no-vault or has-vault: ask Nexus what it holds, and go to signed-out,
//                                 no-vault, has-vault or stopped.
//   startFirstRun()               From no-vault: check that only the owner can send the wrap, make the vault key, the vault id and the
//                                 Recovery Key, and show the key (show-key). Nothing is sent yet.
//   typeBack(text)                From show-key: the last four characters of the Recovery Key. Right: send the Recovery wrap with the
//                                 vault id, and unlock. Wrong: another try, and after three, stopped with nothing sent.
//   tryAgain()                    From save-failed: send the same Recovery wrap again.
//   typeRecoveryKey(text)         From has-vault: open the Recovery wrap with the key typed. Right: unlocked. Wrong: has-vault with a
//                                 message, and nothing is kept.
//   askAnotherDevice()            From signed-out or has-vault: ask Nexus to sign this device in, and another device to send the vault key.
//   typeMatchingCode(text)        From type-matching-code: the code the approving device shows. Right: signed in and unlocked. Wrong: another
//                                 try, and after three the approval is thrown away (stopped).
//   refuseCode()                  From type-matching-code: the person says the codes do not match. The approval is thrown away (stopped).
//   startApprovingDevice()        From unlocked: ready to approve another device (approve-device).
//   approveDevice(code, keyCode)  From approve-device: the sign-in code and the key code read off the new device. Right: device-approved.
//                                 A key code that is not the key Nexus gave this device is refused with nothing sent, and the person tries again.
//   startApprovingAgent()         From unlocked: ready to approve an agent (approve-agent).
//   approveAgent(publicKey)       From approve-agent: the agent's public key as pasted. Right: agent-approved. Not a public key: refused.
//   done()                        From approve-device, device-approved, approve-agent or agent-approved: back to unlocked.
//   cancel()                      From any step that is going on: leave it, throw away whatever it made, and go back to locked or unlocked.
//   lock()                        Drop the key (the key holder overwrites it), cancel what is going on, and go to locked.
//   unload()                      The plugin is unloading: the same as lock, and nothing is kept.
//
// Nothing is sent that could carry a key before the person has done what the step asks: the Recovery wrap goes only after the check
// characters are typed back, a device is sent the vault key only after the key code it was asked for matches, and a new device uses
// nothing of what it was handed until the matching code is typed.

import { isSetUp, NOT_SET_UP } from "./state";
import {
  TYPE_BACK_TRIES, TYPE_BACK_WRONG, approvalForAgent, forgetNewVault, holdsAVault, isTypedBack, makeNewVault, newestRecoveryWrap,
  openRecoveryWrap, publicKeyCode, readAgentPublicKey, recoveryWrapRequest,
  type NewVault, type RecoveryWrapRequest,
} from "@nexus/agent/setup";
import { ApprovalError, UNREACHABLE, approveDevice as approveWithKeyCode, signInForKey, type PendingApproval } from "./approval";
import type { KeyHolder } from "./key-holder";
import type { Http, PluginData } from "./types";

/** How many times the matching code may be typed before the approval is thrown away. The same as for the check characters. */
export const MATCHING_CODE_TRIES = TYPE_BACK_TRIES;

/** What a `working` step is doing. */
export type Doing = "looking" | "starting-sign-in" | "saving" | "opening" | "approving";

/** Why a setup stopped. */
export type StoppedBecause =
  | "not-set-up" | "unreachable" | "refused" | "not-owner" | "other-vault" | "type-back-failed"
  | "denied" | "expired" | "changed" | "bad-approval" | "codes-differ" | "sign-in-failed";

export type SetupState =
  | { step: "locked" }
  | { step: "unlocked" }
  | { step: "working"; doing: Doing }
  | { step: "stopped"; reason: StoppedBecause; message: string }
  | { step: "signed-out" }
  | { step: "no-vault" }
  | { step: "has-vault"; message: string | null }
  | { step: "show-key"; recoveryKey: string; triesLeft: number; message: string | null }
  | { step: "save-failed"; message: string }
  | { step: "waiting-for-device"; link: string; code: string; keyCode: string }
  | { step: "type-matching-code"; triesLeft: number; message: string | null }
  | { step: "approve-device"; message: string | null }
  | { step: "device-approved"; code: string; label: string }
  | { step: "approve-agent"; message: string | null }
  | { step: "agent-approved"; approval: string; publicKeyCode: string };

export interface SetupDeps {
  http: Http;
  /** The live data: the address, the user and the token. A sign-in that is handed a token puts it here and persists it. */
  data: PluginData;
  persist: (data: PluginData) => Promise<void>;
  /** The name this device signs in with, asked when a sign-in starts. */
  device: () => string;
  /** Where the vault key is put and taken away. */
  keys: KeyHolder;
  /** Opens a link in a browser. */
  open: (link: string) => void;
  /** Pauses between polls. */
  wait: (ms: number) => Promise<void>;
}

/** The plain sentences a state carries. A screen replaces them with its own words. */
export const SETUP_WORDS = {
  keyNeverShownAgain: "Nexus cannot show the Recovery Key again or reset it. Write it down before going on.",
  typeBackFailed: "The check characters were not typed back, so the vault was not set up and nothing was sent. Start again for a new key.",
  signedOut: "This device is signed out of Nexus. Sign in first, or ask another device that is unlocked to approve this one.",
  notOwner: "This sign-in is not the owner's, and only the owner may set up the vault. Sign in as the owner.",
  otherVault: "This server already holds a vault with another vault id, so this one was not kept.",
  wouldNotSay: "Nexus would not say what it holds.",
  wouldNotKeepWrap: "Nexus would not keep the Recovery wrap, so the vault was not set up.",
  holdsOne: "This server already holds a vault, so nothing was made.",
  noVaultId: "This server holds no vault yet. Set the vault up first.",
  noRecoveryWrap: "This server holds no Recovery wrap, so the Recovery Key cannot open anything here. Ask another device that is unlocked to approve this one.",
  badWrap: "The Recovery wrap Nexus holds is not base64, so it cannot be opened.",
  noRecoveryKey: "No Recovery Key was typed. Nothing was kept.",
  incompleteRecoveryKey: "That is not a whole Recovery Key: a character is missing or mistyped. Nothing was kept.",
  wrongRecoveryKey: "That Recovery Key does not open this vault, so it is not this vault's Recovery Key. Nothing was kept.",
  notAPublicKey: "That is not an agent's public key: it is 32 bytes written as base64, the PUBLIC KEY line of `nexus-agent keygen`. Nothing was made.",
  wrongMatchingCode: "That is not the code the other device shows. Check it and type it again. Nothing was kept.",
  codesDiffer: "The matching codes did not agree, so the approval was thrown away and nothing was kept. Start again on the other device, and if it happens again, do not trust this server.",
  refusedByPerson: "You said the codes do not match, so the approval was thrown away and nothing was kept.",
  denied: "Nexus sign-in was denied.",
  expired: "The Nexus sign-in ran out. Try again.",
  changed: "The address or user name changed, so that sign-in was dropped. Sign in again.",
  badApproval: "Nexus handed over an approval that did not open for this device, so nothing was kept. Start again, and if it happens again, do not trust this server.",
  signInFailed: "The sign-in did not work.",
} as const;

/** Thrown out of a wait when the person cancelled, so the sign-in's polling stops. */
class Cancelled extends Error {}

/** One thing the controller is doing for the person. Cancelling it makes everything it does from then on a no-op. */
interface Flow {
  cancelled: boolean;
}

/** What `GET /wraps` and the other calls answered. */
interface Reply {
  status: number;
  json: any;
}

export class VaultSetup {
  readonly #deps: SetupDeps;
  /** The state while something is going on, or null while idle (then it is locked or unlocked, as the key holder says). */
  #current: SetupState | null = null;
  #flow: Flow = { cancelled: false };
  #listeners = new Set<() => void>();
  /** First run: the vault being made. Held here, in memory, from the moment the key is shown until it is sent, or thrown away. */
  #fresh: NewVault | null = null;
  #pendingWrap: RecoveryWrapRequest | null = null;
  /** A new device's approval that is waiting for the matching code. */
  #pending: PendingApproval | null = null;
  #unloaded = false;

  constructor(deps: SetupDeps) {
    this.#deps = deps;
  }

  /** What is on the screen now. */
  get state(): SetupState {
    return this.#current ?? { step: this.#deps.keys.isUnlocked ? "unlocked" : "locked" };
  }

  /** Calls `listener` each time the state changed. Answers the function that stops it. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  // ── the events ─────────────────────────────────────────────────────────────

  /** Asks Nexus what it holds. */
  async begin(): Promise<void> {
    if (!this.#is("locked", "stopped", "signed-out", "no-vault", "has-vault")) return;
    const flow = this.#start();
    await this.#lookAtServer(flow);
  }

  /** First run: the vault key, the vault id and the Recovery Key are made, and the key is shown. Nothing is sent. */
  async startFirstRun(): Promise<void> {
    if (!this.#is("no-vault")) return;
    const flow = this.#start();
    this.#set({ step: "working", doing: "looking" });
    const began = this.#began();
    // Everything that can be refused is asked before the key is shown, so the person never writes down a key for nothing.
    const held = await this.#ask(flow, "GET", "wraps");
    if (held === null) return;
    if (held.status !== 200) return this.#stop(flow, "refused", refusalText(held, SETUP_WORDS.wouldNotSay));
    if (holdsAVault(held.json)) return this.#set({ step: "has-vault", message: SETUP_WORDS.holdsOne });
    const owner = await this.#ask(flow, "GET", "tokens");
    if (owner === null) return;
    if (owner.status === 403) return this.#stop(flow, "not-owner", SETUP_WORDS.notOwner);
    if (owner.status !== 200) return this.#stop(flow, "refused", refusalText(owner, SETUP_WORDS.wouldNotSay));
    if (!this.#sameServer(began)) return this.#stop(flow, "changed", SETUP_WORDS.changed);

    const vault = await makeNewVault();
    if (flow.cancelled) return forgetNewVault(vault);
    this.#fresh = vault;
    this.#set({ step: "show-key", recoveryKey: vault.recoveryKeyText, triesLeft: TYPE_BACK_TRIES, message: SETUP_WORDS.keyNeverShownAgain });
  }

  /** First run: the person types back the last group of the Recovery Key. */
  async typeBack(text: string): Promise<void> {
    const shown = this.#current;
    if (shown?.step !== "show-key" || this.#fresh === null) return;
    const vault = this.#fresh;
    if (!isTypedBack(text, vault.checkGroup)) {
      const triesLeft = shown.triesLeft - 1;
      if (triesLeft > 0) return this.#set({ step: "show-key", recoveryKey: shown.recoveryKey, triesLeft, message: TYPE_BACK_WRONG });
      this.#forgetFresh();
      return this.#stop(this.#start(), "type-back-failed", SETUP_WORDS.typeBackFailed);
    }
    const flow = this.#start();
    this.#set({ step: "working", doing: "saving" });
    this.#pendingWrap = await recoveryWrapRequest(vault);
    if (flow.cancelled) return;
    await this.#sendWrap(flow);
  }

  /** First run: the same Recovery wrap is sent again, after Nexus could not be reached or was in trouble. */
  async tryAgain(): Promise<void> {
    if (!this.#is("save-failed") || this.#fresh === null || this.#pendingWrap === null) return;
    const flow = this.#start();
    this.#set({ step: "working", doing: "saving" });
    await this.#sendWrap(flow);
  }

  /** A vault exists: the person types the Recovery Key. */
  async typeRecoveryKey(text: string): Promise<void> {
    if (!this.#is("has-vault")) return;
    const flow = this.#start();
    this.#set({ step: "working", doing: "opening" });
    const began = this.#began();
    const held = await this.#ask(flow, "GET", "wraps", undefined, (message) => this.#set({ step: "has-vault", message }));
    if (held === null) return;
    if (!this.#sameServer(began)) return this.#stop(flow, "changed", SETUP_WORDS.changed);
    if (held.status !== 200) return this.#set({ step: "has-vault", message: refusalText(held, SETUP_WORDS.wouldNotSay) });
    const found = newestRecoveryWrap(held.json);
    if (!found.ok) return this.#set({ step: "has-vault", message: found.reason === "no-vault-id" ? SETUP_WORDS.noVaultId : found.reason === "bad-wrap" ? SETUP_WORDS.badWrap : SETUP_WORDS.noRecoveryWrap });
    const opened = await openRecoveryWrap(found.held, text);
    if (flow.cancelled) {
      if (opened.ok) opened.keys.vaultKey.fill(0);
      return;
    }
    if (!opened.ok) {
      const message = opened.reason === "empty" ? SETUP_WORDS.noRecoveryKey : opened.reason === "incomplete" ? SETUP_WORDS.incompleteRecoveryKey : SETUP_WORDS.wrongRecoveryKey;
      return this.#set({ step: "has-vault", message });
    }
    this.#unlockWith(opened.keys);
  }

  /** The sign-in's two-code exchange: this device asks another, which is unlocked, to send it the vault key. */
  async askAnotherDevice(): Promise<void> {
    if (!this.#is("signed-out", "has-vault")) return;
    if (!isSetUp(this.#deps.data)) return this.#stop(this.#start(), "not-set-up", NOT_SET_UP);
    const flow = this.#start();
    this.#set({ step: "working", doing: "starting-sign-in" });
    let result: Awaited<ReturnType<typeof signInForKey>>;
    try {
      result = await signInForKey({
        http: this.#deps.http,
        data: this.#deps.data,
        persist: this.#deps.persist,
        device: this.#deps.device(),
        unlock: this.#deps.keys,
        show: (link, code, keyCode) => {
          if (!flow.cancelled) this.#set({ step: "waiting-for-device", link, code, keyCode: keyCode ?? "" });
        },
        open: (link) => {
          if (!flow.cancelled) this.#deps.open(link);
        },
        wait: async (ms) => {
          if (flow.cancelled) throw new Cancelled();
          await this.#deps.wait(ms);
          if (flow.cancelled) throw new Cancelled();
        },
      });
    } catch (error) {
      if (error instanceof Cancelled || flow.cancelled) return;
      return this.#stop(flow, "sign-in-failed", error instanceof Error && error.message !== "" ? error.message : SETUP_WORDS.signInFailed);
    }
    if (flow.cancelled) {
      if (result.result === "check-code") result.approval.refuse();
      return;
    }
    switch (result.result) {
      case "check-code":
        this.#pending = result.approval;
        return this.#set({ step: "type-matching-code", triesLeft: MATCHING_CODE_TRIES, message: null });
      case "signed-in":
        // Allowed, with no key left for this device: it is signed in and still locked. The Recovery Key is the way in.
        return this.#lookAtServer(flow);
      case "denied":
        return this.#stop(flow, "denied", SETUP_WORDS.denied);
      case "expired":
        return this.#stop(flow, "expired", SETUP_WORDS.expired);
      case "changed":
        return this.#stop(flow, "changed", SETUP_WORDS.changed);
      case "bad-approval":
        return this.#stop(flow, "bad-approval", SETUP_WORDS.badApproval);
    }
  }

  /** The person types, on the new device, the matching code the approving device shows. */
  async typeMatchingCode(text: string): Promise<void> {
    const shown = this.#current;
    if (shown?.step !== "type-matching-code" || this.#pending === null) return;
    const pending = this.#pending;
    const flow = this.#flow;
    this.#set({ step: "working", doing: "opening" });
    const answer = await pending.confirm(text);
    if (flow.cancelled) return;
    if (answer === "unlocked") {
      this.#pending = null;
      return this.#idle();
    }
    if (answer === "changed") {
      this.#pending = null;
      return this.#stop(flow, "changed", SETUP_WORDS.changed);
    }
    if (answer === "closed") {
      this.#pending = null;
      return this.#stop(flow, "bad-approval", SETUP_WORDS.badApproval);
    }
    const triesLeft = shown.triesLeft - 1;
    if (triesLeft > 0) return this.#set({ step: "type-matching-code", triesLeft, message: SETUP_WORDS.wrongMatchingCode });
    this.#dropPending();
    this.#stop(flow, "codes-differ", SETUP_WORDS.codesDiffer);
  }

  /** The person says the matching codes do not match. */
  refuseCode(): void {
    if (this.#current?.step !== "type-matching-code") return;
    const flow = this.#flow;
    this.#dropPending();
    this.#stop(flow, "codes-differ", SETUP_WORDS.refusedByPerson);
  }

  startApprovingDevice(): void {
    if (!this.#is("unlocked")) return;
    this.#set({ step: "approve-device", message: null });
  }

  /** This device is unlocked and approves a new device: the sign-in code and the key code the new device shows, typed here. */
  async approveDevice(signInCode: string, typedKeyCode: string): Promise<void> {
    if (!this.#is("approve-device")) return;
    const flow = this.#start();
    this.#set({ step: "working", doing: "approving" });
    try {
      const approved = await approveWithKeyCode({ http: this.#deps.http, data: this.#deps.data, unlock: this.#deps.keys }, signInCode.trim(), typedKeyCode);
      if (flow.cancelled) return;
      this.#set({ step: "device-approved", code: approved.code, label: approved.label });
    } catch (error) {
      if (flow.cancelled) return;
      if (!(error instanceof ApprovalError)) throw error;
      // Nothing that could carry the key was sent. A locked device has no key to give, so there is nothing to try again.
      if (error.reason === "locked") return this.#idle();
      this.#set({ step: "approve-device", message: error.message });
    }
  }

  startApprovingAgent(): void {
    if (!this.#is("unlocked")) return;
    this.#set({ step: "approve-agent", message: null });
  }

  /** This device is unlocked and approves an agent: its public key, pasted. The approval is shown, never sent. */
  async approveAgent(typedPublicKey: string): Promise<void> {
    if (!this.#is("approve-agent")) return;
    const keys = this.#deps.keys.keys();
    if (keys === null) return this.#idle();
    const publicKey = readAgentPublicKey(typedPublicKey);
    if (publicKey === null) return this.#set({ step: "approve-agent", message: SETUP_WORDS.notAPublicKey });
    const flow = this.#start();
    const approval = await approvalForAgent(publicKey, keys);
    const code = await publicKeyCode(publicKey);
    if (flow.cancelled) return;
    this.#set({ step: "agent-approved", approval, publicKeyCode: code });
  }

  /** Back to unlocked, from the end of an approval or from its form. */
  done(): void {
    if (!this.#is("approve-device", "device-approved", "approve-agent", "agent-approved")) return;
    this.#idle();
  }

  /** Leaves the step that is going on, throwing away what it made. */
  cancel(): void {
    if (this.#current === null) return;
    this.#stopFlow();
    this.#idle();
  }

  /** Drops the key and everything that was going on. */
  lock(): void {
    this.#stopFlow();
    this.#deps.keys.lock();
    this.#idle();
  }

  /** The plugin is unloading: as `lock`, and nothing it was doing goes on. */
  unload(): void {
    this.#unloaded = true;
    this.lock();
    this.#listeners.clear();
  }

  // ── the steps ──────────────────────────────────────────────────────────────

  /** Asks Nexus what it holds and lands on signed-out, no-vault, has-vault or stopped. */
  async #lookAtServer(flow: Flow): Promise<void> {
    const data = this.#deps.data;
    if (!isSetUp(data)) return this.#stop(flow, "not-set-up", NOT_SET_UP);
    if (data.token === null || data.token === "") return this.#set({ step: "signed-out" });
    this.#set({ step: "working", doing: "looking" });
    const began = this.#began();
    const held = await this.#ask(flow, "GET", "wraps");
    if (held === null) return;
    if (!this.#sameServer(began)) return this.#stop(flow, "changed", SETUP_WORDS.changed);
    if (held.status === 401) {
      // Nexus no longer knows this token: forgotten, as the engine does, so the person signs in again.
      data.token = null;
      await this.#deps.persist(data);
      if (flow.cancelled) return;
      return this.#set({ step: "signed-out" });
    }
    if (held.status !== 200) return this.#stop(flow, "refused", refusalText(held, SETUP_WORDS.wouldNotSay));
    this.#set(holdsAVault(held.json) ? { step: "has-vault", message: null } : { step: "no-vault" });
  }

  /** Sends the Recovery wrap that was made, and unlocks with the vault key once Nexus has kept it. */
  async #sendWrap(flow: Flow): Promise<void> {
    const vault = this.#fresh;
    const request = this.#pendingWrap;
    if (vault === null || request === null) return;
    const began = this.#began();
    const sent = await this.#ask(flow, "POST", "wrap", request, (message) => this.#set({ step: "save-failed", message }));
    if (sent === null) return;
    if (!this.#sameServer(began)) {
      this.#forgetFresh();
      return this.#stop(flow, "changed", SETUP_WORDS.changed);
    }
    if (sent.status >= 500 || sent.status === 429) return this.#set({ step: "save-failed", message: SETUP_WORDS.wouldNotKeepWrap });
    if (sent.status === 409) {
      this.#forgetFresh();
      return this.#stop(flow, "other-vault", SETUP_WORDS.otherVault);
    }
    if (sent.status !== 200) {
      this.#forgetFresh();
      return this.#stop(flow, sent.status === 403 ? "not-owner" : "refused", sent.status === 403 ? SETUP_WORDS.notOwner : refusalText(sent, SETUP_WORDS.wouldNotKeepWrap));
    }
    // Nexus has the wrap and the vault id. The vault key goes to the holder, which overwrites it when the vault is locked.
    const keys = { vaultKey: vault.vaultKey, vaultId: vault.vaultId, kid: vault.kid };
    vault.recoveryKey.fill(0);
    this.#fresh = null;
    this.#pendingWrap = null;
    this.#unlockWith(keys);
  }

  /** Puts the keys in the holder and goes to unlocked. */
  #unlockWith(keys: { vaultKey: Uint8Array; vaultId: string; kid: number }): void {
    this.#current = null;
    this.#deps.keys.unlock(keys);
    this.#changed();
  }

  // ── the plumbing ───────────────────────────────────────────────────────────

  #is(...steps: Array<SetupState["step"]>): boolean {
    return steps.includes(this.state.step);
  }

  /** A new piece of work: whatever was going on is over. */
  #start(): Flow {
    this.#flow.cancelled = true;
    this.#flow = { cancelled: false };
    return this.#flow;
  }

  /** Everything that was going on is over, and what it made is thrown away. */
  #stopFlow(): void {
    this.#flow.cancelled = true;
    this.#forgetFresh();
    this.#dropPending();
  }

  #forgetFresh(): void {
    if (this.#fresh !== null) forgetNewVault(this.#fresh);
    this.#fresh = null;
    this.#pendingWrap = null;
  }

  #dropPending(): void {
    this.#pending?.refuse();
    this.#pending = null;
  }

  /** Back to locked or unlocked, as the key holder says. */
  #idle(): void {
    this.#current = null;
    this.#changed();
  }

  #set(state: SetupState): void {
    this.#current = state;
    this.#changed();
  }

  /** It cannot go on. Whatever was made is thrown away, and the person is told why. */
  #stop(flow: Flow, reason: StoppedBecause, message: string): void {
    if (flow.cancelled) return;
    this.#forgetFresh();
    this.#set({ step: "stopped", reason, message });
  }

  #changed(): void {
    if (this.#unloaded) return;
    for (const listener of [...this.#listeners]) listener();
  }

  /** The address and the user a piece of work began against. */
  #began(): { address: string; user: string } {
    return { address: this.#deps.data.address, user: this.#deps.data.user };
  }

  #sameServer(began: { address: string; user: string }): boolean {
    return this.#deps.data.address === began.address && this.#deps.data.user === began.user;
  }

  /**
   * One call to Nexus with this device's token. Null means nothing more is to be done with the answer: the person cancelled, or Nexus
   * could not be reached and the state already says so (`onUnreachable` says so for the steps that can be tried again, else it is stopped).
   */
  async #ask(flow: Flow, method: "GET" | "POST", route: string, body?: object, onUnreachable?: (message: string) => void): Promise<Reply | null> {
    const { data, http } = this.#deps;
    let response;
    try {
      response = await http({
        url: `${data.address.replace(/\/+$/, "")}/${route}`,
        method,
        headers: { authorization: `Bearer ${data.token}` },
        ...(body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(body) }),
        throw: false,
      });
    } catch {
      if (flow.cancelled) return null;
      if (onUnreachable) onUnreachable(UNREACHABLE);
      else this.#stop(flow, "unreachable", UNREACHABLE);
      return null;
    }
    if (flow.cancelled) return null;
    let json: any = {};
    try {
      json = response.json ?? {};
    } catch {
      json = {};
    }
    return { status: response.status, json };
  }
}

/** Nexus's own words for a refusal when it gave some, else `fallback`. */
function refusalText(reply: Reply, fallback: string): string {
  return typeof reply.json?.error === "string" && reply.json.error !== "" ? `${fallback} ${reply.json.error}` : fallback;
}
