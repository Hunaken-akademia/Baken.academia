# REIN public release readiness

## Implemented in this change

- Horizontal touch navigation between the four analysis tabs; vertical, edge and short gestures do not navigate. Existing tab controls remain available.
- Best-effort per-process response cache: analysis 15 seconds, schedule 30 seconds. Same-key in-flight work is shared. Successful non-fallback responses only; no stale serving.
- At most eight distinct in-flight analyses per process, with 503 and Retry-After when saturated. This is **not** a distributed rate limit or a billing cap.
- External request deadlines and explicit Node handler time limits.
- Every inference request verifies an RS256 signature, expiry, issuer, audience, team, project and environment. No server-environment-token fallback for anonymous callers. Public signing keys are cached, not authorization decisions.
- Service tokens are sent only to the configured trusted Vercel deployment host, never to a request-controlled host.
- Generic inference errors, no token/internal exception details returned to callers.
- Basic browser security headers and removal of X-Powered-By.
- CI regression tests for cache and inference authorization; DOM touch interaction test.

Prediction models, scoring and ticket selection logic are unchanged. Cache freshness limits do not guarantee that the upstream source itself is current.

## Required before general release

1. Verify swipe gestures on real iOS Safari and Android Chrome, including vertical scrolling, browser back edges, pinch zoom and assistive technology. DOM events are not real-device testing.
2. Agree expected peak users, requests/minute, response-time targets and monthly budget. Run a bounded, approved staging load test with mocked source data first. Measure p50/p95 latency, cache hit rate, inference CPU/memory, errors and upstream calls. Do not load-test third-party race sources without authorization.
3. Add shared rate limiting / WAF rules for `/api/analyze` and `/api/rein_score`, including global limits and an operational kill switch. Per-process limits alone do not bound autoscaling or costs.
4. Decide whether shared precomputed race results / distributed cache are needed from measured demand; define maximum acceptable odds/result age and invalidation. Do not choose a paid service without a budget decision.
5. Configure and test spend alerts, usage monitoring, error alerts and incident/rollback procedures. Confirm platform spending controls rather than assuming notifications are hard caps.
6. Verify public redistribution rights and request-rate policies for race data, model artifacts and historical data. Review terms, privacy notice, retention and age/responsible-use requirements with qualified advice where needed.
7. Audit Supabase RLS, storage policies, broker authorization and secret exposure for the actual public release design. This change does not certify those settings.
8. Resolve dependency audit findings and establish reproducible locked installs and periodic security updates. The current production-dependency audit found one moderate AJV advisory and no high/critical findings; this is not a complete security audit.
9. Confirm model fallback is visible to users, freshness timestamps are clear, and predictions are not presented as guaranteed outcomes.

No paid plan upgrade or new paid resource is part of this change. Cost reduction is not quantified until production measurements exist.
