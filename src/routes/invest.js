/**
 * src/routes/invest.js
 *
 * Routes:
 *   GET  /api/invest/opportunities   — list open investment opportunities
 *   POST /api/invest/fund-invoice    — fund an invoice via the LiquifactEscrow contract
 *
 * The fund-invoice handler replaces the previous hardcoded mock and now:
 *   1. Validates request body
 *   2. Enforces KYC via requireKycForFunding middleware
 *   3. Resolves the escrow contract address from escrowMap
 *   4. Calls escrowSubmit to build / simulate / sign the Soroban call
 *   5. Persists the investor commitment via investorCommitment service
 *   6. Returns the real submission status (requires_signature / submitted / stubbed)
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const responseHelper = require('../utils/responseHelper');
const { authenticatedTenantStack } = require('../middleware/stacks');
const { requireKycForFunding } = require('../middleware/kycGating');
const { resolveEscrowAddress, EscrowNotFoundError } = require('../config/escrowMap');
const { submitFundEscrow, EscrowSubmitError } = require('../services/escrowSubmit');
const { persistCommitment } = require('../services/investorCommitment');
const idempotencyMiddleware = require('../middleware/idempotency');

const router = express.Router();

// ─── Validation helpers ───────────────────────────────────────────────────────

const INVOICE_ID_RE = /^[a-zA-Z0-9_\-]{3,64}$/;
const STELLAR_ADDRESS_RE = /^[CG][A-Z2-7]{55}$/;

router.use(...authenticatedTenantStack);

/**
 * Validate fund-invoice request body.
 * Returns an array of human-readable error strings; empty array = valid.
 * @param {object} body - Request body.
 * @returns {string[]} Validation errors.
 */
function validateFundInvoiceBody(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Request body must be a JSON object.'];
  }

  const { invoiceId, investorAddress, amountStroops } = body;

  if (!invoiceId || !INVOICE_ID_RE.test(invoiceId)) {
    errors.push('invoiceId must be an alphanumeric string (3-64 chars, hyphens/underscores allowed).');
  }

  if (!investorAddress || !STELLAR_ADDRESS_RE.test(investorAddress)) {
    errors.push('investorAddress must be a valid Stellar public key (G... or C...).');
  }

  // amountStroops: must be a positive integer (as number or numeric string)
  const parsed = Number(amountStroops);
  if (!amountStroops || !Number.isInteger(parsed) || parsed <= 0) {
    errors.push('amountStroops must be a positive integer representing the fund amount in stroops.');
  }

  return errors;
}

/**
 * GET /api/invest/opportunities — list open investment opportunities
 *
 * Returns a paginated list of publicly investable invoices enriched with
 * on-chain escrow state. Protected by authenticatedTenantStack (JWT auth +
 * tenant resolution).
 *
 * @param {import('express').Request} req - Express request.
 * @param {string} [req.query.page=1] - Page number (1-based).
 * @param {string} [req.query.limit=20] - Items per page (capped at 100).
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 *
 * @swagger
 * /api/invest/opportunities:
 *   get:
 *     summary: List open investment opportunities
 *     description: >
 *       Retrieve a paginated list of publicly investable invoices enriched
 *       with on-chain escrow state (status, funded amount, legal hold flag).
 *       Only invoices with a status of `verified` or `partially_funded` are
 *       exposed. On-chain reads that fail for individual invoices are silently
 *       skipped — the endpoint never fails as a whole.
 *     tags: [Invest]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number (1-based)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Items per page
 *     responses:
 *       200:
 *         description: Investment opportunities retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required:
 *                 - data
 *                 - meta
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required:
 *                       - invoiceId
 *                       - fundedBpsOfTarget
 *                       - maturityAt
 *                       - yieldBpsDisplay
 *                       - onChain
 *                     properties:
 *                       invoiceId:
 *                         type: string
 *                         description: Unique identifier of the underlying invoice
 *                       fundedBpsOfTarget:
 *                         type: integer
 *                         description: Progress towards funding target in basis points (10000 = 100%)
 *                       maturityAt:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                         description: ISO timestamp when the investment matures
 *                       yieldBpsDisplay:
 *                         type: integer
 *                         nullable: true
 *                         description: Expected return in basis points (e.g. 500 = 5%)
 *                       onChain:
 *                         type: object
 *                         required:
 *                           - escrowAddress
 *                           - ledgerIndex
 *                         properties:
 *                           escrowAddress:
 *                             type: string
 *                             description: Stellar/Soroban escrow contract address
 *                           ledgerIndex:
 *                             type: string
 *                             nullable: true
 *                             description: Last ledger index synchronized for this opportunity
 *                           status:
 *                             type: string
 *                             description: On-chain escrow status
 *                           fundedAmount:
 *                             type: integer
 *                             description: Amount currently held in escrow
 *                           legal_hold:
 *                             type: boolean
 *                             description: Whether the escrow is under legal hold
 *                 meta:
 *                   type: object
 *                   required:
 *                     - total
 *                     - page
 *                     - limit
 *                     - totalPages
 *                   properties:
 *                     total:
 *                       type: integer
 *                       description: Total number of matching opportunities
 *                     page:
 *                       type: integer
 *                       description: Current page number
 *                     limit:
 *                       type: integer
 *                       description: Items per page
 *                     totalPages:
 *                       type: integer
 *                       description: Total number of pages
 *                 message:
 *                   type: string
 *                   description: Human-readable status message
 *       400:
 *         $ref: '#/components/responses/Problem400'
 *       401:
 *         $ref: '#/components/responses/Problem401'
 */

