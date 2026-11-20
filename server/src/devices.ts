// Device approval: how an agent's command or a plugin gets a token without a secret ever being pasted anywhere.
//
//   1. The device asks to start a sign-in for an identity and a label (`start`, no credential needed). It is handed a
//      short CODE (safe to show on a screen), a LINK to the approval page, and a long SECRET that only it knows.
//   2. The owner opens the link on a phone or a computer, signed in (or types the owner secret on the page, which is how a
//      first device is set up), sees what is being asked, and allows or denies it (`pending`, `approve`, `deny`, all the
//      owner's only). An approving device lists the sign-ins waiting by name with `waiting`.
//   3. The device polls with its secret. After an allow, the first poll is handed a token, once. Every later poll
//      is refused.
//
// A sign-in lasts ten minutes and works once. No token is ever kept as text. The token is worked out from the
// device's secret: TOKEN = "nx_" + SHA-256("nexus device token:" + secret). When the sign-in starts, the server draws
// the secret and keeps only the hash of the secret and the hash of that token. Allowing the sign-in makes the token's
// row from the second hash, in the same batch that marks the sign-in approved. The first poll after that works the
// token out again from the secret it was sent and hands it over, once. Nobody can use the token before the owner
// allows it, because until then there is no row for its hash to match.
//
// Status runs: pending, then approved or denied, then collected.
//
// A KEY FOR THE NEW DEVICE. A device may send its public key (an X25519 key, base64) when it starts. The device that
// allows it, if it holds the vault key, may send with its allow an APPROVAL: the vault key sealed to that public key
// (docs/FORMAT.md section 7.3), and its own public key for this approval. The server keeps both beside the sign-in,
// cannot open the approval, and hands them to the new device in the same first poll that hands it the token: once. The
// approval is deleted as the sign-in is marked collected, and one that is never collected is deleted when its sign-in
// has run out (the next start or approval sweeps it, and a poll of its own sign-in deletes it). A server can still make
// an approval of its own or swap one, which is why the new device does not use the key until a person has compared the
// matching code on both screens (section 7.4): nothing here is trusted for that.

import { deviceKeyCodeInput, deviceKeyCodeOf } from "@nexus/crypto/format";
import { APPROVE_PATH } from "./addresses";
import { base64Length, decodeBase64 } from "./bytes";
import { onlyFields } from "./fields";
import { identityExists, ownerRow } from "./identities";
import type { NexusHost } from "./ports";
import { stmt } from "./ports";
import { Refusal } from "./refusal";

export const SIGNIN_LIFETIME_MS = 10 * 60 * 1000;
/** The longest label a device can ask with: it is shown on a phone screen. */
export const MAX_LABEL = 80;
/** Sign-ins that may wait at once. Starting one needs no credential, so a flood must not be able to fill the table. */
export const MAX_WAITING = 200;
/** An expired sign-in is kept this long, so a device that asks late is told it expired, and then it is swept away. */
const KEEP_EXPIRED_MS = 60 * 60 * 1000;

/** An X25519 public key is this many bytes. */
const PUBLIC_KEY_BYTES = 32;
/** A sealed approval is at most this many bytes: the sealed box's 48, the header and the key, and a vault id of up to 1024. */
export const MAX_APPROVAL_BYTES = 2048;

// Crockford's base 32 without I, L, O and U: nothing to mistake for a digit, and 32 letters means a random byte
// maps onto it with no bias.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A code that is finished is a 410, and the server says which kind in its own words (boards 4 and 5 of the approval page draw them) and
 * in `reason` beside them, so a page or a device can act on it. One that nobody answered in ten minutes ran out; one that was answered
 * (allowed, denied or collected) was already used, even if its time is also up.
 */
export const RAN_OUT = "That code has run out.";
export const ALREADY_USED = "That code was already used.";
const EXPIRED = { reason: "expired" } as const;
const USED = { reason: "used" } as const;
const NO_SUCH_CODE = "There is no sign-in with that code.";

interface SigninRow {
  code: string;
  identity: string;
  label: string;
  expires_at: number;
  status: "pending" | "approved" | "denied" | "collected";
  device_key: string | null;
}

