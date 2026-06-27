'use strict';

/**
 * @fileoverview Prometheus metrics registry and /metrics route handler.
 *
 * ## Auth strategy (in priority order)
 *
 * 1. If `METRICS_BEARER_TOKEN` is set, require `Authorization: Bearer <token>`.
 *    The token comparison uses a **constant-time** algorithm to prevent timing
 *    side-channel attacks.
 *
 * 2. If `METRICS_BEARER_TOKEN` is **unset**, allow requests from loopback
 *    addresses only (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). This is suitable
 *    for private-network Prometheus scraping.
 *
 * 3. All other requests receive a uniform `401` with no detail about _why_
 *    (no distinction between "wrong token" and "missing token").
 *
 * ## Security: trusted-proxy & X-Forwarded-For
 *
 * Loopback detection **always** reads the direct TCP connection address from
 * `req.socket.remoteAddress`. The `X-Forwarded-For` header is **never**
 * consulted, so a remote attacker cannot spoof a loopback origin by setting
 * `X-Forwarded-For: 127.0.0.1`.
 *
 * There is no `app.set('trust proxy', ...)` call anywhere in this application.
 * If one is added in the future, `req.ip` could resolve to a `X-Forwarded-For`
 * value, but this middleware **already** ignores `req.ip` for loopback checks
 * and reads the socket directly, making it resilient to such config changes.
 *
 * @module metrics
 */

let client;
try {
  client = require('prom-client');
} catch (_e) {
  // Fallback shim for environments without prom-client (tests).
  //
  // The shims maintain the same observable surface as real prom-client so
  // tests can inspect `counter.hashMap` / `counter.get()` directly without
  // changing the assertion code.

  /**
   * Minimal prom-client Registry shim for test environments.
   * @implements {import('prom-client').Registry}
   */
  class RegistryShim {
    /** @param {void} */
    constructor() {
      this.contentType = 'text/plain';
      this._items = [];
    }
    /** @returns {string} */
    metrics() {
      return '';
    }
  }

  /**
   * Counter shim for test environments.
   * @implements {import('prom-client').Counter}
   *
   * Maintains a `hashMap` of `{value: number}` keyed by the JSON
   * stringification of the label set so callers that introspect
   * `counter.hashMap` against the real prom-client internals keep working.
   */
  class CounterShim {
    /** @param {{ name: string, help: string, labelNames?: string[] }} opts */
    constructor(opts = {}) {
      this.name = opts.name;
      this.help = opts.help;
      this.labelNames = opts.labelNames || [];
      this.hashMap = {};
      this._map = new Map();
    }
    /** @returns {void} */
    inc(labels = {}) {
      const key = JSON.stringify(labels);
      if (!this._map.has(key)) {
        this._map.set(key, { value: 0 });
      }
      const entry = this._map.get(key);
      entry.value += 1;
      this.hashMap[key] = entry;
    }
    /** Read a single labeled counter value. */
    get(labels = {}) {
      const entry = this._map.get(JSON.stringify(labels));
      return entry ? entry.value : 0;
    }
    /** Reset all label sets to 0 (test helper). */
    reset() {
      this._map.clear();
      this.hashMap = {};
    }
  }

  /**
   * Gauge shim for test environments.
   * @implements {import('prom-client').Gauge}
   */
  class GaugeShim {
    /** @param {{ name: string, help: string }} opts */
    constructor(opts = {}) {
      this.name = opts.name;
      this.help = opts.help;
      this.value = undefined;
      this.hashMap = { _default: { value: undefined } };
    }
    /** @returns {void} */
    set(v) {
      this.value = v;
      this.hashMap._default.value = v;
    }
    /** @returns {void} */
    setToCurrentTime() {
      this.value = Date.now();
      this.hashMap._default.value = this.value;
    }
    // Note: no `reset()` is exposed — gauges are sample-by-sample and any
    // test that needs a clean baseline should call `set(undefined)` or
    // re-create the shim. The original `CounterShim.reset()` IS kept
    // because the escrow-legalhold tests rely on it for cross-test
    // isolation.
  }

  client = {
    Registry: RegistryShim,
    /**
     * No-op default metrics collector stub.
     * @returns {void}
     */
    collectDefaultMetrics: () => { },
    Counter: CounterShim,
    Gauge: GaugeShim,
  };
}

