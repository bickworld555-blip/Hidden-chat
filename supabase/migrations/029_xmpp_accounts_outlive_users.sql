-- XMPP core (server/xmpp.mjs): a device's row must outlive its user until ejabberd has removed the account. With
-- ON DELETE CASCADE, deleting a user dropped the rows before the cleanup could read them, orphaning ejabberd accounts
-- (seen in production on 2026-11-15). Run once, in order, after 028.
SET LOCAL search_path TO relay;

ALTER TABLE xmpp_accounts DROP CONSTRAINT IF EXISTS xmpp_accounts_user_id_fkey;

UPDATE schema_version SET version = 29 WHERE singleton = 1;
