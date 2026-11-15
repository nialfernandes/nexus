-- Migration 0004: a new device sends its public key with its sign-in, and the device that approves it can leave the vault
-- key for it, sealed to that public key.
--
--   nexus_signins.device_key   the new device's X25519 public key as base64, or null for a sign-in that sent none (an agent's
--                              command that carries its own key arrangement, a script). Only a sign-in with a key can be
--                              sent a sealed approval.
--   nexus_approvals            the sealed approval an approving device left for a sign-in: the vault key sealed to the new
--                              device's public key (docs/FORMAT.md section 7.3), the approving device's own public key for
--                              this approval (section 7.4), and when it expires, which is when the sign-in does. The server
--                              cannot open the approval. The row is deleted the moment the new device collects it, and any
--                              that has run out is deleted by the next start or approval. A person's own keys never rest here.
--
-- The SQL is the common ground of SQLite and Postgres. The statements are split at the semicolon when the tests
-- build the tables, so this file holds no semicolon inside a comment, a literal or a trigger.

ALTER TABLE nexus_signins ADD COLUMN device_key TEXT;

CREATE TABLE nexus_approvals (
  code TEXT PRIMARY KEY REFERENCES nexus_signins (code),
  approver_key TEXT NOT NULL,
  approval TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
