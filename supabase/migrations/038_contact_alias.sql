-- Saved contact names (src/contactNames.js, PUT /api/v1/contacts/:userId/name): the name an owner gave a contact,
-- seen only by the owner's devices. '' means none (the person's own name shows). Additive.
SET LOCAL search_path TO relay;

ALTER TABLE contacts ADD COLUMN alias TEXT NOT NULL DEFAULT '';

UPDATE schema_version SET version = 38 WHERE singleton = 1;
