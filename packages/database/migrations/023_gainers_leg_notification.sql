-- Per-leg notification for the gainers basket.
--
-- Ships ENABLED and separate from the basket summary: the operator asked to be
-- told about each coin as it goes on, and a digest that arrives after the whole
-- basket is placed cannot say which leg failed while there is still time to act.
INSERT INTO notification_preferences(event_type, enabled) VALUES ('gainers_leg', true)
ON CONFLICT(event_type) DO NOTHING;
