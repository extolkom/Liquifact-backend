'use strict';

const crypto = require('crypto');
const db = require('../db/knex');
const logger = require('../logger');

const SIGNATURE_VERSION = 'v1';
const TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Creates an HMAC-SHA256 signature for the given payload and timestamp.
 *
 * @param {string} secret - The webhook secret.
 * @param {string} rawBody - The raw JSON payload string.
 * @param {number} timestamp - Unix timestamp in seconds.
 * @returns {string} The hex-encoded signature.
 */
function createSignature(secret, rawBody, timestamp) {
  const signedPayload = `${timestamp}.${rawBody}`;
  return crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
}

/**
 * Creates a signature header in the format t=<timestamp>,v1=<signature>.
 *
 * @param {string} secret - The webhook secret.
 * @param {string} rawBody - The raw JSON payload string.
 * @returns {string} The signature header string.
 */
function createSignatureHeader(secret, rawBody) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createSignature(secret, rawBody, timestamp);
  return `t=${timestamp},v1=${signature}`;
}

/**
 * Emits a webhook for escrow events.
 *
 * @param {string} event - The event type ('escrow_funded' or 'escrow_settled').
 * @param {string} invoiceId - The invoice ID.
 * @param {Object} [additionalData={}] - Additional data to include in the payload.
 * @returns {Promise<void>}
 */
async function emitWebhook(event, invoiceId, additionalData = {}) {
  try {
    const invoice = await db('invoices').select('tenant_id').where('id', invoiceId).first();
    if (!invoice) {
      logger.warn({ invoiceId }, 'Invoice not found for webhook emission');
      return;
    }

    const { tenant_id } = invoice;

    const tenant = await db('tenants').select('settings').where('id', tenant_id).first();
    if (!tenant || !tenant.settings) {
      logger.warn({ tenant_id, invoiceId }, 'Tenant settings not found for webhook');
      return;
    }

    const { webhook_url, webhook_secret } = tenant.settings;
    if (!webhook_url || !webhook_secret) {
      logger.info({ tenant_id, invoiceId }, 'Webhook URL or secret not configured');
      return;
    }

    const payload = {
      event,
      timestamp: new Date().toISOString(),
      invoiceId,
      ...additionalData,
    };

    // Sign payload
    const body = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', webhook_secret).update(body).digest('hex');

    // Send webhook with native fetch and 5s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    let response;
    try {
      response = await fetch(webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`Webhook responded with ${response.status}`);
    }

    logger.info({ event, invoiceId, tenant_id }, 'Webhook emitted successfully');
  } catch (error) {
    logger.error({ event, invoiceId, error: error.message }, 'Failed to emit webhook');
  }
}

/**
 * Verifies a webhook signature with timestamp tolerance.
 *
 * @param {string} secret - The webhook secret.
 * @param {string} rawBody - The raw JSON payload string.
 * @param {string} signatureHeader - The X-Signature header value.
 * @param {number} [toleranceMs=TOLERANCE_MS] - Tolerance window in milliseconds.
 * @returns {Object} Result object with valid boolean and optional error message.
 */
function verifySignature(secret, rawBody, signatureHeader, toleranceMs = TOLERANCE_MS) {
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
    return { valid: false, error: 'Invalid signature header format' };
  }

  const now = Date.now();
  const timestampMs = timestamp * 1000;
  if (Math.abs(now - timestampMs) > toleranceMs) {
    return { valid: false, error: 'Timestamp outside tolerance window' };
  }

  const expectedSignature = createSignature(secret, rawBody, timestamp);
  const valid = crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );

  return { valid, error: valid ? null : 'Signature mismatch' };
}

/**
 * Writes a failed webhook delivery to the dead-letter table.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.invoiceId
 * @param {string} params.event
 * @param {Object} params.payload
 * @param {string} params.webhookUrl
 * @param {number} params.attempts
 * @param {string} params.lastError
 * @returns {Promise<string>} The new dead-letter row id.
 */
async function writeDeadLetter({ tenantId, invoiceId, event, payload, webhookUrl, attempts, lastError }) {
  const [row] = await db('webhook_dead_letters')
    .insert({
      tenant_id: tenantId,
      invoice_id: invoiceId,
      event,
      payload: JSON.stringify(payload),
      webhook_url: webhookUrl,
      attempts,
      last_error: lastError,
    })
    .returning('id');
  return row?.id ?? row;
}

/**
 * Replays a dead-letter row by re-signing and re-sending the stored payload.
 * On success the row is marked resolved. Throws on delivery failure.
 *
 * @param {string} deadLetterId - The `webhook_dead_letters.id` to replay.
 * @returns {Promise<void>}
 */
async function replayWebhook(deadLetterId) {
  const row = await db('webhook_dead_letters').where('id', deadLetterId).first();
  if (!row) {
    throw Object.assign(new Error(`Dead-letter row not found: ${deadLetterId}`), { code: 'NOT_FOUND' });
  }
  if (row.resolved) {
    throw Object.assign(new Error(`Dead-letter row already resolved: ${deadLetterId}`), { code: 'ALREADY_RESOLVED' });
  }

  const tenant = await db('tenants').select('settings').where('id', row.tenant_id).first();
  const secret = tenant?.settings?.webhook_secret;
  if (!secret) {
    throw new Error(`No webhook secret configured for tenant ${row.tenant_id}`);
  }

  const body = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
  const signatureHeader = createSignatureHeader(secret, body);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  let response;
  try {
    response = await fetch(row.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signatureHeader,
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Webhook replay responded with ${response.status}`);
  }

  await resolveDeadLetter(deadLetterId);
  logger.info({ deadLetterId, webhook_url: row.webhook_url }, 'Webhook replayed successfully');
}

/**
 * Marks a dead-letter row as resolved without re-sending.
 *
 * @param {string} deadLetterId
 * @returns {Promise<void>}
 */
async function resolveDeadLetter(deadLetterId) {
  await db('webhook_dead_letters').where('id', deadLetterId).update({
    resolved: true,
    resolved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

module.exports = {
  emitWebhook,
  verifySignature,
  createSignature,
  createSignatureHeader,
  writeDeadLetter,
  replayWebhook,
  resolveDeadLetter,
  SIGNATURE_VERSION,
  TOLERANCE_MS,
};