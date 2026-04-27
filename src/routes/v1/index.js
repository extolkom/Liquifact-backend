/**
 * V1 API Routes
 */

'use strict';

const express = require('express');
const router = express.Router();
const investRoutes = require('../invest');
const smeRouter = require('../sme');

// Health endpoint
router.get('/health', (req, res) => {
  return res.json({
    status: 'ok',
    service: 'liquifact-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// API info
router.get('/', (req, res) => {
  return res.json({
    name: 'LiquiFact API',
    description: 'Global Invoice Liquidity Network on Stellar',
    version: 'v1',
    endpoints: {
      health: 'GET /v1/health',
      invoices: 'GET/POST /v1/invoices',
      escrow: 'GET/POST /v1/escrow',
      sme: 'POST /v1/sme/invoice',
    },
  });
});

// Mount sub-routers
router.use('/invest', investRoutes);
router.use('/sme', smeRouter);

// In-memory invoices for demo (move to DB later)
let invoices = [];

// Invoices routes
router.get('/invoices', (req, res) => {
  const includeDeleted = req.query.includeDeleted === 'true';
  const filteredInvoices = includeDeleted
    ? invoices
    : invoices.filter((inv) => !inv.deletedAt);

  return res.json({
    data: filteredInvoices,
    message: includeDeleted ? 'Showing all invoices (including deleted).' : 'Showing active invoices.',
  });
});

router.post('/invoices', (req, res) => {
  const { amount, customer } = req.body;

  if (!amount || !customer) {
    return res.status(400).json({ error: 'Amount and customer are required' });
  }

  const newInvoice = {
    id: `inv_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    amount,
    customer,
    status: 'pending_verification',
    createdAt: new Date().toISOString(),
    deletedAt: null,
  };

  invoices.push(newInvoice);

  return res.status(201).json({
    data: newInvoice,
    message: 'Invoice created successfully.',
  });
});

// TODO: Add more routes as needed

module.exports = router;