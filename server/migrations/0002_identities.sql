-- Migration 0002: who may use Nexus, and what each may touch.
--
-- An identity is a name (a person, an agent or an app: lab-m, scribe), a kind (person, agent or app) and a list of
-- folder rights. A right is a folder prefix as the notes' own paths are written, with its closing slash (the empty prefix
-- is the whole vault), and an access: read, write (which includes read) or none. For a note, the right with the
-- longest prefix that the note's path starts with decides, and a note no right reaches is not allowed at all.
-- `slot` keeps the list in the order it was given. The owner (the identity named by the `owner` setting) is held to
-- no list: the code gives it write on everything, always. Its row here is only a name for tokens and sign-ins to
-- point at, and the code makes it the first time a device asks to sign in as the owner.
--
-- A token is a long random string that an agent or a device sends as a bearer. Only its hash is kept (token_hash),
-- never the token. Each token belongs to one identity and carries a label, the time it was made, the time it was
-- last used and, once revoked, the time of that. A revoked token stays as a row and is turned away at once.
--
-- A sign-in is a device asking for a token. The device holds a secret and the owner is shown the short code. Only the
-- hash of the secret is kept (secret_hash), and the hash of the token the secret stands for (token_hash), so
-- allowing the sign-in can make the token's row without the token ever being kept. status runs pending, then
-- approved or denied, then collected once the device has been handed its token. A sign-in lives ten minutes.
--
-- The SQL is the common ground of SQLite and Postgres. The statements are split at the semicolon when the tests
-- build the tables, so this file holds no semicolon inside a comment, a literal or a trigger.

CREATE TABLE nexus_identities (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE nexus_rights (
  identity TEXT NOT NULL REFERENCES nexus_identities (name),
  slot INTEGER NOT NULL,
  path TEXT NOT NULL,
  access TEXT NOT NULL,
  PRIMARY KEY (identity, slot)
);

CREATE UNIQUE INDEX nexus_rights_path ON nexus_rights (identity, path);

CREATE TABLE nexus_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  identity TEXT NOT NULL REFERENCES nexus_identities (name),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE UNIQUE INDEX nexus_tokens_hash ON nexus_tokens (token_hash);

CREATE TABLE nexus_signins (
  code TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  identity TEXT NOT NULL REFERENCES nexus_identities (name),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE UNIQUE INDEX nexus_signins_secret ON nexus_signins (secret_hash);
