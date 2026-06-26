/**
 * S3-compatible storage service for invoice file uploads and presigned URLs.
 * Handles MIME validation, size enforcement, tenant scoping, and path traversal prevention.
 *
 * @module services/storage
 */

'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const path = require('path');
const db = require('../db/knex');

/** Accepted MIME types for invoice uploads. */
const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'];

/** Default maximum file size (512 KB). */
const DEFAULT_MAX_FILE_SIZE = 512 * 1024;

/** Presigned upload URL expiry (15 minutes). */
const DEFAULT_UPLOAD_URL_EXPIRY_SEC = 900;

/** Presigned download URL expiry (1 hour). */
const DEFAULT_DOWNLOAD_URL_EXPIRY_SEC = 3600;

/** Maximum allowed presigned URL expiry (24 hours). */
const MAX_DOWNLOAD_URL_EXPIRY_SEC = 86400;

function parseSize(sizeStr) {
  if (typeof sizeStr !== 'string' || sizeStr.trim() === '') {
    return DEFAULT_MAX_FILE_SIZE;
  }
  const match = sizeStr.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) return DEFAULT_MAX_FILE_SIZE;
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.floor(value * multipliers[unit]);
}

const MAX_FILE_SIZE = parseSize(process.env.BODY_LIMIT_INVOICE || '512kb');

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

class StorageService {
  constructor() {
    this.bucket = process.env.S3_BUCKET || 'liquifact-invoices';
    this.maxFileSize = MAX_FILE_SIZE;
    this._inMemoryStore = new Map();
  }

  _sanitizeFilename(filename) {
    if (!filename || typeof filename !== 'string') {
      const err = new Error('Invalid filename');
      err.code = 'INVALID_FILENAME';
      throw err;
    }

    const normalized = path.posix.normalize(filename);

    if (normalized.includes('..') || normalized.startsWith('/') || normalized.startsWith('\\')) {
      const err = new Error('Path traversal detected');
      err.code = 'INVALID_FILENAME';
      throw err;
    }

    let name = path.basename(normalized);
    name = name.replace(/\0/g, '');
    name = name.replace(/[<>:\"|?*\\/]/g, '_');
    return name.slice(0, 255);
  }

  _validateMimeType(mimeType) {
    return ALLOWED_MIME_TYPES.includes(mimeType);
  }

  _validateTenantId(tenantId) {
    return typeof tenantId === 'string' && /^[a-zA-Z0-9_-]+$/.test(tenantId);
  }

  _validateInvoiceId(invoiceId) {
    return typeof invoiceId === 'string' && /^[a-zA-Z0-9_-]+$/.test(invoiceId);
  }

  _generateKey(tenantId, invoiceId, safeName) {
    if (!this._validateTenantId(tenantId)) {
      const err = new Error('Invalid tenant ID');
      err.code = 'INVALID_TENANT_ID';
      throw err;
    }
    if (!this._validateInvoiceId(invoiceId)) {
      const err = new Error('Invalid invoice ID');
      err.code = 'INVALID_INVOICE_ID';
      throw err;
    }

    const uuid = crypto.randomUUID();
    return `tenants/${tenantId}/invoices/${invoiceId}/${uuid}-${safeName}`;
  }

  async uploadFile(fileBuffer, fileName, mimeType, tenantId = 'unknown', invoiceId = 'unknown') {
    if (!this._validateTenantId(tenantId)) {
      const err = new Error('Invalid tenant ID');
      err.code = 'INVALID_TENANT_ID';
      throw err;
    }

    if (!this._validateInvoiceId(invoiceId)) {
      const err = new Error('Invalid invoice ID');
      err.code = 'INVALID_INVOICE_ID';
      throw err;
    }

    if (fileBuffer.length > this.maxFileSize) {
      const err = new Error(`File size ${fileBuffer.length} exceeds maximum of ${this.maxFileSize} bytes`);
      err.code = 'FILE_TOO_LARGE';
      throw err;
    }

    if (!this._validateMimeType(mimeType)) {
      const err = new Error(`Invalid MIME type: "${mimeType}". Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`);
      err.code = 'INVALID_MIME_TYPE';
      throw err;
    }

    const safeName = this._sanitizeFilename(fileName);
    const key = this._generateKey(tenantId, invoiceId, safeName);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
    });
    await s3Client.send(command);
    return key;
  }

  async getPresignedUploadUrl({ tenantId, invoiceId, fileName, mimeType, fileSize }) {
    if (!this._validateTenantId(tenantId)) {
      const err = new Error('Invalid tenant ID');
      err.code = 'INVALID_TENANT_ID';
      throw err;
    }
    if (!this._validateInvoiceId(invoiceId)) {
      const err = new Error('Invalid invoice ID');
      err.code = 'INVALID_INVOICE_ID';
      throw err;
    }
    if (!this._validateMimeType(mimeType)) {
      const err = new Error(`Invalid MIME type: "${mimeType}". Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`);
      err.code = 'INVALID_MIME_TYPE';
      throw err;
    }
    if (fileSize > this.maxFileSize) {
      const err = new Error(`File size ${fileSize} exceeds maximum of ${this.maxFileSize} bytes`);
      err.code = 'FILE_TOO_LARGE';
      throw err;
    }

    const safeName = this._sanitizeFilename(fileName);
    const key = this._generateKey(tenantId, invoiceId, safeName);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: mimeType,
      ContentLength: fileSize,
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn: DEFAULT_UPLOAD_URL_EXPIRY_SEC });
    return { url, key };
  }

  async getSignedUrl(key, expiresIn = DEFAULT_DOWNLOAD_URL_EXPIRY_SEC) {
    const expiry = Math.floor(expiresIn);
    if (expiry < 1 || expiry > MAX_DOWNLOAD_URL_EXPIRY_SEC) {
      const err = new Error(`Expiry must be between 1 and ${MAX_DOWNLOAD_URL_EXPIRY_SEC} seconds`);
      err.code = 'INVALID_EXPIRY';
      throw err;
    }
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return await getSignedUrl(s3Client, command, { expiresIn: expiry });
  }

  async saveMetadata({ tenantId, invoiceId, key, sha256, mimeType, size }) {
    const now = new Date().toISOString();
    await db('invoice_files').insert({
      tenant_id: tenantId,
      invoice_id: invoiceId,
      s3_key: key,
      sha256,
      mime_type: mimeType,
      size,
      created_at: now,
    });
  }

  async getMetadata({ tenantId, invoiceId }) {
    return await db('invoice_files').where({ tenant_id: tenantId, invoice_id: invoiceId }).first();
  }

  generateKey({ tenantId, invoiceId, fileName }) {
    const safeName = this._sanitizeFilename(fileName);
    return this._generateKey(tenantId, invoiceId, safeName);
  }

  async uploadFileInMemory({ key, body, mimeType }) {
    if (process.env.NODE_ENV === 'test') {
      this._inMemoryStore.set(key, { body, mimeType });
      return;
    }
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mimeType });
    await s3Client.send(command);
  }

  async getFile({ key }) {
    if (process.env.NODE_ENV === 'test') {
      const entry = this._inMemoryStore.get(key);
      if (!entry) { throw new Error('File not found'); }
      return entry.body;
    }
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const response = await s3Client.send(command);
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}

module.exports.StorageService = StorageService;
module.exports.ALLOWED_MIME_TYPES = ALLOWED_MIME_TYPES;
module.exports.DEFAULT_MAX_FILE_SIZE = DEFAULT_MAX_FILE_SIZE;
