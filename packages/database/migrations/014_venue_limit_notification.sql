-- Venue-side refusals get their own notification type, separate from genuine
-- order failures.
--
-- `skew_limit_exceeded` (Variational capping long-OI-minus-short-OI per asset)
-- is refused, unactionable, and self-resolving — but the model retries every
-- 15 minutes for as long as the bias stays armed, so it produced an identical
-- alert every quarter hour. Routing it here lets the operator mute a condition
-- they cannot act on without also muting parameter errors, protection-creation
-- failures and outright platform rejections, which all still fire order_failed.
--
-- Ships ENABLED so this migration changes nothing on its own: it hands over a
-- switch, it does not flip it.
INSERT INTO notification_preferences(event_type, enabled) VALUES ('venue_limit_rejected', true)
ON CONFLICT(event_type) DO NOTHING;
