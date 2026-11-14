// Device approval: how an agent's command or a plugin gets a token without a secret ever being pasted anywhere.
//
//   1. The device asks to start a sign-in for an identity and a label (`start`, no credential needed). It is handed a
//      short CODE (safe to show on a screen), a LINK to the approval page, and a long SECRET that only it knows.
//   2. The owner opens the link on a phone or a computer, signed in, sees what is being asked, and allows or
//      denies it (`pending`, `approve`, `deny`, all the owner's only).
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

import { APPROVE_PATH } from "./addresses";
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

// Crockford's base 32 without I, L, O and U: nothing to mistake for a digit, and 32 letters means a random byte
// maps onto it with no bias.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const GONE = "That code has expired or has already been used.";
const NO_SUCH_CODE = "There is no sign-in with that code.";

interface SigninRow {
  code: string;
  identity: string;
  label: string;
  expires_at: number;
  status: "pending" | "approved" | "denied" | "collected";
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A code such as K7QM-4XNP: eight letters and digits, 40 random bits. */
function newCode(host: NexusHost): string {
  const chars = Array.from(host.secrets.random(8), (b) => CODE_ALPHABET[b & 31]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The token a secret stands for. Worked out the same way at start (to keep its hash) and at the poll (to hand it over). */
const tokenOf = async (host: NexusHost, secret: string): Promise<string> =>
  "nx_" + (await host.secrets.hash(`nexus device token:${secret}`));

export async function start(host: NexusHost, origin: string, input: Record<string, unknown>) {
  const label = text(input.label)?.trim() ?? "";
  if (label === "") throw new Refusal(400, "A sign-in needs a label, such as lab-m or Work phone.");
  if ([...label].length > MAX_LABEL) throw new Refusal(400, `The label is too long (the limit is ${MAX_LABEL} characters).`);
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
        stmt("DELETE FROM nexus_signins WHERE expires_at < ?", now - KEEP_EXPIRED_MS),
        ...ownerRow(host, identity),
        stmt(
          `INSERT INTO nexus_signins (code, secret_hash, token_hash, identity, label, created_at, expires_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
          code, secretHash, tokenHash, identity, label, now, expiresAt,
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

async function signinFor(host: NexusHost, codeInput: unknown): Promise<SigninRow> {
  if (typeof codeInput !== "string" || codeInput === "") throw new Refusal(400, "A code is needed.");
  const row = await host.sql.first<SigninRow>(
    "SELECT code, identity, label, expires_at, status FROM nexus_signins WHERE code = ?", [codeInput]);
  if (!row) throw new Refusal(404, NO_SUCH_CODE);
  return row;
}

/** A sign-in that is still waiting for the owner: not answered yet, not expired. Anything else is gone. */
function stillWaiting(host: NexusHost, row: SigninRow): void {
  if (row.status !== "pending" || row.expires_at <= host.clock.now()) throw new Refusal(410, GONE);
}

/** What the approval page shows. */
export async function pending(host: NexusHost, codeInput: unknown) {
  const row = await waitingFor(host, codeInput);
  return { code: row.code, identity: row.identity, label: row.label, expiresAt: row.expires_at };
}

/** The sign-in the owner is answering, or a refusal: no such code, or a code that has expired or been answered already. */
async function waitingFor(host: NexusHost, codeInput: unknown): Promise<SigninRow> {
  const row = await signinFor(host, codeInput);
  stillWaiting(host, row);
  return row;
}

const answered = (result: "approved" | "denied", row: SigninRow) =>
  ({ result, code: row.code, identity: row.identity, label: row.label });

export async function approve(host: NexusHost, codeInput: unknown) {
  const row = await waitingFor(host, codeInput);
  const now = host.clock.now();
  // The token's row and the approval are one batch. The insert only matches a sign-in that is still pending and in
  // date, so when two answers arrive together only one of them makes a token, and the other is told the code is used.
  const [made] = await host.sql.batch([
    stmt(
      `INSERT INTO nexus_tokens (id, token_hash, identity, label, created_at)
       SELECT ?, token_hash, identity, label, ? FROM nexus_signins WHERE code = ? AND status = 'pending' AND expires_at > ?`,
      hex(host.secrets.random(8)), now, row.code, now,
    ),
    stmt("UPDATE nexus_signins SET status = 'approved' WHERE code = ? AND status = 'pending' AND expires_at > ?", row.code, now),
  ]);
  if (made.changes !== 1) throw new Refusal(410, GONE);
  return answered("approved", row);
}

export async function deny(host: NexusHost, codeInput: unknown) {
  const row = await waitingFor(host, codeInput);
  const done = await host.sql.run(
    "UPDATE nexus_signins SET status = 'denied' WHERE code = ? AND status = 'pending' AND expires_at > ?",
    [row.code, host.clock.now()],
  );
  // Another answer got in between the read and the write: the code is used.
  if (done.changes === 0) throw new Refusal(410, GONE);
  return answered("denied", row);
}

/** The device asks whether the owner has answered. Only the device's own secret finds its sign-in, never the code. */
export async function poll(host: NexusHost, secretInput: unknown) {
  if (typeof secretInput !== "string" || secretInput === "") throw new Refusal(400, "A poll needs the secret the device was given.");
  const secretHash = await host.secrets.hash(secretInput);
  const row = await host.sql.first<SigninRow>(
    "SELECT code, identity, label, expires_at, status FROM nexus_signins WHERE secret_hash = ?", [secretHash]);
  if (!row) throw new Refusal(404, "There is no sign-in for that secret.");

  if (row.status === "collected") throw new Refusal(410, GONE);
  if (row.status === "denied") throw new Refusal(403, "The owner denied this sign-in.");
  const now = host.clock.now();
  if (row.expires_at <= now) throw new Refusal(410, GONE);
  if (row.status === "pending") return { status: "pending" };

  // Approved, and the owner's allow already made the token's row. Hand the token over, once: the sign-in is marked
  // collected first, and only the poll that finds it still approved goes on, so two polls at once cannot both get it.
  const done = await host.sql.run(
    "UPDATE nexus_signins SET status = 'collected' WHERE secret_hash = ? AND status = 'approved' AND expires_at > ?",
    [secretHash, now],
  );
  if (done.changes !== 1) throw new Refusal(410, GONE);
  return { status: "approved", token: await tokenOf(host, secretInput), identity: row.identity, label: row.label };
}
