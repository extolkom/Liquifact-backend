-- Add marketplace fields to invoices table for search and sorting
-- Migration: 20240426000000_add_marketplace_fields_to_invoices.sql

ALTER TABLE invoices 
ADD COLUMN IF NOT EXISTS yield_bps INTEGER,
ADD COLUMN IF NOT EXISTS funded_ratio DECIMAL(5,2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS maturity_date DATE;

-- Update maturity_date from due_date for existing records
UPDATE invoices SET maturity_date = due_date WHERE maturity_date IS NULL;

-- Create indexes for marketplace search and sorting
CREATE INDEX IF NOT EXISTS idx_invoices_yield_bps ON invoices(yield_bps);
CREATE INDEX IF NOT EXISTS idx_invoices_funded_ratio ON invoices(funded_ratio);
CREATE INDEX IF NOT EXISTS idx_invoices_maturity_date ON invoices(maturity_date);

-- Add comments
COMMENT ON COLUMN invoices.yield_bps IS 'Expected return in basis points (e.g. 500 = 5%)';
COMMENT ON COLUMN invoices.funded_ratio IS 'Percentage of invoice funded (0.00 to 100.00)';
COMMENT ON COLUMN invoices.maturity_date IS 'The date when the investment matures';
