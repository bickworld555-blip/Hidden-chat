-- The delivery queue's 10-minute sweeps delete by age (server/deliveryQueue.mjs: created_at <= cutoff); without these
-- indexes each sweep read the whole table, which grows with traffic. Run once, in order, after 029.
SET LOCAL search_path TO relay;

CREATE INDEX IF NOT EXISTS message_deliveries_created ON message_deliveries(created_at);
CREATE INDEX IF NOT EXISTS device_events_created ON device_events(created_at);
CREATE INDEX IF NOT EXISTS message_routes_created ON message_routes(created_at);

UPDATE schema_version SET version = 30 WHERE singleton = 1;
