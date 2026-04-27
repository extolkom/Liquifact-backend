'use strict';

const db = require('../db/knex');

/**
 * Marketplace Service
 * 
 * Handles database operations for the marketplace, allowing search and 
 * sorting of invoices by yield, maturity, and funded ratio.
 * 
 * @module services/marketplaceService
 */

/**
 * Configuration for marketplace query options.
 */
const MARKETPLACE_QUERY_CONFIG = {
  allowedFilters: ['status', 'yieldBpsMin', 'yieldBpsMax', 'maturityDateFrom', 'maturityDateTo', 'fundedRatioMin', 'fundedRatioMax'],
  allowedSortFields: ['yield_bps', 'maturity_date', 'funded_ratio', 'amount', 'created_at'],
  columnMap: {
    yieldBpsMin: 'yield_bps',
    yieldBpsMax: 'yield_bps',
    maturityDateFrom: 'maturity_date',
    maturityDateTo: 'maturity_date',
    fundedRatioMin: 'funded_ratio',
    fundedRatioMax: 'funded_ratio',
    yieldBps: 'yield_bps',
    maturityDate: 'maturity_date',
    fundedRatio: 'funded_ratio'
  }
};

/**
 * Retrieves invoices for the marketplace with filtering, sorting, and pagination.
 * 
 * @param {Object} queryParams - The validated query parameters.
 * @returns {Promise<{data: Array, meta: Object}>} A promise that resolves to the list of invoices and metadata.
 */
async function getMarketplaceInvoices(queryParams) {
  try {
    const { filters = {}, sorting = {}, pagination = { page: 1, limit: 10 } } = queryParams;
    
    let query = db('invoices').select('*').whereNull('deleted_at');

    // Apply filters
    if (filters.yieldBpsMin) {query.where('yield_bps', '>=', filters.yieldBpsMin);}
    if (filters.yieldBpsMax) {query.where('yield_bps', '<=', filters.yieldBpsMax);}
    if (filters.maturityDateFrom) {query.where('maturity_date', '>=', filters.maturityDateFrom);}
    if (filters.maturityDateTo) {query.where('maturity_date', '<=', filters.maturityDateTo);}
    if (filters.fundedRatioMin) {query.where('funded_ratio', '>=', filters.fundedRatioMin);}
    if (filters.fundedRatioMax) {query.where('funded_ratio', '<=', filters.fundedRatioMax);}
    if (filters.status) {query.where('status', filters.status);}

    // Apply sorting using applyQueryOptions for consistency where possible, 
    // but handle custom filters above as applyQueryOptions is limited.
    const { sortBy, order = 'desc' } = sorting;
    if (sortBy && MARKETPLACE_QUERY_CONFIG.allowedSortFields.includes(sortBy)) {
      query.orderBy(sortBy, order);
    } else {
      query.orderBy('created_at', 'desc');
    }

    // Pagination
    const page = Math.max(1, parseInt(pagination.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(pagination.limit) || 10));
    const offset = (page - 1) * limit;

    // Get total count for pagination
    const countQuery = query.clone().clearSelect().clearOrder().count('* as total').first();
    const { total } = await countQuery;

    // Get paginated data
    const data = await query.limit(limit).offset(offset);

    return {
      data,
      meta: {
        total: parseInt(total),
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  } catch (error) {
    console.error('Error fetching marketplace invoices:', error);
    throw new Error('Database error while fetching marketplace invoices');
  }
}

module.exports = {
  getMarketplaceInvoices,
  MARKETPLACE_QUERY_CONFIG
};