interface ApprovalRow {
  approver_key: string;
  approval: string;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A code such as K7QM-4XNP: eight letters and digits, 40 random bits. */
function newCode(host: NexusHost): string {
  const chars = Array.from(host.secrets.random(8), (b) => CODE_ALPHABET[b & 31]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** A base64 text that holds exactly `bytes` bytes, or a refusal that names `what`. Nothing the caller sent is repeated. */
function exactBytes(value: unknown, bytes: number, what: string): string {
  const decoded = typeof value === "string" ? decodeBase64(value) : null;
  if (decoded === null || decoded.length !== bytes) throw new Refusal(400, `The ${what} has to be ${bytes} bytes, written as standard base64.`);
  return value as string;
}

/** The sealed approval a device sends with its allow: base64, between a sealed box's smallest and the most one can be. */
function approvalBytes(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Refusal(400, "The approval has to be base64 text.");
  if (value.length > base64Length(MAX_APPROVAL_BYTES)) throw new Refusal(413, `That approval is too long to keep (the limit is ${MAX_APPROVAL_BYTES} bytes).`);
  const bytes = decodeBase64(value);
  if (bytes === null) throw new Refusal(400, "The approval has to be standard base64 with its = padding.");
  if (bytes.length > MAX_APPROVAL_BYTES) throw new Refusal(413, `That approval is too long to keep (the limit is ${MAX_APPROVAL_BYTES} bytes).`);
  return value;
}

/** The token a secret stands for. Worked out the same way at start (to keep its hash) and at the poll (to hand it over). */
const tokenOf = async (host: NexusHost, secret: string): Promise<string> =>
  "nx_" + (await host.secrets.hash(`nexus device token:${secret}`));

export async function start(host: NexusHost, origin: string, input: Record<string, unknown>) {
  const label = text(input.label)?.trim() ?? "";
  if (label === "") throw new Refusal(400, "A sign-in needs a label, such as lab-m or Work phone.");
  if ([...label].length > MAX_LABEL) throw new Refusal(400, `The label is too long (the limit is ${MAX_LABEL} characters).`);
  const deviceKey = input.deviceKey === undefined || input.deviceKey === null ? null : exactBytes(input.deviceKey, PUBLIC_KEY_BYTES, "device key");
  const identity = text(input.identity);
  if (identity === undefined || !(await identityExists(host, identity))) {
    throw new Refusal(404, `There is no identity called ${identity ?? "(none given)"}.`);
  }

  const now = host.clock.now();
  const waiting = await host.sql.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM nexus_signins WHERE status = 'pending' AND expires_at > ?", [now]);
  if (waiting && waiting.n >= MAX_WAITING) throw new Refusal(429, "Too many sign-ins are waiting. Try again in a few minutes.");

  const secret = hex(host.secrets.random(32));
  const secretHash = await host.secrets.hash(secret);
  const tokenHash = await host.secrets.hash(await tokenOf(host, secret));
  const expiresAt = now + SIGNIN_LIFETIME_MS;
  for (let attempt = 0; ; attempt++) {
    const code = newCode(host);
    try {
      await host.sql.batch([
        // An approval is deleted before its sign-in is, because it points at it.
        sweepApprovals(now),
        stmt("DELETE FROM nexus_signins WHERE expires_at < ?", now - KEEP_EXPIRED_MS),
        ...ownerRow(host, identity),
        stmt(
          `INSERT INTO nexus_signins (code, secret_hash, token_hash, identity, label, created_at, expires_at, status, device_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          code, secretHash, tokenHash, identity, label, now, expiresAt, deviceKey,
        ),
      ]);
    } catch (error) {
      // Two sign-ins drew the same code: draw again. Anything else is a real fault.
      if (attempt < 4) continue;
      throw error;
    }
    return { code, link: `${host.settings.address ?? origin}${APPROVE_PATH}?code=${encodeURIComponent(code)}`, secret, expiresAt };
  }
}

/** The statement that deletes every approval that has run out. */
const sweepApprovals = (now: number) => stmt("DELETE FROM nexus_approvals WHERE expires_at <= ?", now);

async function signinFor(host: NexusHost, codeInput: unknown): Promise<SigninRow> {
  if (typeof codeInput !== "string" || codeInput === "") throw new Refusal(400, "A code is needed.");
  const row = await host.sql.first<SigninRow>(
    "SELECT code, identity, label, expires_at, status, device_key FROM nexus_signins WHERE code = ?", [codeInput]);
  if (!row) throw new Refusal(404, NO_SUCH_CODE);
  return row;
}

/**
 * A sign-in that is still waiting for the owner: not answered yet, not expired. Anything else is gone, and the refusal says
 * which: one that was answered is used (even if its time is also up), one that nobody answered in time is expired.
 */
function stillWaiting(host: NexusHost, row: SigninRow): void {
  if (row.status !== "pending") throw new Refusal(410, ALREADY_USED, USED);
  if (row.expires_at <= host.clock.now()) throw new Refusal(410, RAN_OUT, EXPIRED);
}

/**
 * The code a new device shows for its own public key (docs/FORMAT.md section 7.4), worked out here from the key it sent, or null for a
 * sign-in that sent no key (it has no such code). The approval page shows it, so the owner can compare it with the new device's screen.
 * The server holds no encryption, so it hashes the key itself with the host's SHA-256 and writes the code with the one function the
 * encryption package writes it with (`deviceKeyCodeOf`): the code is not made twice.
 */
async function deviceCodeOf(host: NexusHost, deviceKey: string | null): Promise<string | null> {
  const key = deviceKey === null ? null : decodeBase64(deviceKey);
  if (key === null) return null;
  const hex = await host.secrets.hashBytes(deviceKeyCodeInput(key));
  // Only the first 50 bits of the digest are used; seven bytes hold them.
  return deviceKeyCodeOf(Uint8Array.from(hex.slice(0, 14).match(/../g)!, (pair) => parseInt(pair, 16)));
}

/**
 * What the approval page shows, and what a device that can approve needs: the public key to seal to (`deviceKey`) and the code the
 * device shows for it (`deviceCode`, the one code the owner compares: such as 4TQ8M-W2K0B), each null when the device sent no key.
 * Nothing in it is secret: both come from the device's public key.
 */
export async function pending(host: NexusHost, codeInput: unknown) {
  const row = await waitingFor(host, codeInput);
  return {
    code: row.code, identity: row.identity, label: row.label, expiresAt: row.expires_at,
    deviceKey: row.device_key, deviceCode: await deviceCodeOf(host, row.device_key),
  };
}

/**
 * The owner's list of sign-ins still waiting (not answered, not run out), oldest first: the label the device sent and the sign-in's
 * code (the one `pending`, `approve` and `deny` take), and nothing else, so nothing secret is in it. The approving device shows the
 * labels, so the person can say which device is meant, and then asks `pending` for the one chosen and checks the code it is typed
 * against that device's key itself; the list is not searched by any code, and carries no key or device code that it would have to be trusted for.
 */
export async function waiting(host: NexusHost) {
  const rows = await host.sql.all<{ code: string; label: string }>(
    "SELECT code, label FROM nexus_signins WHERE status = 'pending' AND expires_at > ? ORDER BY created_at, code", [host.clock.now()]);
  return { signins: rows.map((row) => ({ label: row.label, code: row.code })) };
}

/** The sign-in the owner is answering, or a refusal: no such code, or a code that has expired or been answered already. */
async function waitingFor(host: NexusHost, codeInput: unknown): Promise<SigninRow> {
  const row = await signinFor(host, codeInput);
  stillWaiting(host, row);
  return row;
}

const answered = (result: "approved" | "denied", row: SigninRow) =>
  ({ result, code: row.code, identity: row.identity, label: row.label });

export async function approve(host: NexusHost, input: Record<string, unknown>) {
  onlyFields(input, ["code", "approval", "approverKey"], "An approval");
  const row = await waitingFor(host, input.code);
  // A sealed approval comes with the approving device's public key, or neither comes. It can only go to a device that sent a key to seal to.
  const given = input.approval !== undefined && input.approval !== null;
  if (given !== (input.approverKey !== undefined && input.approverKey !== null)) {
    throw new Refusal(400, "An approval is sent with the approving device's public key, and neither is sent without the other.");
  }
  const approval = given ? approvalBytes(input.approval) : null;
  const approverKey = given ? exactBytes(input.approverKey, PUBLIC_KEY_BYTES, "approver key") : null;
  if (given && row.device_key === null) throw new Refusal(400, "That device did not send a public key, so there is nothing to seal an approval to.");

  const now = host.clock.now();
  // The token's row, the approval and the sealed approval are one batch. The insert only matches a sign-in that is still pending and in
  // date, so when two answers arrive together only one of them makes a token, and the other is told the code is used.
  const [, made] = await host.sql.batch([
    sweepApprovals(now),
    stmt(
      `INSERT INTO nexus_tokens (id, token_hash, identity, label, created_at)
       SELECT ?, token_hash, identity, label, ? FROM nexus_signins WHERE code = ? AND status = 'pending' AND expires_at > ?`,
      hex(host.secrets.random(8)), now, row.code, now,
    ),
    stmt("UPDATE nexus_signins SET status = 'approved' WHERE code = ? AND status = 'pending' AND expires_at > ?", row.code, now),
    ...(approval === null || approverKey === null ? [] : [
      // Kept only for a sign-in that this batch has just allowed: it lasts as long as the sign-in does.
      stmt(
        `INSERT INTO nexus_approvals (code, approver_key, approval, expires_at)
         SELECT code, ?, ?, expires_at FROM nexus_signins WHERE code = ? AND status = 'approved' AND expires_at > ?`,
        approverKey, approval, row.code, now,
      ),
    ]),
  ]);
  if (made.changes !== 1) throw new Refusal(410, ALREADY_USED, USED);
  return answered("approved", row);
}

export async function deny(host: NexusHost, codeInput: unknown) {
  const row = await waitingFor(host, codeInput);
  const done = await host.sql.run(
    "UPDATE nexus_signins SET status = 'denied' WHERE code = ? AND status = 'pending' AND expires_at > ?",
    [row.code, host.clock.now()],
  );
  // Another answer got in between the read and the write: the code is used.
  if (done.changes === 0) throw new Refusal(410, ALREADY_USED, USED);
  return answered("denied", row);
}

/** The device asks whether the owner has answered. Only the device's own secret finds its sign-in, never the code. */
export async function poll(host: NexusHost, secretInput: unknown) {
  if (typeof secretInput !== "string" || secretInput === "") throw new Refusal(400, "A poll needs the secret the device was given.");
  const secretHash = await host.secrets.hash(secretInput);
  const row = await host.sql.first<SigninRow>(
    "SELECT code, identity, label, expires_at, status, device_key FROM nexus_signins WHERE secret_hash = ?", [secretHash]);
  if (!row) throw new Refusal(404, "There is no sign-in for that secret.");

  if (row.status === "collected") throw new Refusal(410, ALREADY_USED, USED);
  if (row.status === "denied") throw new Refusal(403, "The owner denied this sign-in.");
  const now = host.clock.now();
  if (row.expires_at <= now) {
    // Run out: an approval that was left for it and never collected goes now, not at some later start.
    await host.sql.run("DELETE FROM nexus_approvals WHERE code = ?", [row.code]);
    throw new Refusal(410, RAN_OUT, EXPIRED);
  }
  if (row.status === "pending") return { status: "pending" };

  // Approved, and the owner's allow already made the token's row. Hand the token and the approval over, once: the sign-in is marked
  // collected and the approval deleted in one batch, and only the poll whose write finds the sign-in still approved goes on, so two
  // polls at once cannot both get them. The approval is read first, so the poll that wins has it in hand when the row is gone.
  const left = await host.sql.first<ApprovalRow>("SELECT approver_key, approval FROM nexus_approvals WHERE code = ?", [row.code]);
  const [done] = await host.sql.batch([
    stmt("UPDATE nexus_signins SET status = 'collected' WHERE secret_hash = ? AND status = 'approved' AND expires_at > ?", secretHash, now),
    stmt("DELETE FROM nexus_approvals WHERE code = ?", row.code),
  ]);
  if (done.changes !== 1) throw new Refusal(410, ALREADY_USED, USED);
  return {
    status: "approved",
    token: await tokenOf(host, secretInput),
    identity: row.identity,
    label: row.label,
    approval: left?.approval ?? null,
    approverKey: left?.approver_key ?? null,
  };
}
