-- Migration 0003: the server holds encrypted blobs and never reads a note.
--
-- Until now the tables held each note's path and its whole text. From here a device encrypts a note before it sends it
-- (docs/FORMAT.md), and the server keeps only what it is sent, as it is:
--
--   nexus_notes     a note is an id the device chose (random, or made from a key the device keeps; never the path) and the number of its latest version.
--   nexus_versions  a version is written once: the note's id, its number, `seq` (the changes feed's cursor), the kind
--                   (save or delete), `kid` (the number of the vault key the blob is under), the encrypted blob as base64
--                   text, SHA-256 of the blob, the writer and the time. A delete version keeps the blob it followed.
--   nexus_wraps     the vault key's wraps, locked under the Recovery Key or a password: opaque base64 with their `kid`.
--
-- No path, name, folder or text is kept anywhere. Folder rights go too, because the folders are inside the encrypted notes:
-- nexus_rights is dropped, and an identity can use every note or none.
--
-- THIS DROPS THE PLAIN TEXT TABLES. The server cannot encrypt, so it cannot turn the notes it holds into blobs, and a
-- copy of the old tables would leave every note readable by whoever runs the server. A vault that was kept in plain text
-- is not converted here: the first device that connects after the setup uploads every note again, encrypted. The old
-- versions of each note are not kept. Export them first if you want them (server/README.md).
--
-- The SQL is the common ground of SQLite and Postgres. The statements are split at the semicolon when the tests
-- build the tables, so this file holds no semicolon inside a comment, a literal or a trigger.

DROP TABLE nexus_versions;

DROP TABLE nexus_notes;

DROP TABLE nexus_rights;

CREATE TABLE nexus_notes (
  id TEXT PRIMARY KEY,
  deleted INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE nexus_versions (
  note_id TEXT NOT NULL REFERENCES nexus_notes (id),
  version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  kid INTEGER NOT NULL,
  blob TEXT NOT NULL,
  hash TEXT NOT NULL,
  writer TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, version)
);

-- seq numbers every version of every note in the order they were made: the changes feed's cursor.
CREATE UNIQUE INDEX nexus_versions_seq ON nexus_versions (seq);

CREATE TABLE nexus_wraps (
  kid INTEGER NOT NULL,
  kind TEXT NOT NULL,
  wrap TEXT NOT NULL,
  writer TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (kid, kind)
);
