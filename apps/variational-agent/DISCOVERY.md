# Variational protocol discovery gate

The browser-context adapter is implemented, but production submission remains disabled until the remaining live-write checks are completed against the user's authenticated dedicated browser profile.

1. **Partial:** refresh/login boundary observed, but natural session expiry and re-login response lifecycle remain unverified. The adapter deliberately keeps credentials inside Chrome and does not export browser storage.
2. **Complete:** authoritative reads identified for balance, margin usage, open orders, positions, trades and realized/unrealized PnL.
3. **Partial:** quote, market entry, TP, SL and reduce-only emergency close were captured and reconciled twice. Limit-entry and active cancel still require a separately approved minimum-size test.
4. **Partial:** quantity tick/minimum and leverage are verified before submit. Omni exposed no client idempotency field; timeout and rate-limit mutation outcomes remain unverified and therefore become `UNKNOWN` without retry.
5. **Complete:** `browser-fetch` uses same-origin `/api/` fetch in a logged-in Playwright/CDP Chrome. Direct Node HTTP remains unusable because Cloudflare returned 403.
6. **Complete in unit tests:** reconciliation, missing-protection compensation, global-pause filtering and interrupted-submit fail-closed behavior are implemented. Live trading remains false pending items 1, 3 and 4.

Never infer platform success from an HTTP timeout. An uncertain outcome must become `UNKNOWN` and continue to consume the symbol/side limit.

## Sanitized capture tool

On the Windows host, configure a dedicated local profile and start the headed discovery browser:

```powershell
$env:ENV_FILE_OVERRIDE='false'
$env:VARIATIONAL_ADAPTER_MODE='discovery'
$env:VARIATIONAL_BASE_URL='https://omni.variational.io/'
pnpm --filter @huxtrade/variational-agent discover
```

The tool records the Variational page origin plus any explicitly allowlisted API origins in `VARIATIONAL_DISCOVERY_ALLOWED_ORIGINS` (comma-separated). It strips query values, recursively redacts credentials, session/wallet/address/signature fields, and ignores opaque non-JSON bodies. Output is written under `VARIATIONAL_DISCOVERY_OUTPUT` (ignored by Git). Login and every wallet confirmation remain manual. Do not share the capture file; inspect it locally and transfer only the endpoint/schema facts needed by the adapter.

### Existing Chrome session: sanitized HAR import

When a dedicated automation profile is blocked by CAPTCHA, use Chrome DevTools in the already-authenticated normal profile:

1. Open **DevTools → Network**, enable recording, and clear the current request list.
2. Browse only the approved read-only Omni pages.
3. Use Chrome's **Save all as HAR (sanitized)** option. Never choose an export option that includes sensitive data.
4. Convert it locally without sharing the source HAR:

```bash
pnpm --filter @huxtrade/variational-agent discover:har -- /absolute/path/to/omni-sanitized.har
```

The importer accepts only allowlisted `/api/` entries, discards every request and response header, redacts query values and sensitive JSON fields recursively, and writes a mode-`0600` JSONL file. The source HAR can still contain private account response data; keep it private and remove it manually after checking the sanitized output.
