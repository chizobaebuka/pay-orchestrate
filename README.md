# pay-orchestrate

[![CI](https://github.com/chizobaebuka/pay-orchestrate/actions/workflows/ci.yml/badge.svg)](https://github.com/chizobaebuka/pay-orchestrate/actions/workflows/ci.yml)

A payment orchestration service that sits between your application and multiple payment processors — currently **Stripe** and **Paystack**, with **Flutterwave** planned — giving you one consistent API regardless of which provider actually processes a given transaction, backed by an idempotency layer, an independent reconciliation pipeline, and a live transaction dashboard.

## The problem this solves

The moment a product accepts payments from more than one provider or geography, three problems show up that most integrations handle badly:

1. **Duplicate charges.** A flaky network, a retried request, or a user double-clicking "Pay" can trigger the same charge twice. Most naive integrations have no protection against this beyond hoping the client doesn't retry.
2. **Blind trust in webhooks.** Webhooks are just HTTP requests. If your backend updates a transaction to "paid" purely because a webhook said so — without independently checking with the provider — a forged, replayed, or tampered payload can mark a payment as successful when it wasn't, or for the wrong amount.
3. **Fragmented visibility.** With multiple providers, "what's the state of this payment?" usually means checking multiple dashboards by hand. There's no single, live source of truth.

`pay-orchestrate` addresses all three: idempotency keys guarantee exactly-once processing, a reconciliation worker re-verifies every webhook against the provider's own API before trusting it, and a Socket.IO dashboard gives a live, single view of transaction state as it changes.

## Architecture

```
                         ┌──────────────────┐
                         │   Client / Demo   │
                         └─────────┬────────┘
                                   │ POST /api/payments
                                   │ (Idempotency-Key header)
                                   ▼
                    ┌────────────────────────────┐
                    │   Express API (src/index)   │
                    │                              │
                    │  idempotency.middleware ─────┼──▶ Redis (SET NX EX)
                    │         │                    │
                    │         ▼                    │
                    │  Provider Adapter Registry    │
                    │   (Stripe | Paystack)  ───────┼──▶ Stripe / Paystack API
                    │         │                    │
                    │         ▼                    │
                    │  Transaction row (Postgres) ──┼──▶ Neon Postgres
                    │         │                    │
                    │         ▼                    │
                    │  Socket.IO broadcast ─────────┼──▶ Live Dashboard
                    └────────────────────────────┘

  Stripe / Paystack
        │  webhook (signed)
        ▼
┌──────────────────────┐        ┌───────────────────────┐
│  Webhook receiver      │──────▶│  BullMQ reconciliation │
│  (signature verify     │ job   │  queue (Redis)         │
│   only, no DB writes)  │       └───────────┬────────────┘
└──────────────────────┘                    │
                                              ▼
                              ┌────────────────────────────────┐
                              │  Reconciliation worker           │
                              │  1. look up transaction           │
                              │  2. re-verify with provider API   │
                              │     (independent of the webhook   │
                              │      payload)                     │
                              │  3. compare initiated vs confirmed│
                              │     amount/currency               │
                              │  4. set RECONCILED or MISMATCHED  │
                              │  5. broadcast update via Socket.IO│
                              └────────────────────────────────┘
```

The webhook receiver deliberately does **no** database work. It verifies the signature and enqueues a job — nothing else. This means a slow database or provider API can never make a webhook endpoint time out (which providers penalize/disable for), and a provider's automatic retry of an undelivered webhook just re-queues a job rather than double-processing inline.

## Why a reconciliation worker, not just a webhook handler

The most common shortcut in payment integrations is: webhook fires → trust its payload → update the database. The problem is a webhook payload is just JSON someone sent to your server — even with signature verification, a webhook only proves it came from the provider, not that the *amount inside it* matches what you actually intended to charge (a bug in your own initiation code could easily be the source of the mismatch, not just an attacker).

Instead, `pay-orchestrate`'s worker treats a webhook purely as a **trigger to re-check**, not a source of truth:

- On receipt, it calls the provider's `verify()` endpoint directly using our own API credentials, gets the provider's own record of amount/currency/status, and compares it against what was stored when the transaction was *initiated*.
- If they match and the payment succeeded → `RECONCILED`.
- If they don't match → `MISMATCHED`, and it's logged loudly rather than silently trusted.
- This was verified during development by deliberately corrupting a stored transaction amount after creation and confirming the worker caught the discrepancy against the real provider-confirmed amount.

## Idempotency design

Every `POST /api/payments` requires an `Idempotency-Key` header. The middleware ([src/orchestration/idempotency.middleware.ts](src/orchestration/idempotency.middleware.ts)) does an atomic `SET key "processing" EX 86400 NX` against Redis:

- If the key didn't exist, the request proceeds, and on success the key's value is overwritten with the real transaction ID.
- If the key already exists and is still `"processing"`, a concurrent duplicate request in flight is rejected with `409`.
- If the key already exists and holds a transaction ID, the duplicate request is short-circuited and returns the *original* result — no second charge is ever attempted.
- On any failure path (validation error, unsupported provider, provider API error), the key is deleted so a genuinely failed request can be retried under the same key.

## Provider abstraction

Every provider implements the same interface ([src/providers/provider-adapter.interface.ts](src/providers/provider-adapter.interface.ts)):

```ts
interface PaymentProviderAdapter {
  name: ProviderName;
  initiate(params: PaymentInitiateParams): Promise<PaymentInitiateResult>;
  verify(providerReference: string): Promise<PaymentVerifyResult>;
  handleWebhook(payload: string | Buffer, signature: string): WebhookEvent;
}
```

Adding a new provider (Flutterwave is next) means implementing this interface and registering it in [src/providers/registry.ts](src/providers/registry.ts) — no changes needed anywhere else, including the reconciliation worker, which is provider-agnostic.

Stripe and Paystack differ meaningfully in their payment flow, and the interface accommodates that rather than papering over it: Stripe's PaymentIntent can be confirmed directly from the backend, while Paystack requires redirecting the customer to a hosted checkout page — so `PaymentInitiateResult` carries an optional `redirectUrl` that's only populated when a provider needs it.

## Edge cases handled

| Edge case | How it's handled |
|---|---|
| Duplicate/retried payment request | Redis `SET NX EX` idempotency lock, see above |
| Concurrent duplicate requests racing each other | Atomic Redis `NX` — only one wins, the other gets `409` |
| Webhook payload amount doesn't match what was charged | Reconciliation worker independently re-verifies with the provider and flags `MISMATCHED` rather than trusting the payload |
| Webhook signature forged or tampered in transit | Stripe: `stripe.webhooks.constructEvent` against the raw body; Paystack: HMAC-SHA512 compared with `crypto.timingSafeEqual` to avoid timing attacks |
| Webhook body gets mangled by JSON body-parsing before signature check | Webhook routes are mounted with `express.raw()` **before** the global `express.json()` middleware, so the exact bytes the provider signed are what gets verified |
| Provider retries an already-processed webhook | Safe by construction — the worker always re-verifies against the provider's current state rather than assuming "already saw this" |
| Slow DB/provider call blocking webhook response | Webhook handler never touches the DB; it verifies the signature and enqueues, responding immediately |
| Local Postgres doesn't support SSL but hosted Postgres (Neon) requires it | `ssl` is only enabled when the connection host isn't `localhost`/`127.0.0.1` (see [src/db/data-source.ts](src/db/data-source.ts)) |
| BullMQ's pinned internal `ioredis` version conflicting with the top-level one | BullMQ connections use a plain options object instead of a shared `ioredis` instance, avoiding a type/version clash entirely |
| Unsupported/unknown `provider` field in a payment request | Rejected with `400` before any provider API call or DB write, and the idempotency key is released |
| TypeORM entity/migration paths only resolving under `ts-node`, breaking the compiled production build | `entities`/`migrations` glob patterns are built from `__dirname` with both `.ts`/`.js` extensions (see [src/db/data-source.ts](src/db/data-source.ts)), so they resolve correctly whether running via `ts-node` (dev) or `node dist/index.js` (production) — caught by actually running the compiled build, not just `npm run dev` |

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js + TypeScript | Type safety across provider adapters and job payloads |
| API | Express 5 | Minimal, well understood, easy to reason about raw-body handling for webhooks |
| Database | PostgreSQL (Neon), TypeORM | Relational integrity for the transaction ledger; migrations instead of auto-sync |
| Cache / locks | Redis (Upstash), ioredis | Atomic idempotency locking |
| Job queue | BullMQ | Decouples webhook receipt from processing; built-in retry semantics |
| Realtime | Socket.IO | Push transaction state to the dashboard without polling |
| Payments | Stripe SDK, Paystack REST API (native `fetch`) | Stripe has a first-party SDK; Paystack's REST surface is small enough that a dependency wasn't worth it |
| API docs | OpenAPI 3.0 (hand-written spec) + swagger-ui-express | Self-hosted, no external tooling or build step — the same route serves docs locally and once deployed |
| Testing | Jest + ts-jest + Supertest | Fully offline test suite; nothing hits a real network or database |
| Linting | ESLint + typescript-eslint (flat config) | Type-aware linting, gated in CI |
| CI/CD | GitHub Actions | Lint → test → build on every push/PR, optional Render deploy hook on `main` |

## Project structure

```
src/
  db/
    data-source.ts          TypeORM DataSource config (conditional SSL)
    entities/transaction.ts  The transaction ledger — single source of truth
    migrations/              Schema migrations (no auto-sync in any environment)
    redis-client.ts          Shared Redis client for idempotency
  orchestration/
    idempotency.middleware.ts
    orchestration.routes.ts  POST /api/payments, GET /api/transactions
  providers/
    provider-adapter.interface.ts
    stripe.adapter.ts
    paystack.adapter.ts
    registry.ts               Maps ProviderName -> adapter instance
  queues/
    connection.ts             BullMQ-safe Redis connection options
    reconciliation.queue.ts
    reconciliation.worker.ts  Independent provider re-verification + status transitions
  webhooks/
    webhooks.routes.ts        Signature verification + enqueue only, no DB writes
  realtime/
    socket.ts                 Socket.IO server + broadcastTransactionUpdate()
  docs/
    openapi.ts                 Hand-written OpenAPI 3.0 spec, served at /api-docs
  index.ts                    App wiring: DB, Redis, worker, socket, HTTP server, docs
public/
  dashboard.html               Live transaction dashboard (no build step, no framework)
```

## Getting started

```bash
npm install
cp .env.example .env   # fill in real values — see below
npm run migration:run
npm run dev
```

Required environment variables (see `.env.example`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (Neon or local) |
| `REDIS_URL` | Redis connection string (Upstash or local) |
| `STRIPE_PUBLISHABLE_KEY` / `STRIPE_SECRET_KEY` | Stripe test-mode keys |
| `STRIPE_WEBHOOK_SECRET` | From `stripe listen` (see below) |
| `PAYSTACK_TEST_PUBLIC` / `PAYSTACK_TEST_SECRET` | Paystack test-mode keys |
| `PORT` | Defaults to 4000 |

### Testing webhooks locally

```bash
stripe login
stripe listen --forward-to localhost:4000/webhooks/stripe
# copy the printed whsec_... into STRIPE_WEBHOOK_SECRET, restart npm run dev
```

**Important:** `stripe listen` defaults to whatever Stripe account your CLI is logged into. Make sure that's the *same* account as your `STRIPE_SECRET_KEY` — if your organization has multiple sandboxes, `stripe listen` will silently forward events for the wrong one and your webhooks will never arrive. Run `stripe config --list` to check.

## API reference

Full interactive docs (OpenAPI 3.0, via Swagger UI) are served by the app itself at **`/api-docs`** — this works identically in local dev and on the deployed instance, since it's just an Express route with no separate hosting or build step. The raw spec is also available as JSON at `/api-docs.json` for tooling (Postman import, client codegen, etc.).

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check — pings both Postgres and Redis |
| `POST` | `/api/payments` | Create a payment. Requires `Idempotency-Key` header. Body: `{ amount, currency, customerEmail?, metadata?, provider? }` (`provider` defaults to `stripe`) |
| `GET` | `/api/transactions` | Most recent 20 transactions, newest first |
| `POST` | `/webhooks/stripe` | Stripe webhook receiver |
| `POST` | `/webhooks/paystack` | Paystack webhook receiver |
| `GET` | `/dashboard.html` | Live transaction dashboard |
| `GET` | `/api-docs` | Interactive Swagger UI |
| `GET` | `/api-docs.json` | Raw OpenAPI 3.0 spec |

## Testing

```bash
npm test
```

Tests live alongside the code they cover (`*.test.ts` next to the source file) and run fully offline — no real Postgres, Redis, Stripe, or Paystack calls. Everything that talks to an external system is mocked at the module boundary; Paystack's HMAC signature verification is the one exception, since it's pure `crypto` logic worth testing for real rather than mocking.

Coverage focuses on behavior that's easy to get subtly wrong, not line count:

- **Idempotency middleware** — new key proceeds, concurrent duplicate gets `409`, completed duplicate returns the original result, key release on every failure path.
- **Provider adapters** (Stripe, Paystack) — status-mapping tables from each provider's vocabulary to our internal `TransactionStatus`, metadata/amount unit conversion, and webhook signature verification (both a real valid signature and a tampered payload against Paystack's actual HMAC implementation).
- **Reconciliation state machine** — this is the part most worth testing, since it's the fraud/bug-catching mechanism: `PENDING → RECONCILED` on a matching confirmed payment, `PENDING → MISMATCHED` on amount or currency disagreement, floating-point tolerance so sub-cent rounding doesn't cause false mismatches, and an unknown `providerReference` being a safe no-op.
- **HTTP routes** (Supertest) — the full `POST /api/payments` request/response contract including validation and idempotency-key cleanup on every error path, and webhook routes rejecting missing/invalid signatures before ever touching the queue.

Lint separately:

```bash
npm run lint
```

## CI/CD

Every push and pull request against `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml): `npm ci` → lint → test → build, in that order — a broken build never gets a green check next to a lint or test failure hiding underneath it. The test suite needs no external services (no Postgres/Redis containers in CI), since everything is mocked at the module boundary.

A second job optionally triggers a Render deploy hook after a successful `main` build, but only if a `RENDER_DEPLOY_HOOK_URL` repository secret is configured — without it, the job just logs that it skipped rather than failing, so CI stays green on forks/clones that haven't set up deployment yet.

## Roadmap

- [x] Provider adapter interface + Stripe integration
- [x] Paystack integration + provider routing
- [x] Signed webhooks for both providers
- [x] BullMQ reconciliation pipeline with independent provider re-verification
- [x] Live Socket.IO dashboard
- [x] Automated test suite (Jest + Supertest)
- [~] Docker + docker-compose (files written, **not yet verified with a real build** — see below)
- [x] CI/CD (GitHub Actions: lint → test → build on every push/PR; optional auto-deploy to Render)
- [ ] Flutterwave adapter
- [ ] Production deployment

## License

ISC
