-- Migration 0007: a sign-in remembers the order it was started in, so the owner's waiting list can keep it.
--
--   nexus_signins.seq   a number one higher than every sign-in the table held when this one was started, so of two sign-ins started in
--                       the same millisecond (the same created_at) the one started first has the lower number. The list of waiting
--                       sign-ins is oldest first by created_at and then by this, never by the code, which is drawn at random.
--                       Sign-ins started before this migration have 0, so they keep the order of their time and then of their code.
--
-- The SQL is the common ground of SQLite and Postgres. The statements are split at the semicolon when the tests
-- build the tables, so this file holds no semicolon inside a comment, a literal or a trigger.

ALTER TABLE nexus_signins ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