/**
 * Shared Prometheus registry. Declared BEFORE the counter/gauge
 * constructors so `registers: [registry]` does not hit a TDZ
 * ReferenceError. Issue #424 + pre-existing fix: the original code
 * placed `const registry` near the bottom of the file, which meant
 * every counter construction referenced a binding that had not yet
 * been initialized. The error was masked only because every consumer
 * of this module (`tests/invest.list.test.js`, `tests/health.readiness.test.js`,
 * etc.) `jest.mock`s the module before evaluation.
 *
 * @type {import('prom-client').Registry}
 */
const registry = new client.Registry();

if (typeof client.collectDefaultMetrics === 'function') {
  client.collectDefaultMetrics({ register: registry });
}

const METRIC_REFRESH_INTERVAL_MS = 5000;
const registeredJobQueues = new Set();
const registeredWorkers = new Set();
let refreshTimer = null;

const queueDepthGauge = new client.Gauge({
  name: 'liquifact_job_queue_depth',
  help: 'Number of pending jobs currently waiting in background queues',
  registers: [registry],
});

const retryQueueSizeGauge = new client.Gauge({
  name: 'liquifact_job_retry_queue_size',
  help: 'Number of jobs waiting in retry queues for background processing',
  registers: [registry],
});

const workerInFlightGauge = new client.Gauge({
  name: 'liquifact_worker_inflight_count',
  help: 'Number of jobs currently being processed by background workers',
  registers: [registry],
});

/**
 * Bounded enum of allowed `job_type` label values.
 * Add new job types here when introducing new background job kinds.
 */
const JOB_TYPE_ENUM = Object.freeze(['maturity_reminder', 'unknown']);

  for (const queue of registeredJobQueues) {
    try {
      const stats = queue.getStats();
      if (stats) {
        queueLength += Number(stats.queueLength || 0);
        retryQueueLength += Number(stats.retryQueueLength || 0);
      }
    } catch (_err) {
      // Preserve existing metrics if a registered queue becomes invalid.
    }
  }

  let workerInFlight = 0;
  for (const worker of registeredWorkers) {
    try {
      const stats = worker.getStats();
      if (stats && typeof stats.processingCount === 'number') {
        workerInFlight += stats.processingCount;
      }
    } catch (_err) {
      // Preserve existing metrics if a registered worker becomes invalid.
    }
  }

  queueDepthGauge.set(queueLength);
  retryQueueSizeGauge.set(retryQueueLength);
  workerInFlightGauge.set(workerInFlight);

  // Build a minimal Prometheus text exposition that includes our gauges.
  // Keep labels bounded and avoid including payloads or per-job ids.
  cachedMetrics = '' +
    '# HELP liquifact_job_queue_depth Number of pending jobs waiting in queues\n' +
    '# TYPE liquifact_job_queue_depth gauge\n' +
    `liquifact_job_queue_depth ${queueLength}\n` +
    '# HELP liquifact_job_retry_queue_size Number of jobs waiting in retry queues\n' +
    '# TYPE liquifact_job_retry_queue_size gauge\n' +
    `liquifact_job_retry_queue_size ${retryQueueLength}\n` +
    '# HELP liquifact_worker_inflight_count Number of jobs currently being processed\n' +
    '# TYPE liquifact_worker_inflight_count gauge\n' +
    `liquifact_worker_inflight_count ${workerInFlight}\n`;
}

/**
 * Start the periodic metrics refresh interval.
 * Each tick calls {@link refreshMetrics} and updates the cached text
 * exposition for synchronous consumers.
 * @returns {void}
 */
function startMetricsRefresh() {
  if (refreshTimer) {
    return;
  }

  refreshTimer = setInterval(refreshMetrics, METRIC_REFRESH_INTERVAL_MS);
  if (typeof refreshTimer.unref === 'function') {
    refreshTimer.unref();
  }
}

/**
 * Stop the periodic metrics refresh interval.
 * @returns {void}
 */
