-- Migration 0005: the vault id, kept beside the wraps.
--
-- A wrap (docs/FORMAT.md section 7) opens only with the vault id it was made with: the id is part of what the wrap is bound to.
-- Until now the server held no vault id, so a device or an agent that had only the Recovery Key could not open the Recovery wrap.
-- The id is not secret (it is in every note's associated data and in every approval). The server keeps it once, the first time
-- a wrap is kept, and hands it out with the wraps.
--
--   nexus_vault   one row, id 1: the vault id the wraps were made with. It is written once and never changed, and it stays
--                 when every wrap is removed, because it names the vault the notes belong to and not the wraps.
--
-- Wraps kept before this migration have no vault id beside them. The owner keeps each of them again (POST /wrap with the vault id)
-- and the first one sets it.
--
-- The SQL is the common ground of SQLite and Postgres. The statements are split at the semicolon when the tests
-- build the tables, so this file holds no semicolon inside a comment, a literal or a trigger.

CREATE TABLE nexus_vault (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  vault_id TEXT NOT NULL,
  writer TEXT NOT NULL,
  saved_at INTEGER NOT NULL
);
