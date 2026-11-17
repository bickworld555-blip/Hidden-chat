-- Message requests (src/messageRequests.js): 0 while the owner has not accepted a chat the other person started; the
-- sender then hears no "delivered" or "read". Links from before this migration count as accepted. Additive.
SET LOCAL search_path TO relay;

ALTER TABLE contacts ADD COLUMN accepted INTEGER NOT NULL DEFAULT 1;

UPDATE schema_version SET version = 39 WHERE singleton = 1;
