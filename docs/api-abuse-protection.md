# API abuse protection

Deployed application protection uses the shared Supabase RPC `reserve_api_budget_v1` before API work. PostgreSQL grants at most five permits per lease atomically. Warm instances reuse only those already-reserved permits, and cold starts cannot reset the allowance.

| Application | Read requests/min/IP | Prediction requests/min/IP | Writes/min/IP | Login/min/IP | Internal API/min/IP |
|---|---:|---:|---:|---:|---:|
| WAKE | 600 | 120 | 60 | 30 | 120 |
| REIN | 240 | 120 | 60 | 30 | 120 |

REIN additionally applies the corresponding allowance to each verified member identity. Fixed windows last one minute. Leases may reserve a few unused permits, so a caller can be throttled slightly before the displayed nominal limit when many instances are involved.

WAKE verifies CRON_SECRET, CAPTURE_TOKEN or the existing path-bound capture HMAC before exempting internal collection traffic. REIN exempts only exact CRON_SECRET authentication on its existing internal route allowlist. GitHub OIDC collection and Python inference retain their original authorization and have a separate generous internal bucket. Stripe's signature-verified webhook and OPTIONS preflights are excluded. Origin, User-Agent and the presence of a token alone never bypass the protection.

Only keyed identity hashes are stored in `api_security.request_budgets`, never raw IP addresses, email addresses or bearer tokens. RLS is enabled; anon and authenticated roles cannot read the table or execute the RPC. The service_role alone can reserve permits. Expired hashes are cleaned in bounded batches after one hour, on subsequent requests.

429 responses contain Retry-After and no-store headers. Missing production credentials, failed budget requests or malformed budget responses temporarily return 503 instead of allowing unbounded expensive work. Preview deployments without production secrets have an explicitly local fallback for smoke tests; production never uses it.

Validation: simultaneous requests across six independent instances share a single allowance; database grants saturate at the configured limit; blocked retries do not hit the database; window boundaries, secret exemptions, role permissions, webhook bodies and unavailable dependencies are tested.

This reduces application and database work caused by request floods. Middleware and network traffic can still incur charges. It is not a total billing cap, and distributed attacks using many identities still require upstream WAF rules and account-level spend controls. Vercel firewall configuration APIs currently return 404 in the connected account; WAF enforcement and billing stop settings must be confirmed through the dashboard.

Rollback: revert the application deployment. The database objects can remain inert and contain no user content. Existing membership authentication, cron authentication and payment signature verification must remain enabled.

