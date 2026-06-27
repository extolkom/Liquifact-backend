# Email Operations for Settlement Reminders

The internal backend uses a customized background job worker architecture to send email notifications without holding up critical HTTP requests. It separates the presentation (template strings) from the logical workflow (job queueing).

## Configuration
By default, the worker will run in a **dry-run** logging mode to provide transparent observability during local development and CI test runs. It seamlessly switches to a production-grade SMTP pool when credentials are provided in the environment variables (e.g., via `.env`).

Required environment variables for real traffic:
- `SMTP_HOST`: The host for your SMTP delivery service (e.g., SendGrid, AWS SES).
- `SMTP_PORT`: (Optional) Defaults to 587.
- `SMTP_USER`: SMTP authenticated username.
- `SMTP_PASS`: SMTP authenticated password.
- `SMTP_FROM`: (Optional) Sender signature overriding `noreply@liquifact.com`.

### Retry Configuration
- `SMTP_MAX_RETRIES`: (Optional) Maximum retry attempts for transient SMTP failures. Defaults to 3.

## Delivery Resiliency

Maturity reminder emails include built-in resiliency to handle transient failures:

### Exponential Backoff
- Each retry uses exponential backoff with a base delay of ~1 second
- Delay multiplies by 2 for each subsequent attempt
- Maximum delay is capped at the configured `maxDelay` parameter
- Jitter (±20%) is added to prevent thundering herd during traffic spikes

### Error Classification
The system distinguishes between **permanent** and **transient** SMTP errors:

**Permanent Errors (no retry, dead-lettered immediately):**
- SMTP 5xx codes (550-554): invalid recipient, policy rejection, quota exceeded
- Specific error patterns: "Invalid recipient", "User unknown", "Mailbox not found"

**Transient Errors (retried with backoff):**
- SMTP 4xx codes (421-429): temporary service unavailable
- Network errors: `ECONNREFUSED`, `ETIMEDOUT`, `EHOSTUNREACH`
- Generic transport errors without a 5xx code

### Dead-Lettering
When a maturity reminder fails after exhausting all retries (or encounters a permanent error):
1. The email is **dead-lettered** to an in-memory queue for manual inspection
2. A Prometheus counter (`maturity_reminder_dead_letter_total`) is incremented with the failure reason
3. Logging records the error details for debugging and alerting

Dead-letter entries include:
- `invoiceId`: Invoice associated with the failed reminder
- `email`: Recipient email address
- `error`: Error object with code, message, SMTP response, and permanent/transient classification
- `timestamp`: ISO-8601 timestamp of the failure
- `maxAttempts`: Number of retry attempts that were made

## Metrics

Three Prometheus counters track reminder delivery:

| Metric | Labels | Description |
|--------|--------|-------------|
| `maturity_reminder_delivery_attempts_total` | `job_type=maturity_reminder` | Total delivery attempts (each retry counts) |
| `maturity_reminder_delivery_success_total` | `job_type=maturity_reminder` | Successfully delivered reminders |
| `maturity_reminder_dead_letter_total` | `job_type`, `reason` | Dead-lettered reminders (reason: `permanent_error` or `max_retries_exceeded`) |

Example queries:
```prometheus
# Success rate (%)
(rate(maturity_reminder_delivery_success_total[5m]) / rate(maturity_reminder_delivery_attempts_total[5m])) * 100

# Dead-letter rate
rate(maturity_reminder_dead_letter_total[5m])

# Permanent vs transient failures
sum by (reason) (rate(maturity_reminder_dead_letter_total[5m]))
```

## Memory Footprint of the Invoice Map
Our job execution manages `cancellable jobs`. E.g., if an invoice is settled well before the maturity date, we should refrain from bothering the end-user with a reminder. We achieve this with a localized map mapping `invoiceId`s to `jobId`s.
The localized map does not pose a significant memory constraint since successful deliveries cleanly evict mapped keys, keeping state extremely lightweight.

The dead-letter queue is also bounded to 1000 entries to prevent unbounded memory growth. When the limit is reached, the oldest entry is discarded.

## Code Interactions

### `scheduleReminder(invoice, targetDate, email)`
Schedules the async delivery to the particular email at `targetDate` using our exponential backoff job queue underneath.
It handles deduplication seamlessly: re-scheduling a reminder manually drops the old intent from the queue instantly.

### `cancelReminder(invoiceId)`
A straightforward utility for the Express controller. Pass the invoice ID if the invoice is successfully settled entirely, which prunes it off the BackgroundWorker's waiting block.

### `getDeadLetterQueue()`
Retrieves a copy of the dead-letter queue for debugging and manual recovery operations.

### `clearDeadLetterQueue()`
Clears the dead-letter queue after manual investigation or recovery.

## Testing manually using Node.js REPL

