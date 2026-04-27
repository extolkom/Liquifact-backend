/**
 * SME Routes Index
 */

'use strict';

const express = require('express');
const router = express.Router();
const metricsRoutes = require('./metrics');
const multer = require('multer');
const storageService = require('../../services/storage');

const upload = multer({ storage: multer.memoryStorage() });

router.use('/', metricsRoutes);

// POST /api/sme/invoice - Upload PDF invoice
router.post('/invoice', upload.single('invoice'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Invoice file is required' });
    }

    // Validate file type (PDF)
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF files are allowed' });
    }

    // Upload to storage
    const key = await storageService.uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);

    // TODO: Save metadata to DB (invoice_id, file_key, uploaded_at, etc.)

    // Generate signed URL for access
    const signedUrl = await storageService.getSignedUrl(key);

    res.json({
      message: 'Invoice uploaded successfully',
      fileKey: key,
      signedUrl,
      // TODO: Add virus scan status
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload invoice' });
  }
});

module.exports = router;
