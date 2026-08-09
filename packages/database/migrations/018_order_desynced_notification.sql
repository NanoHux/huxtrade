-- Bookkeeping drift gets its own notification type, separate from a failed
-- submission.
--
-- UNKNOWN / RECONCILIATION_REQUIRED / CANCELLED_EXTERNALLY all used to render
-- as "下单失败". ON had filled, banked +7.16 USDC on its scale-out and was
-- still holding a protected position when it produced that message: the order
-- reached the venue and worked, only the local state came adrift. An operator
-- reading "下单失败" would go looking for an order that was never placed.
--
-- Ships ENABLED: a position whose local state no longer matches the venue is
-- exactly what someone needs to hear about, just not under that name.
INSERT INTO notification_preferences(event_type, enabled) VALUES ('order_desynced', true)
ON CONFLICT(event_type) DO NOTHING;