router.get(
  '/opportunities',
  asyncHandler(async (req, res) => {
    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;

    const result = await listOpportunities({
      tenantId: req.tenantId,
      page,
      limit,
    });

    return res.json({
      ...responseHelper.success(result.data, result.meta),
      message: 'Investment opportunities retrieved successfully.',
    });
  })
);

// ─── POST /api/invest/fund-invoice ───────────────────────────────────────────

router.post(
  '/fund-invoice',
  requireKycForFunding,
  idempotencyMiddleware,
  asyncHandler(async (req, res) => {
    // 1. Input validation
    const validationErrors = validateFundInvoiceBody(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: validationErrors[0],
          details: validationErrors,
          retryable: false,
        },
      });
    }

    const { invoiceId, investorAddress, amountStroops } = req.body;

    // 2. Resolve the escrow contract address
    let escrowAddress;
    try {
      escrowAddress = resolveEscrowAddress(invoiceId);
    } catch (err) {
      if (err instanceof EscrowNotFoundError) {
        return res.status(422).json({
          error: {
            code: 'ESCROW_NOT_FOUND',
            message: `No escrow contract is configured for invoice: ${invoiceId}`,
            retryable: false,
          },
        });
      }
      throw err; // unexpected config error → 500 via errorHandler
    }

    // 3. Build idempotency key — deterministic per (investor, invoice, amount)
    const idempotencyKey = crypto
      .createHash('sha256')
      .update(`${investorAddress}:${invoiceId}:${amountStroops}`)
      .digest('hex');

    // 4. Call escrowSubmit — builds, simulates, and optionally signs + broadcasts
    let submitResult;
    try {
      submitResult = await submitFundEscrow({
        escrowAddress,
        investorAddress,
        amountStroops: String(amountStroops),
        invoiceId,
      });
    } catch (err) {
      if (err instanceof EscrowSubmitError) {
        return res.status(502).json({
          error: {
            code: 'ESCROW_SUBMIT_FAILED',
            message: 'Failed to prepare the escrow transaction. Please try again.',
            // Do NOT expose err.message to the client — it may contain RPC details
            retryable: true,
          },
        });
      }
      throw err;
    }

    // 5. Persist commitment (idempotency-safe)
    const commitment = await persistCommitment({
      invoiceId,
      investorAddress,
      escrowAddress,
      amountStroops: String(amountStroops),
      status: submitResult.status,
      unsignedXdr: submitResult.unsignedXdr,
      txHash: submitResult.txHash,
      ledger: submitResult.ledger,
      idempotencyKey,
    });

    // 6. Return real status — never return internal detail fields like idempotencyKey
    return res.status(200).json({
      commitmentId: commitment.id,
      invoiceId,
      escrowAddress,
      status: submitResult.status,
      // Delegated mode: client needs this to sign and broadcast
      ...(submitResult.unsignedXdr && { unsignedXdr: submitResult.unsignedXdr }),
      // Custodial / submitted mode: transaction is on-chain
      ...(submitResult.txHash && { txHash: submitResult.txHash }),
      ...(submitResult.ledger && { ledger: submitResult.ledger }),
    });
  })
);

module.exports = router;