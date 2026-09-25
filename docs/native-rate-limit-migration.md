# Native Rate Limiting migration

Issue #73 tracks the remaining non-atomic Workers KV fixed-window counter. The current KV implementation performs `get -> put(count + 1)` and can under-count concurrent requests.

This document defines the code/operations boundary for migrating the three public rate-limited endpoint groups to Cloudflare Workers Native Rate Limiting bindings.

## Endpoint contract

The application keeps the existing limits:

| Binding                | Endpoint group            | Limit |     Period |
| ---------------------- | ------------------------- | ----: | ---------: |
| `RATE_LIMIT_GO`        | `/go` and `/go/*`         |    30 | 60 seconds |
| `RATE_LIMIT_IMG`       | `/img`                    |    60 | 60 seconds |
| `RATE_LIMIT_DIAGNOSIS` | `/api/diagnosis/evaluate` |    20 | 60 seconds |

Native Rate Limiting configuration owns the period and limit. Any future Wrangler configuration must match the table above and use a separately verified namespace ID for each intended binding contract.

This PR intentionally does **not** add or change Production Wrangler bindings, namespace IDs, Cloudflare dashboard state, or deployment settings.

## Runtime selection

For each request:

1. Use the endpoint's Native Rate Limiting binding when present.
2. If the native binding throws and `KV` exists, fall back to the existing KV implementation.
3. If no endpoint binding exists, use `KV` when present.
4. If an endpoint has neither native coverage nor KV fallback, public traffic fails closed with `503 rate_limit_unavailable`.
5. The explicit `RATE_LIMIT_BYPASS=1` exception remains loopback-only.

`/api/ready` considers rate limiting covered when either:

- `KV` is available as the compatibility fallback, or
- all three native bindings are available.

Partial native binding configuration without KV must not report ready.

## Failure semantics

A configured native binding returning `success: false` produces the existing `429` response contract including `Retry-After` and `X-RateLimit-*` headers.

A runtime exception from a native binding falls back to KV where possible. If both native runtime service and KV are unavailable, the existing runtime-failure policy remains availability-oriented/fail-open. Missing configuration is different: missing coverage is detected and fails closed.

Cloudflare Native Rate Limiting is still a permissive/distributed limiter rather than a billing-grade exact counter. The migration removes the repository's own non-atomic KV read-modify-write as the normal path; it does not claim globally exact accounting.

## Production completion gate for Issue #73

Do not mark the KV concurrency finding resolved merely because this code is merged. Operational completion requires all of the following on one intended Production deployment:

- all three native bindings configured with the limits above;
- configuration read back from the deployed environment;
- `/api/ready` healthy with native coverage;
- representative `/go`, `/img`, and diagnosis requests use the corresponding native bindings;
- controlled over-limit verification returns `429` with the expected retry contract;
- no credentials, tokens, or secret material recorded in repository/logs/issues;
- rollback path documented before changing Production binding configuration.

Until that operator-side gate is completed, KV remains a compatibility fallback and Issue #73 should remain open.
