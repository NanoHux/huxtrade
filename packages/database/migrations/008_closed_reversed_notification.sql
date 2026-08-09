INSERT INTO notification_preferences(event_type) VALUES ('closed_reversed')
ON CONFLICT(event_type) DO NOTHING;