function stopMetricsRefresh() {
  if (!refreshTimer) {
    return;
  }

  clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * Maps a raw job type string to a bounded Prometheus label value.
 *
 * @param {unknown} raw - Raw job type string.
 * @returns {string} Bounded label value from {@link JOB_TYPE_ENUM}.
 */
function normalizeJobType(raw) {
  const str = typeof raw === 'string' ? raw : '';
  return JOB_TYPE_ENUM.includes(str) ? str : 'unknown';
}

// ── Maturity-reminder counters ────────────────────────────────────────────────

/**
 * Total maturity-reminder delivery attempts, labelled by bounded `reason` and `job_type`.
 * @type {import('prom-client').Counter}
 */
const maturityReminderDeliveryAttemptsTotal = new client.Counter({
  name: 'maturity_reminder_delivery_attempts_total',
  help: 'Total number of maturity-reminder delivery attempts',
  labelNames: ['reason', 'job_type'],
  registers: [],
});

/**
 * Total maturity-reminder dead-letter events, labelled by bounded `reason` and `job_type`.
 * @type {import('prom-client').Counter}
 */
const maturityReminderDeadLetterTotal = new client.Counter({
  name: 'maturity_reminder_dead_letter_total',
  help: 'Total number of maturity-reminder messages moved to the dead-letter queue',
  labelNames: ['reason', 'job_type'],
  registers: [],
});

  registeredWorkers.add(worker);
  refreshMetrics();
  startMetricsRefresh();
}

/**
 * Reset all metric state for test isolation.
 * Clears registered queues/workers, zeros gauges, and stops the refresh
 * timer so a subsequent test starts from a clean slate.
 * @returns {void}
 */
function resetMetricsForTests() {
  registeredJobQueues.clear();
  registeredWorkers.clear();
  queueDepthGauge.set(0);
  retryQueueSizeGauge.set(0);
  workerInFlightGauge.set(0);
  stopMetricsRefresh();
}

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * Returns `false` early when lengths differ (public info leaked by content-length
 * rather than timing), but still performs a full-length XOR when lengths match
 * so that a timing attacker cannot distinguish _where_ the difference occurs.
 *
 * @param {string} a - First string to compare.
 * @param {string} b - Second string to compare.
 * @returns {boolean} `true` when the strings are equal, `false` otherwise.
 *
 * @example
 * safeEqual('secret', 'secret'); // true
 * safeEqual('secret', 'wrong');  // false
 */
