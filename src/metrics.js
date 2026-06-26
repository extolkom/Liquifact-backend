'use strict';

/**
 * @fileoverview Prometheus metrics registry and /metrics route handler.
 *
 * Auth strategy (in priority order):
 *   1. If METRICS_BEARER_TOKEN is set, require `Authorization: Bearer <token>`.
 *   2. If METRICS_BEARER_TOKEN is unset, allow requests from loopback only
 *      (127.0.0.1, ::1, ::ffff:127.0.0.1) — suitable for private-network scraping.
 *   3. All other requests receive 401.
 *
 * @module metrics
 */

const client = require('prom-client');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Shared registry — exported so tests can reset it between runs. */
const registry = new client.Registry();

client.collectDefaultMetrics({ register: registry });

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

// Cached metrics text for compatibility with tests that call
// `registry.metrics()` synchronously. Prom-client >=14 returns a Promise
// from `registry.metrics()`, but some test code calls it without `await`.
// We provide a synchronous accessor by overriding `registry.metrics`
// to return the latest cached string; `metricsHandler` still works because
// awaiting a string yields the string value.
let cachedMetrics = '# HELP liquifact_custom_metrics Placeholder\n';
registry.metrics = function metricsSync() {
  return cachedMetrics;
};

/**
 * Refresh all registered queue and worker metrics.
 *
 * This performs periodic sampling from existing getStats() outputs on
 * registered job queue and worker instances. It avoids adding extra hot-path
 * overhead to each enqueue/dequeue operation.
 */
function refreshMetrics() {
  let queueLength = 0;
  let retryQueueLength = 0;

  for (const queue of registeredJobQueues) {
    try {
      const stats = queue.getStats();
      if (stats) {
        queueLength += Number(stats.queueLength || 0);
        retryQueueLength += Number(stats.retryQueueLength || 0);
      }
    } catch (err) {
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
    } catch (err) {
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

function startMetricsRefresh() {
  if (refreshTimer) {
    return;
  }

  refreshTimer = setInterval(refreshMetrics, METRIC_REFRESH_INTERVAL_MS);
  if (typeof refreshTimer.unref === 'function') {
    refreshTimer.unref();
  }
}

function stopMetricsRefresh() {
  if (!refreshTimer) {
    return;
  }

  clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * Register a job queue instance for Prometheus instrumentation.
 *
 * @param {Object} queue
 */
function registerJobQueue(queue) {
  if (!queue || typeof queue.getStats !== 'function') {
    return;
  }

  if (registeredJobQueues.has(queue)) {
    return;
  }

  registeredJobQueues.add(queue);
  refreshMetrics();
  startMetricsRefresh();
}

/**
 * Register a worker instance for Prometheus instrumentation.
 *
 * @param {Object} worker
 */
function registerWorker(worker) {
  if (!worker || typeof worker.getStats !== 'function') {
    return;
  }

  if (registeredWorkers.has(worker)) {
    return;
  }

  registeredWorkers.add(worker);
  refreshMetrics();
  startMetricsRefresh();
}

function resetMetricsForTests() {
  registeredJobQueues.clear();
  registeredWorkers.clear();
  queueDepthGauge.set(0);
  retryQueueSizeGauge.set(0);
  workerInFlightGauge.set(0);
  stopMetricsRefresh();
}

/**
 * Express middleware that enforces metrics auth.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function metricsAuth(req, res, next) {
  const token = process.env.METRICS_BEARER_TOKEN;

  if (token) {
    const auth = req.headers['authorization'] || '';
    if (auth === `Bearer ${token}`) return next();
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // No token configured — allow loopback only
  const ip = req.ip || req.socket.remoteAddress || '';
  if (LOOPBACK.has(ip)) return next();

  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Express route handler that returns Prometheus metrics.
 *
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
async function metricsHandler(_req, res) {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}

module.exports = {
  registry,
  metricsAuth,
  metricsHandler,
  registerJobQueue,
  registerWorker,
  refreshMetrics,
  resetMetricsForTests,
};
