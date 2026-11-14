-- Migration 0001: Nexus's schema.
--
-- Nexus keeps the notes of a linked vault, and every version of every note, in a database of its own (on
-- Cloudflare the binding NEXUS_DB), so the credentials that are handed to agents and apps cannot reach any other
-- database. See wrangler.jsonc.
--
-- A note is a row in nexus_notes: a stable id and the path it has now. A version is a row in nexus_versions and
-- is never changed or removed: the whole text, who saved it, when, a short hash, and the path the note had at
-- that version. A move keeps the note's id, so its history comes with it.
--
-- This is the plain text schema as it was first made. Migration 0003 later dropped nexus_notes and nexus_versions and made
-- them again to hold encrypted blobs, with no path and no text: read it for the schema as it is now.
--
-- The SQL is the common ground of SQLite and Postgres. The statements are split at the semicolon when the tests
-- build the tables, so this file holds no semicolon inside a comment, a literal or a trigger.

CREATE TABLE nexus_notes (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  head_version INTEGER NOT NULL,
  head_at INTEGER NOT NULL,
  last_version INTEGER NOT NULL,
  clash INTEGER NOT NULL DEFAULT 0
);

-- Two live notes never share a path. A deleted note keeps its path and its history.
CREATE UNIQUE INDEX nexus_notes_live_path ON nexus_notes (path) WHERE deleted = 0;
CREATE INDEX nexus_notes_path ON nexus_notes (path);

CREATE TABLE nexus_versions (
  note_id INTEGER NOT NULL REFERENCES nexus_notes (id),
  version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  from_path TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  writer TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  hash TEXT NOT NULL,
  merged INTEGER NOT NULL DEFAULT 0,
  clash INTEGER NOT NULL DEFAULT 0,
  resolves INTEGER,
  PRIMARY KEY (note_id, version)
);

-- seq numbers every version of every note in the order they were made: the changes feed's cursor.
CREATE UNIQUE INDEX nexus_versions_seq ON nexus_versions (seq);
