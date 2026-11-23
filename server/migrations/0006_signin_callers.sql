-- Migration 0006: a sign-in remembers which caller started it, so one caller cannot fill the waiting list.
--
--   nexus_signins.caller   a hash of the address the sign-in was started from (never the address itself), or null when the host
--                          gave no address for the request. At most a few sign-ins from one caller may wait at once. Sign-ins
--                          started before this migration, and ones started where the host gives no address, have none and
--                          count toward no caller's few.
--
-- The SQL is the common ground of SQLite and Postgres. The statements are split at the semicolon when the tests
-- build the tables, so this file holds no semicolon inside a comment, a literal or a trigger.

ALTER TABLE nexus_signins ADD COLUMN caller TEXT;
