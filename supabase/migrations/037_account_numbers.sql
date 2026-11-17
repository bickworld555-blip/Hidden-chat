-- Account numbers (src/accountNumber.js): each account's public 10-digit ID, random and unique. The server gives
-- existing accounts theirs at start (server/index.mjs backfillAccountNumbers). Additive.
SET LOCAL search_path TO relay;

ALTER TABLE users ADD COLUMN number TEXT;
CREATE UNIQUE INDEX users_number ON users(number);

UPDATE schema_version SET version = 37 WHERE singleton = 1;