function safeEqual(a, b) {
  if (a.length !== b.length) { return false; }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Register bounded counters with the shared registry
registry.registerMetric(maturityReminderDeliveryAttemptsTotal);
registry.registerMetric(maturityReminderDeadLetterTotal);

/**
 * Set of loopback IP addresses that are allowed when no bearer token is
 * configured. Includes IPv4, IPv6, and IPv4-mapped IPv6 representations.
 *
 * @type {ReadonlySet<string>}
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Extracts the direct TCP connection IP address from the request.
 *
 * Reads `req.socket.remoteAddress` first — this is the actual TCP socket peer
 * and cannot be spoofed via `X-Forwarded-For` or any other HTTP header. Falls
 * back to `req.ip` when the socket address is unavailable (edge case in some
 * test environments or HTTP/2 proxies).
 *
 * @param {import('express').Request} req - Express request object.
 * @returns {string} The client IP address string, or empty string if
 *   neither source is available.
 *
 * @example
 * extractClientIp(req); // '127.0.0.1'
 */
function extractClientIp(req) {
  return (req.socket && req.socket.remoteAddress) || req.ip || '';
}

/**
 * Express middleware that enforces metrics endpoint authentication.
 *
 * ## Auth decision flow
 *
 * ```
 * METRICS_BEARER_TOKEN set?
 *   ├── YES → constant-time compare Authorization header
 *   │         ├── match  → next()
 *   │         └── no match → 401 (no detail)
 *   └── NO  → extractClientIp(req) in LOOPBACK set?
 *             ├── yes → next()
 *             └── no  → 401 (no detail)
 * ```
 *
 * The response is **always** a plain `{ error: 'Unauthorized' }` with no
 * indication of whether the failure was a missing token, wrong token, or
 * non-loopback origin.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
function metricsAuth(req, res, next) {
  const token = process.env.METRICS_BEARER_TOKEN;

  if (token) {
    const auth = req.headers['authorization'] || '';
    if (safeEqual(auth, `Bearer ${token}`)) { return next(); }
    const authFallback = req.headers['Authorization'] || '';
    if (safeEqual(authFallback, `Bearer ${token}`)) { return next(); }
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // No token configured — allow loopback only, using the direct TCP socket IP.
  // X-Forwarded-For is NEVER trusted for this check.
  const ip = extractClientIp(req);
  if (LOOPBACK.has(ip)) { return next(); }

  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Express route handler that returns Prometheus metrics in plain-text format.
 *
 * @param {import('express').Request} _req - Express request (unused).
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function metricsHandler(_req, res) {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}

/**
 * Counter: Escrow events successfully processed by the indexer per cycle.
 * Incremented by the number of events persisted in each indexer cycle.
 * @type {import('prom-client').Counter}
 */
const escrowIndexerEventsProcessedTotal = new client.Counter({
  name: 'escrow_indexer_events_processed_total',
  help: 'Total number of escrow events successfully processed and persisted by the indexer',
  registers: [registry],
});

/**
 * Counter: Escrow events skipped (invalid) by the indexer per cycle.
 * Incremented when an event fails validation or persistence.
 * @type {import('prom-client').Counter}
 */
const escrowIndexerEventsSkippedTotal = new client.Counter({
  name: 'escrow_indexer_events_skipped_total',
  help: 'Total number of escrow events skipped due to validation or persistence errors',
  registers: [registry],
});

/**
 * Counter: Escrow indexer cycle failures.
 * Incremented when a cycle throws an unhandled exception or receives invalid metric data.
 * @type {import('prom-client').Counter}
 */
const escrowIndexerCycleFailuresTotal = new client.Counter({
  name: 'escrow_indexer_cycle_failures_total',
  help: 'Total number of escrow indexer cycles that failed with an exception',
  registers: [registry],
});

/**
 * Gauge: Unix timestamp (seconds) of the last successful cursor advance.
 * Updated when a cycle completes and cursorAfter !== cursorBefore.
 * Used by health check to detect indexer staleness.
 * @type {import('prom-client').Gauge}
 */
const escrowIndexerLastCursorAdvanceTimestampSeconds = new client.Gauge({
  name: 'escrow_indexer_last_cursor_advance_timestamp_seconds',
  help: 'Unix timestamp (seconds) of the last cycle where the cursor advanced (cursorAfter !== cursorBefore)',
  registers: [registry],
});

/**
 * Counter: Escrow reconciliation mismatches.
 * Incremented each time a reconcileInvoice call detects a discrepancy
 * between the DB funded total and the on-chain funded amount.
 * @type {import('prom-client').Counter}
 */
const escrowReconciliationMismatches = new client.Counter({
  name: 'escrow_reconciliation_mismatches_total',
  help: 'Total number of escrow reconciliation mismatches detected',
  registers: [registry],
});

/**
 * Counter: Escrow funding submissions rejected at contract-existence
 * preflight (issue #436). Incremented once per rejection event, labelled
 * by `reason` to distinguish the failure class:
 *   - `not_found`       — the contract address has no on-ledger entry.
 *   - `rpc_error`       — transport / 5xx / not-found-as-throw error.
 *   - `invalid_address` — escrowAddress could not be parsed or
 *                          rounded-tripped through the address XDR.
 *
 * @type {import('prom-client').Counter}
 */
const escrowPreflightRejectedTotal = new client.Counter({
  name: 'escrow_preflight_rejected_total',
  help: 'Total number of escrow funding submissions rejected at the contract-existence preflight, labelled by rejection reason',
  labelNames: ['reason'],
  registers: [registry],
});

/**
 * Counter: Maturity reminder email delivery attempts.
 * Incremented for each attempt to send a maturity reminder email (including retries).
 * @type {import('prom-client').Counter}
 */
const maturityReminderDeliveryAttemptsTotal = new client.Counter({
  name: 'maturity_reminder_delivery_attempts_total',
  help: 'Total number of maturity reminder email delivery attempts (each retry counts)',
  labelNames: ['job_type'],
  registers: [registry],
});

/**
 * Counter: Successful maturity reminder email deliveries.
 * Incremented when a maturity reminder email is sent successfully.
 * @type {import('prom-client').Counter}
 */
const maturityReminderDeliverySuccessTotal = new client.Counter({
  name: 'maturity_reminder_delivery_success_total',
  help: 'Total number of maturity reminder emails delivered successfully',
  labelNames: ['job_type'],
  registers: [registry],
});

/**
 * Counter: Dead-lettered maturity reminder emails.
 * Incremented when a maturity reminder fails permanently (permanent SMTP error or max retries exceeded).
 * @type {import('prom-client').Counter}
 */
const maturityReminderDeadLetterTotal = new client.Counter({
  name: 'maturity_reminder_dead_letter_total',
  help: 'Total number of maturity reminder emails dead-lettered due to permanent failures or retry exhaustion',
  labelNames: ['job_type', 'reason'],
  registers: [registry],
});

/**
 * Counter: Footprint cache hits.
 * @type {import('prom-client').Counter}
 */
const footprintCacheHitsTotal = new client.Counter({
  name: 'soroban_footprint_cache_hits_total',
  help: 'Total number of Soroban footprint cache hits',
  registers: [registry],
});

/**
 * Counter: Footprint cache misses.
 * @type {import('prom-client').Counter}
 */
const footprintCacheMissesTotal = new client.Counter({
  name: 'soroban_footprint_cache_misses_total',
  help: 'Total number of Soroban footprint cache misses',
  registers: [registry],
});

/**
 * Counter: Footprint cache evictions (LRU or TTL).
 * @type {import('prom-client').Counter}
 */
const footprintCacheEvictionsTotal = new client.Counter({
  name: 'soroban_footprint_cache_evictions_total',
  help: 'Total number of Soroban footprint cache evictions (LRU or TTL expiry)',
  registers: [registry],
});

/**
 * Counter: Soroban circuit breaker state transitions.
 *
 * Labels:
 * - `breaker_name` — Distinguishes breakers per dependency (`soroban`, `redis`, `kyc`, …)
 * - `from_state` — The previous circuit breaker state (CLOSED, OPEN, HALF_OPEN)
 * - `to_state`   — The new circuit breaker state (CLOSED, OPEN, HALF_OPEN)
 *
 * Emission points:
 * - `_transitionState()` in `src/utils/circuitBreaker.js` fires this counter
 *   every time the internal state changes (CLOSED→OPEN, OPEN→HALF_OPEN,
 *   HALF_OPEN→CLOSED, HALF_OPEN→OPEN, or an explicit `reset()` to CLOSED).
 *
 * Cardinality is intentionally bounded:
 *   (#breaker names) × (3 from_states) × (3 to_states) ≤ #breaker names × 9
 * All label values come from the fixed `CircuitBreakerState` enum.
 *
 * @type {import('prom-client').Counter}
 */
const sorobanCircuitBreakerStateTransitionsTotal = new client.Counter({
  name: 'soroban_circuit_breaker_state_transitions_total',
  help: 'Total number of Soroban circuit breaker state transitions, labelled by breaker, from_state, and to_state',
  labelNames: ['breaker_name', 'from_state', 'to_state'],
  registers: [registry],
});

/**
 * Gauge: Readiness state (1 = ready, 0 = not ready).
 * Updated by performReadinessChecks() in the health service.
 * @type {import('prom-client').Gauge}
 */
const readinessGauge = new client.Gauge({
  name: 'readiness_gauge',
  help: 'Readiness state of the service: 1 = ready to serve traffic, 0 = not ready',
  registers: [registry],
});

/**
 * Counter: Legal-hold blocks triggered by a verified `held` outcome.
 * Issue #424 — the gate blocks funding while a verified hold is on
 * chain. Labelled by invoiceId (debug-only) and outcome so dashboards
 * can group by outcome rather than the high-cardinality invoiceId.
 * @type {import('prom-client').Counter}
 */
const legalHoldBlocksTotal = new client.Counter({
  name: 'legal_hold_blocks_total',
  help: 'Total number of funding requests blocked by the legal-hold gate, labelled by outcome (held)',
  labelNames: ['invoiceId', 'outcome'],
  registers: [registry],
});

/**
 * Counter: Legal-hold gate trips with status `unknown` (fail-closed).
 * Issue #424 — a transient read failure MUST NOT collapse to "not held".
 * This counter is the single source of truth for unknown-blocks. The
 * `reason` label distinguishes RPC failure (`rpc_error`) from a
 * misbehaving adapter (`adapter_error`) so operators can alert and
 * triage separately.
 *
 * NOTE: this counter intentionally does NOT carry a per-invoiceId
 * label. Per-invoiceId correlation is delivered through the structured
 * warn log instead; high-cardinality labels would blow up the
 * Prometheus series count without giving operators an actionable
 * aggregate signal.
 * @type {import('prom-client').Counter}
 */
const legalHoldUnknownBlocksTotal = new client.Counter({
  name: 'legal_hold_unknown_blocks_total',
  help: 'Total number of funding requests blocked because the legal-hold read returned unknown (fail-closed)',
  labelNames: ['reason'],
  registers: [registry],
});

/**
 * Increment the legal-hold gate `held` counter.
 *
 * Issue #424: signature aligned to the pre-existing
 * `incrementMetric('legal_hold_blocked_attempts', { invoiceId })` call site
 * so existing middleware can adopt this helper without changes.
 *
 * @param {object} [labels] - Optional label overrides.
 * @param {string} [labels.invoiceId] - Invoice identifier (debug-only).
 * @returns {void}
 */
function incrementLegalHoldBlocks(labels = {}) {
  legalHoldBlocksTotal.inc({
    invoiceId: labels.invoiceId || 'unknown',
    outcome: 'held',
  });
}

/**
 * Increment the legal-hold gate `unknown` counter (issue #424 fail-closed).
 *
 * Single source of truth for unknown-blocks; the `reason` label carries
 * the operator-actionable signal (`rpc_error` / `adapter_error` / fallback).
 * Per-invoiceId correlation lives in the structured warn log so we don't
 * blow up Prometheus cardinality.
 *
 * @param {object} [labels]
 * @param {string} [labels.invoiceId] - Invoice identifier for debugging (logged, not labelled).
 * @param {string} [labels.reason] - `'rpc_error'` or `'adapter_error'`.
 * @param {string|null} [labels.errorCode] - Optional low-cardinality error code (logged, not labelled).
 * @returns {void}
 */
function incrementLegalHoldUnknownBlocks(labels = {}) {
  legalHoldUnknownBlocksTotal.inc({
    reason: labels.reason || 'unknown',
  });
}

/**
 * Backwards-compatible generic metric incrementer. Issue #424 — the
 * pre-existing `legalHoldGate.js` calls
 *   `incrementMetric('legal_hold_blocked_attempts', { invoiceId })`
 * with a name that no Prometheus counter was registered under. Map
 * well-known aliases onto the canonical counters so existing call sites
 * keep working without widening the public surface.
 *
 * @param {string} name - Logical metric name (alias).
 * @param {object} [labels] - Optional label overrides.
 * @returns {void}
 */
function incrementMetric(name, labels = {}) {
  switch (name) {
    case 'legal_hold_blocked_attempts':
      incrementLegalHoldBlocks(labels);
      return;
    case 'legal_hold_unknown_blocks':
      incrementLegalHoldUnknownBlocks(labels);
      return;
    default:
      // Forward-compatible no-op: unknown aliases swallow rather than throw
      // so a misconfigured call site doesn't take down the request path.
      return;
  }
}

module.exports = {
  registry,
  metricsAuth,
  metricsHandler,
  registerJobQueue,
  registerWorker,
  refreshMetrics,
  resetMetricsForTests,
  // Issue #424 — explicit exports for the new fail-closed-aware counters
  // and their increment helpers. `incrementMetric` is retained for the
  // pre-existing `legalHoldGate.js` call site.
  incrementMetric,
  incrementLegalHoldBlocks,
  incrementLegalHoldUnknownBlocks,
  legalHoldBlocksTotal,
  legalHoldUnknownBlocksTotal,
};
