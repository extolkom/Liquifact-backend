'use strict';

const AppError = require('../errors/AppError');
const { isValidStellarAddress } = require('../utils/stellarAddress');

/**
 * Middleware: verifies the authenticated user has a bound Stellar wallet address.
 * Accepts wallet from req.user.walletAddress or x-stellar-address header (stub).
 * @param req
 * @param res
 * @param next
 */
/**
 * Middleware: verifies the authenticated user has a bound Stellar wallet address.
 * Accepts wallet from req.user.walletAddress or x-stellar-address header (stub).
 * @param {import("express").Request} req The Express request object.
 * @param {import("express").Response} res The Express response object.
 * @param {import("express").NextFunction} next The Express next middleware function.
 * @returns {void}
 */
function authorizeSmeWallet(req, res, next) {
  if (!req.user) {
    return next(new AppError({
      type: 'https://liquifact.com/probs/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    }));
  }

  const wallet = req.user.walletAddress;

  if (!wallet) {
    return next(new AppError({
      type: 'https://liquifact.com/probs/forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'No Stellar wallet address is bound to this account.',
    }));
  }

  if (!isValidStellarAddress(wallet)) {
    return next(new AppError({
      type: 'https://liquifact.com/probs/validation-error',
      title: 'Invalid Wallet Address',
      status: 400,
      detail: 'Stellar wallet address format is invalid.',
    }));
  }

  req.walletAddress = wallet;
  return next();
}

/**
 * Middleware factory: verifies the authenticated user owns the invoice.
 * @param {Array} invoices - Invoice collection to check against.
 * @returns {import('express').RequestHandler} Express middleware
 */
/**
 * Middleware factory: verifies the authenticated user owns the invoice.
 * @param {Array<Object>} invoices - Invoice collection to check against.
 * @returns {import("express").Handler} An Express middleware function.
 */
function verifyInvoiceOwner(invoices) {
  return function (req, res, next) {
    const id = req.params && req.params.id;
    if (!id) {
      return next(new AppError({
        type: 'https://liquifact.com/probs/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Invoice ID is required.',
      }));
    }

    const invoice = invoices.find((inv) => inv.id === id);
    if (!invoice) {
      return next(new AppError({
        type: 'https://liquifact.com/probs/not-found',
        title: 'Not Found',
        status: 404,
        detail: `Invoice ${id} was not found.`,
      }));
    }

    const userId = req.user && req.user.id;
    const wallet = req.walletAddress;

    const ownsById = userId && invoice.ownerId === userId;
    const ownsByWallet = wallet && invoice.smeWallet === wallet;

    if (!ownsById && !ownsByWallet) {
      return next(new AppError({
        type: 'https://liquifact.com/probs/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have permission to access this invoice.',
      }));
    }

    req.invoice = invoice;
    return next();
  };
}

module.exports = { authorizeSmeWallet, verifyInvoiceOwner };
