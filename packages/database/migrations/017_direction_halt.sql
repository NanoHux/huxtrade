-- Same-direction losing-streak circuit breaker.
--
-- Three stop-outs one way inside a few hours is the signature of a regime the
-- model is reading backwards, not of three independent unlucky trades. On
-- 2026-08-08 four shorts stopped out between 18:58 and 22:14 for -157 USDC,
-- spread across `4`, ARC, RAVE and ACE — a per-asset counter would never have
-- reached three, which is why the breaker is account-wide.
--
-- Ships ENABLED. The breaker withholds arming, which is a change in what the
-- account is allowed to do, and an operator who cannot see it has no way to
-- explain why half the book stopped producing orders.
INSERT INTO notification_preferences(event_type, enabled) VALUES ('direction_halted', true)
ON CONFLICT(event_type) DO NOTHING;
