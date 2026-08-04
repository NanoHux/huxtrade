# Variational protocol discovery gate

Production submission remains intentionally unavailable until this checklist is completed against the user's authenticated browser profile.

1. Capture session lifecycle without placing an order: cookies, local/session storage, refresh behavior, logout signal and wallet-login boundary.
2. Identify authoritative read calls for balance, margin usage, open orders, positions, fills and realized PnL.
3. In a user-approved minimum-size live test, capture the quote, limit-entry, TP, SL, cancel and emergency-close requests and responses.
4. Record precision rules, minimum margin, client/idempotency field and all ambiguous/timeout responses.
5. Implement the verified adapter in `src/index.ts`, with internal HTTP first, browser-context fetch second and UI automation only as the final fallback.
6. Run reconciliation and protection-order failure tests before setting `VARIATIONAL_ADAPTER_MODE` and `LIVE_TRADING_ENABLED=true`.

Never infer platform success from an HTTP timeout. An uncertain outcome must become `UNKNOWN` and continue to consume the symbol/side limit.

## Sanitized capture tool

On the Windows host, configure a dedicated local profile and start the headed discovery browser:

```powershell
$env:ENV_FILE_OVERRIDE='false'
$env:VARIATIONAL_ADAPTER_MODE='discovery'
$env:VARIATIONAL_BASE_URL='https://trade.variational.io/'
pnpm --filter @huxtrade/variational-agent discover
```

The tool records the Variational page origin plus any explicitly allowlisted API origins in `VARIATIONAL_DISCOVERY_ALLOWED_ORIGINS` (comma-separated). It strips query values, recursively redacts credentials, session/wallet/address/signature fields, and ignores opaque non-JSON bodies. Output is written under `VARIATIONAL_DISCOVERY_OUTPUT` (ignored by Git). Login and every wallet confirmation remain manual. Do not share the capture file; inspect it locally and transfer only the endpoint/schema facts needed by the adapter.
