# Webhooks

This document describes the webhook system for LiquiFact escrow events.

## Overview

Webhooks are emitted to merchant-configured URLs when escrow events occur. The webhooks are signed with HMAC-SHA256 for security.

## Events

### escrow_funded

Emitted when an escrow is funded.

**Payload:**
```json
{
  "event": "escrow_funded",
  "timestamp": "2023-10-01T12:00:00.000Z",
  "invoiceId": "inv_123",
  "fundedAmount": 1000
}
```

### escrow_settled

Emitted when an escrow is settled.

**Payload:**
```json
{
  "event": "escrow_settled",
  "timestamp": "2023-10-01T12:00:00.000Z",
  "invoiceId": "inv_123",
  "fundedAmount": 1000
}
```

## Configuration

Webhooks are configured per tenant in the `tenants.settings` JSONB field:

```json
{
  "webhook_url": "https://merchant.example.com/webhooks",
  "webhook_secret": "your-secret-key"
}
```

## Security

Each webhook request includes an `X-Signature` header containing a timestamped HMAC-SHA256 signature using the configured secret.

### Signature Format

The signature header uses the format `X-Signature: t=<timestamp>,v1=<signature>` where:
- `t` is a Unix timestamp (seconds) of when the webhook was signed
- `v1` is the signature version identifier
- Both are required for proper verification

### Signature Construction

1. Generate a Unix timestamp (seconds since epoch).
2. Create the signed payload string: `"<timestamp>.<raw_json_body>"` (e.g., `"1704110400.{...}"`)
3. Compute HMAC-SHA256 of the signed payload using your webhook secret.
4. Include in the request header: `X-Signature: t=<timestamp>,v1=<hex_signature>`

### Verifying Webhook Signatures (Receiver)

To verify a webhook signature on the receiver side:

**Security Best Practices:**
1. **Use constant-time comparison** - Use `crypto.timingSafeEqual()` or equivalent to prevent timing attacks when comparing signatures.
2. **Validate the timestamp** - Reject webhooks with timestamps older than 5 minutes (recommended tolerance window) to prevent replay attacks.
3. **Keep the secret secure** - Never log or expose your webhook secret. Store it in environment variables or a secure secrets manager.
4. **Parse carefully** - Extract `t=` and `v1=` parameters from the signature header before verification.

**Verification Steps (Node.js example):**
```javascript
const crypto = require('crypto');

function verifyWebhook(rawBody, signatureHeader, secret, toleranceMs = 5 * 60 * 1000) {
  const parts = signatureHeader.split(',');
  let timestamp = null;
  let signature = null;

  for (const part of parts) {
    if (part.startsWith('t=')) {
      timestamp = parseInt(part.slice(2), 10);
    } else if (part.startsWith('v1=')) {
      signature = part.slice(3);
    }
  }

  if (!timestamp || !signature) {
    throw new Error('Invalid signature header format');
  }

  // Check for replay attacks
  const now = Date.now();
  if (Math.abs(now - timestamp * 1000) > toleranceMs) {
    throw new Error('Timestamp outside tolerance window');
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  // Use constant-time comparison
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
    throw new Error('Invalid signature');
  }

  return true;
}
```

**Replay Protection:**
The timestamp in the signature allows receivers to detect and reject replayed webhooks. We recommend a tolerance window of 5 minutes (300,000 ms), which can be configured. Any webhook with a timestamp outside this window should be rejected.

**Idempotency Recommendation:**
While signatures prevent tampering and replay, consider implementing idempotency on the receiver side to handle duplicate legitimate webhook deliveries gracefully. The `invoiceId` in the payload can be used as an idempotency key.

## Delivery

- Webhooks are sent via HTTP POST using Node.js native `fetch`.
- Timeout: 5 seconds (implemented via `AbortController`).
- Non-2xx responses are treated as failures and logged.
- Failures are logged but not retried (retries to be implemented in follow-up).

## Testing

Use invoice IDs `funded_invoice` and `settled_invoice` to trigger webhooks when reading escrow state.

---

## Dead-letter replay

### Overview

