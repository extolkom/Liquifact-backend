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

/**
 * Parses a human-readable size string (e.g. "512kb", "1mb") to bytes.
 *
 * @param {string} sizeStr - Human-readable size string.
 * @returns {number} Equivalent size in bytes.
 */
function parseSize(sizeStr) {
  if (typeof sizeStr !== 'string' || sizeStr.trim() === '') {
    return DEFAULT_MAX_FILE_SIZE;
  }
  const match = sizeStr.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) {
    return DEFAULT_MAX_FILE_SIZE;
  }
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.floor(value * multipliers[unit]);
}

/** Resolved maximum file size from environment or default. */
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
  }

  /**
   * Sanitizes a filename to prevent path traversal.
   * Strips directory separators, null bytes, .. sequences, and special characters.
   *
   * @param {string} filename - Raw filename from user input.
   * @returns {string} Sanitized filename safe for S3 key generation.
   */
  _sanitizeFilename(filename) {
    if (!filename || typeof filename !== 'string') {
      return 'unnamed';
    }
    let name = filename.replace(/\\/g, '/');
    name = path.basename(name);
    name = name.replace(/\0/g, '');
    name = name.replace(/\.\./g, '');
    name = name.replace(/[<>:"|?*\\/]/g, '_');
    return name.slice(0, 255) || 'unnamed';
  }

  /**
   * Validates that the MIME type is in the allowed list.
   *
   * @param {string} mimeType - MIME type to validate.
   * @returns {boolean} True if the MIME type is allowed.
   */
  _validateMimeType(mimeType) {
    return ALLOWED_MIME_TYPES.includes(mimeType);
  }

  /**
   * Generates a tenant/invoice-scoped S3 object key.
   * Format: tenants/{tenantId}/invoices/{invoiceId}/{uuid}-{safeName}
   *
   * @param {string} tenantId - Tenant identifier.
   * @param {string} invoiceId - Invoice identifier.
   * @param {string} safeName - Sanitized filename.
   * @returns {string} S3 object key.
   */
  _generateKey(tenantId, invoiceId, safeName) {
    const uuid = crypto.randomUUID();
    return `tenants/${tenantId}/invoices/${invoiceId}/${uuid}-${safeName}`;
  }

  /**
   * Uploads a file buffer to S3 with MIME type and size validation.
   *
   * @param {Buffer} fileBuffer - File data buffer.
   * @param {string} fileName - Original filename (will be sanitized).
   * @param {string} mimeType - MIME type of the file.
   * @param {string} [tenantId='unknown'] - Tenant identifier.
   * @param {string} [invoiceId='unknown'] - Invoice identifier.
   * @returns {Promise<string>} S3 object key of the uploaded file.
   * @throws {Error} With code FILE_TOO_LARGE if file exceeds size limit.
   * @throws {Error} With code INVALID_MIME_TYPE if MIME type is rejected.
   */
  async uploadFile(fileBuffer, fileName, mimeType, tenantId = 'unknown', invoiceId = 'unknown') {
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

  /**
   * Generates a presigned upload URL with content type and size constraints.
   * URL expiry is set to DEFAULT_UPLOAD_URL_EXPIRY_SEC (15 minutes).
   *
   * @param {object} options - Upload URL options.
   * @param {string} options.tenantId - Tenant identifier.
   * @param {string} options.invoiceId - Invoice identifier.
   * @param {string} options.fileName - Original filename (will be sanitized).
   * @param {string} options.mimeType - MIME type of the file.
   * @param {number} options.fileSize - File size in bytes.
   * @returns {Promise<{url: string, key: string}>} Presigned URL and S3 object key.
   * @throws {Error} With code INVALID_MIME_TYPE if MIME type is rejected.
   * @throws {Error} With code FILE_TOO_LARGE if file size exceeds limit.
   */
  async getPresignedUploadUrl({ tenantId, invoiceId, fileName, mimeType, fileSize }) {
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

    const url = await getSignedUrl(s3Client, command, {
      expiresIn: DEFAULT_UPLOAD_URL_EXPIRY_SEC,
    });
    return { url, key };
  }

  /**
   * Generates a presigned download URL for an S3 object.
   * Expiry is clamped to [1, MAX_DOWNLOAD_URL_EXPIRY_SEC].
   *
   * @param {string} key - S3 object key.
   * @param {number} [expiresIn=DEFAULT_DOWNLOAD_URL_EXPIRY_SEC] - URL expiry in seconds.
   * @returns {Promise<string>} Presigned download URL.
   */
  async getSignedUrl(key, expiresIn = DEFAULT_DOWNLOAD_URL_EXPIRY_SEC) {
    const safeExpiry = Math.min(Math.max(Math.floor(expiresIn), 1), MAX_DOWNLOAD_URL_EXPIRY_SEC);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return await getSignedUrl(s3Client, command, { expiresIn: safeExpiry });
  }
}

module.exports = new StorageService();
module.exports.StorageService = StorageService;
module.exports.ALLOWED_MIME_TYPES = ALLOWED_MIME_TYPES;
module.exports.DEFAULT_MAX_FILE_SIZE = DEFAULT_MAX_FILE_SIZE;
