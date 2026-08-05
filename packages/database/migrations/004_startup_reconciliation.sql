UPDATE app_state
SET value = value || '{"reconciled":false}'::jsonb,
    updated_at = now()
WHERE key = 'variational_session' AND NOT (value ? 'reconciled');
