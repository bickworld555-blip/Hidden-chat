-- A delivery target is (message, user, device). With (message, device) alone, two group members who had no signed-in
-- device both waited on the "any device" target ('*'), the second row was dropped, and the message could be deleted
-- before that member ever received it. Keeps every row; only the key changes.
SET LOCAL search_path TO relay;

ALTER TABLE message_deliveries DROP CONSTRAINT message_deliveries_pkey;
ALTER TABLE message_deliveries ADD PRIMARY KEY (message_id, user_id, device_id);

-- One-use pairing codes were replaced by QR linking (src/linking.js).
DROP TABLE pairing_codes;

UPDATE schema_version SET version = 20 WHERE singleton = 1;
