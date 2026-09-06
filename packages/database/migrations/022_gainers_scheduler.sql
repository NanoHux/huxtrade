-- Daily gainers basket: the scheduler switch and its Telegram report.
--
-- The switch lives in app_state rather than a column so the dashboard toggle
-- and the agent read the same row, and it ships DISABLED: a scheduler that
-- places real orders must be turned on deliberately, never inherited from a
-- migration.
INSERT INTO app_state(key,value) VALUES('gainers_scheduler','{"enabled":false}'::jsonb)
ON CONFLICT(key) DO NOTHING;

-- Ships ENABLED. The report is the only place the unmatched names appear, and
-- an operator who cannot see them has no way to know a night traded three
-- positions instead of five.
INSERT INTO notification_preferences(event_type, enabled) VALUES ('gainers_basket', true)
ON CONFLICT(event_type) DO NOTHING;
