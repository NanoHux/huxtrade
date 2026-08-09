INSERT INTO notification_preferences(event_type) VALUES ('asset_resumed')
ON CONFLICT(event_type) DO NOTHING;
