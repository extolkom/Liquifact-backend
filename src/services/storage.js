const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT, // for S3-compatible like MinIO
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true, // for MinIO compatibility
});

class StorageService {
  constructor() {
    this.bucket = process.env.S3_BUCKET || 'liquifact-invoices';
  }

  /**
   * Upload a file to S3-compatible storage
   * @param {Buffer} fileBuffer - File buffer
   * @param {string} fileName - File name
   * @param {string} mimeType - MIME type
   * @returns {Promise<string>} - Object key
   */
  async uploadFile(fileBuffer, fileName, mimeType) {
    const key = `invoices/${crypto.randomUUID()}-${fileName}`;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
      // TODO: Add virus scan hook here
    });
    await s3Client.send(command);
    return key;
  }

  /**
   * Generate signed URL for file access
   * @param {string} key - Object key
   * @param {number} expiresIn - Expiry in seconds
   * @returns {Promise<string>} - Signed URL
   */
  async getSignedUrl(key, expiresIn = 3600) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return await getSignedUrl(s3Client, command, { expiresIn });
  }
}

module.exports = new StorageService();