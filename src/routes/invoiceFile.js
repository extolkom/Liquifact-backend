/**
 * @fileoverview Invoice File Operations with Integrity Verification using durable storage.
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const storageService = require('../services/storage');
const logger = require('../logger');
const router = express.Router();

const invoiceFiles = new Map();

/**
 * Computes the SHA-256 hash of a buffer.
 * @param {Buffer} buffer The input buffer.
 * @returns {string} The SHA-256 hash as a hexadecimal string.
 */
function computeHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * POST /api/invoices/:id/presigned-upload
 * Generate a presigned upload URL scoped to this invoice.
 */
router.post('/:id/presigned-upload', express.json(), async (req, res) => {
  const { id } = req.params;
  if (!id || typeof id !== 'string' || id.trim() === '') {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid invoice ID' });
  }
  try {
    const { fileName, mimeType, fileSize } = req.body;
    if (!fileName || !mimeType || fileSize == null) {
      return res.status(400).json({ error: 'Bad Request', message: 'fileName, mimeType, and fileSize are required' });
    }
    const tenantId = req.user?.id || req.user?.sub || 'unknown';
    const result = await storageService.getPresignedUploadUrl({ tenantId, invoiceId: id, fileName, mimeType, fileSize });
    return res.status(201).json({ data: { invoiceId: id, uploadUrl: result.url, fileKey: result.key }, message: 'Presigned upload URL generated' });
  } catch (error) {
    if (['INVALID_MIME_TYPE','FILE_TOO_LARGE','INVALID_FILENAME','INVALID_TENANT_ID','INVALID_INVOICE_ID','INVALID_EXPIRY'].includes(error.message)) {
      return res.status(400).json({ error: 'Bad Request', message: error.message });
    }
    logger.error({ err: error, invoiceId: id }, 'Failed to generate presigned upload URL');
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to generate presigned upload URL' });
  }
});

/**
 * POST /api/invoices/:id/file
 * Upload PDF file for an invoice and persist it.
 */
router.post('/:id/file', express.raw({ type: 'application/pdf', limit: '5mb' }), async (req, res) => {
  const { id } = req.params;
  if (!id || typeof id !== 'string' || id.trim() === '') {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid invoice ID' });
  }
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.includes('application/pdf')) {
    return res.status(400).json({ error: 'Bad Request', message: 'Content-Type must be application/pdf' });
  }
  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'No file data provided' });
  }
  const fileHash = computeHash(req.body);
  const fileSize = req.body.length;
  const tenantId = req.user?.id || req.user?.sub || 'unknown';
  // Generate storage key using helper
  const key = storageService.generateKey({ tenantId, invoiceId: id, fileName: `${Date.now()}.pdf` });
  try {
    await storageService.uploadFile({ key, body: req.body, mimeType: 'application/pdf' });
    await storageService.saveMetadata({ tenantId, invoiceId: id, key, sha256: fileHash, mimeType: 'application/pdf', size: fileSize });
    const uploadedAt = new Date().toISOString();
    return res.status(201).json({ data: { invoiceId: id, fileHash, fileSize, uploadedAt, storageKey: key }, message: 'Invoice file uploaded successfully' });
  } catch (err) {
    logger.error({ err, invoiceId: id }, 'Failed to upload invoice file');
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to store invoice file' });
  }
});

/**
 * GET /api/invoices/:id/file
 * Retrieve the PDF file for an invoice.
 */
router.get('/:id/file', async (req, res) => {
  const { id } = req.params;
  if (!id || typeof id !== 'string' || id.trim() === '') {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid invoice ID' });
  }
  const tenantId = req.user?.id || req.user?.sub || 'unknown';
  const meta = await storageService.getMetadata({ tenantId, invoiceId: id });
  if (!meta) {
    return res.status(404).json({ error: 'Not Found', message: `No file found for invoice ${id}` });
  }
  try {
    const fileData = await storageService.getFile({ key: meta.key });
    res.set('Content-Type', meta.mimeType);
    res.set('Content-Length', meta.size);
    res.set('X-File-Hash', meta.sha256);
    return res.send(fileData);
  } catch (err) {
    logger.error({ err, invoiceId: id }, 'Failed to retrieve invoice file');
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to retrieve invoice file' });
  }
});

/**
 * GET /api/invoices/:id/file/verify
 * Verify integrity of uploaded PDF by comparing stored hash with freshly computed hash.
 */
router.get('/:id/file/verify', async (req, res) => {
  const { id } = req.params;
  if (!id || typeof id !== 'string' || id.trim() === '') {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid invoice ID' });
  }
  const tenantId = req.user?.id || req.user?.sub || 'unknown';
  const meta = await storageService.getMetadata({ tenantId, invoiceId: id });
  if (!meta) {
    return res.status(404).json({ error: 'Not Found', message: `No file found for invoice ${id}` });
  }
  try {
    const fileData = await storageService.getFile({ key: meta.key });
    const currentHash = computeHash(fileData);
    const isValid = currentHash === meta.sha256;
    return res.json({ data: { invoiceId: id, isValid, storedHash: meta.sha256, currentHash, verifiedAt: new Date().toISOString() }, message: isValid ? 'File integrity verified' : 'File integrity check failed' });
  } catch (err) {
    logger.error({ err, invoiceId: id }, 'Failed to verify invoice file');
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to verify invoice file' });
  }
});

/**
 * POST /api/invoices/:id/file/verify
 * Verify integrity of a provided PDF against stored hash.
 */
router.post('/:id/file/verify', express.raw({ type: 'application/pdf', limit: '5mb' }), async (req, res) => {
  const { id } = req.params;
  if (!id || typeof id !== 'string' || id.trim() === '') {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid invoice ID' });
  }
  const tenantId = req.user?.id || req.user?.sub || 'unknown';
  const meta = await storageService.getMetadata({ tenantId, invoiceId: id });
  if (!meta) {
    return res.status(404).json({ error: 'Not Found', message: `No file found for invoice ${id}` });
  }
  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'No file data provided for verification' });