When a webhook delivery exhausts all retries the delivery job writes the
failed event to the `webhook_dead_letters` table. Operators can re-attempt
("replay") those deliveries after a merchant endpoint recovers using the admin
API.

### Schema — `webhook_dead_letters`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | Row identifier used in all replay/resolve calls |
| `tenant_id` | TEXT | Owning tenant |
| `invoice_id` | TEXT | Related invoice |
| `event` | TEXT | Webhook event type |
| `payload` | JSONB | Original event payload |
| `webhook_url` | TEXT | Destination URL at time of failure |
| `attempts` | INTEGER | Number of delivery attempts before dead-lettering |
| `last_error` | TEXT | Last error message |
| `resolved` | BOOLEAN | `true` once successfully replayed or manually resolved |
| `resolved_at` | TIMESTAMPTZ | When the row was resolved |

Migration: `migrations/20260627000001_create_webhook_dead_letters.sql`

### Replay flow

```
Operator                Admin API              webhooks.js          Merchant
   │                       │                       │                    │
   │ POST /replay/:id       │                       │                    │
   │──────────────────────>│                       │                    │
   │                       │ replayWebhook(id)     │                    │
   │                       │──────────────────────>│                    │
   │                       │                       │ fetch tenant secret│
   │                       │                       │ createSignatureHeader()
   │                       │                       │ POST (fresh sig)──>│
   │                       │                       │<── 2xx ────────────│
   │                       │                       │ resolveDeadLetter()│
   │                       │<── { replayed: [id] } │                    │
   │<── 202 ───────────────│                       │                    │
```

Key properties:
- **Re-signs every replay** — a fresh `t=<timestamp>,v1=<hmac>` signature is
  computed at replay time using the tenant's current webhook secret.
- **Idempotency guard** — replaying an already-resolved row returns `409`.
- **Atomic resolution** — the row is only marked resolved after a `2xx`
  response; a delivery failure leaves it available for a subsequent replay.

### Admin endpoints

All endpoints require either `Authorization: Bearer <admin-jwt>` or
`X-API-Key: <key>`.

#### Replay a single row

```
POST /api/admin/webhooks/replay/:id
```

Responses:

| Status | Meaning |
|--------|---------|
| 202 | Replayed successfully — `{ "replayed": ["<id>"] }` |
| 401/403 | Missing or invalid credentials |
| 404 | Dead-letter row not found |
| 409 | Row already resolved |
| 502 | Delivery failed — `{ "error": "Replay failed: <msg>" }` |

#### Replay a batch

```
POST /api/admin/webhooks/replay
Content-Type: application/json
```

Body (one of):

```json
{ "ids": ["uuid1", "uuid2"] }
```

```json
{ "tenantId": "t_123", "limit": 50 }
```

`limit` is capped at 200. Response is always `202`:

```json
{
  "replayed": ["uuid1"],
  "failed":   [{ "id": "uuid2", "error": "..." }]
}
```

#### Resolve without re-sending

```
POST /api/admin/webhooks/resolve/:id
```

Marks the row resolved without making a delivery attempt. Useful when the
event is stale and re-delivery is not desired.

| Status | Meaning |
|--------|---------|
| 200 | Resolved — `{ "resolved": "<id>" }` |
| 404 | Row not found |
| 409 | Row already resolved |

### `webhook_replay` job

The `webhookReplayHandler` in `src/jobs/webhookReplay.js` processes
`webhook_replay` jobs enqueued with `{ deadLetterId }` as the payload. It is
registered with the background worker and increments the `webhook_replay_total`
Prometheus counter with the outcome label:

| `outcome` | Meaning |
|-----------|---------|
| `success` | Delivery succeeded and row resolved |
| `failure` | Delivery returned non-2xx or network error |
| `not_found` | Dead-letter row missing |
| `already_resolved` | Row was already resolved before the job ran |

### Metrics

`webhook_replay_total{outcome="..."}` — exported by `GET /metrics`.

### Security

- Only admin-authenticated callers (JWT or API key) can trigger replays.
- The HMAC signature is always recomputed at replay time — stored payloads
  are never re-sent with a stale signature.
- Batch size is hard-capped at 200 to prevent request-amplification abuse.