You can test this easily manually without triggering full test suites:
```javascript
const {
  scheduleReminder,
  startQueueProcessing,
  templates,
  getDeadLetterQueue
} = require('./src/jobs/maturityReminders');

startQueueProcessing();

const simulatedInvoice = { id: 'test_123', customer: 'Alice', amount: 50 };
// Schedules immediately (since it's in the past)
scheduleReminder(simulatedInvoice, new Date(), 'alice@example.com');

// After a few seconds, check dead-letter queue (if delivery failed)
setTimeout(() => {
  console.log('Dead letters:', getDeadLetterQueue());
}, 2000);
```

---

# SME Invoice Upload Security Hardening

## Overview

The SME invoice upload flow has been hardened to prevent abuse of presigned S3 URLs. The hardening covers MIME type validation, file size enforcement, tenant/invoice-scoped key generation, bounded URL expiry, and path traversal prevention.

## Accepted MIME Types

Only the following MIME types are accepted for invoice uploads:
- `application/pdf`
- `image/jpeg`
- `image/png`
- `image/tiff`

Any other MIME type is rejected with a `400 Bad Request` response.

## File Size Limit

Uploads are limited to **512 KB** (configurable via `BODY_LIMIT_INVOICE` environment variable), consistent with the existing body size guardrail.

## Key Scoping

Object keys are generated in the format:
```
tenants/{tenantId}/invoices/{invoiceId}/{uuid}-{sanitized-filename}
```

This ensures:
- Multi-tenant isolation: files from different tenants cannot collide
- Per-invoice scoping: all files for an invoice share a prefix
- Unpredictable naming: UUID prefix prevents enumeration

## Path Traversal Prevention

All filenames are sanitized before key generation:
- Only the basename is extracted (directory components are stripped)
- Null bytes (`\0`) are removed
- `..` sequences are removed
- Special characters (`<>:"|?*\/`) are replaced with `_`
- Filenames are truncated to 255 characters

## Presigned URL Expiry

- **Upload URLs**: 15 minutes TTL (short window reduces abuse surface)
- **Download URLs**: 1 hour default TTL, maximum 24 hours
- TTL is enforced server-side; credentials are never exposed to clients

## Security Considerations

1. **No credential leakage**: AWS credentials are never returned in API responses or logged
2. **Server-side validation**: MIME type and file size are validated before URL generation, not just at upload time
3. **Content-Type enforcement**: The presigned URL includes the Content-Type constraint, so S3 will reject mismatched types
4. **Content-Length enforcement**: The presigned URL includes the file size, so S3 will reject oversized uploads
5. **Error messages are safe**: Error responses do not leak internal state or stack traces

## Endpoints

### POST /api/sme/invoice/presigned-url
Request a presigned upload URL for direct-to-S3 upload.

Request body:
```json
{
  "fileName": "invoice.pdf",
  "mimeType": "application/pdf",
  "fileSize": 102400,
  "invoiceId": "optional-invoice-id"
}
```

### POST /api/sme/invoice
Direct upload via multipart form (multer), validated server-side.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `AWS_REGION` | `us-east-1` | AWS region for S3 |
| `S3_ENDPOINT` | - | S3-compatible endpoint (e.g., MinIO) |
| `AWS_ACCESS_KEY_ID` | - | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | - | S3 secret key |
| `S3_BUCKET` | `liquifact-invoices` | S3 bucket name |
| `BODY_LIMIT_INVOICE` | `512kb` | Max invoice file size |

---

## Observability — Prometheus Metrics

Two counters are emitted per delivery attempt. Both carry **bounded** label sets to prevent Prometheus time-series cardinality explosion.

### `maturity_reminder_delivery_attempts_total`

Incremented once per attempt, regardless of outcome.

**Labels:**

| Label      | Allowed values                                          |
|------------|---------------------------------------------------------|
| `reason`   | `smtp_timeout`, `smtp_reject`, `template_error`, `unknown` |
| `job_type` | `maturity_reminder`, `unknown`                          |

On a successful send the `reason` label is `unknown` (no failure to categorise).

### `maturity_reminder_dead_letter_total`

Incremented only when the job handler throws (i.e. the message is dead-lettered).

**Labels:** same as above, with `reason` populated by the failure class.

### Reason normalisation

Raw SMTP error strings are **never** written directly to a label. The `normalizeReminderReason` helper (in `src/metrics.js`) maps them to one of the four bounded values:

| Raw error pattern                             | Label value      |
|-----------------------------------------------|------------------|
| "timeout", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "connect" | `smtp_timeout` |
| "reject", "550"–"554", "421"–"452", "EAUTH"  | `smtp_reject`    |
| "template"                                    | `template_error` |
| Everything else / non-string / empty          | `unknown`        |

**PII guarantee:** the raw error message is never stored in any label value. No recipient email address or invoice content can appear in Prometheus time series.

### Dashboard / alert queries

```promql
# Delivery failure rate (5 m window)
rate(maturity_reminder_dead_letter_total[5m])

# SMTP timeouts in the last hour
increase(maturity_reminder_dead_letter_total{reason="smtp_timeout"}[1h])

# Total attempts by job type
rate(maturity_reminder_delivery_attempts_total[5m])
```

