-- Free-text questions sent to the operator's assistant from Telegram.
--
-- The bot cannot be polled by two processes: Telegram's getUpdates advances a
-- shared offset, so whichever consumer reads first makes the message invisible
-- to the other. telegram-worker therefore stays the only reader and parks
-- anything addressed to the assistant here; the answer travels back out
-- through the same outbox every other notification uses.
CREATE TABLE IF NOT EXISTS operator_messages (
  id bigserial PRIMARY KEY,
  chat_id text NOT NULL,
  text text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  answer text
);

CREATE INDEX IF NOT EXISTS operator_messages_unanswered_idx ON operator_messages(received_at) WHERE answered_at IS NULL;

INSERT INTO notification_preferences(event_type, enabled) VALUES ('operator_reply', true)
ON CONFLICT(event_type) DO NOTHING;
