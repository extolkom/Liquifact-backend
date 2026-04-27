-- Create audit_logs table for invoice state transitions
-- Migration: 20240426000000_create_audit_logs_table.sql

-- Create audit_logs table
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    actor VARCHAR(255) NOT NULL,
    action VARCHAR(50) NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'READ', 'STATE_TRANSITION')),
    resource_type VARCHAR(50) NOT NULL,
    resource_id VARCHAR(255) NOT NULL,
    before_state JSONB,
    after_state JSONB,
    status_code INTEGER NOT NULL DEFAULT 200,
    ip_address VARCHAR(45),
    user_agent TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- Add comments for documentation
COMMENT ON TABLE audit_logs IS 'Immutable audit trail for all resource mutations and state transitions';
COMMENT ON COLUMN audit_logs.id IS 'Primary key using UUID';
COMMENT ON COLUMN audit_logs.timestamp IS 'When the action occurred';
COMMENT ON COLUMN audit_logs.actor IS 'User ID or IP address of who performed the action';
COMMENT ON COLUMN audit_logs.action IS 'Type of action performed';
COMMENT ON COLUMN audit_logs.resource_type IS 'Type of resource (invoice, escrow, etc.)';
COMMENT ON COLUMN audit_logs.resource_id IS 'Unique identifier of the affected resource';
COMMENT ON COLUMN audit_logs.before_state IS 'State before the mutation';
COMMENT ON COLUMN audit_logs.after_state IS 'State after the mutation';
COMMENT ON COLUMN audit_logs.status_code IS 'HTTP status code of the operation';
COMMENT ON COLUMN audit_logs.ip_address IS 'IP address of the requester';
COMMENT ON COLUMN audit_logs.user_agent IS 'User agent string of the requester';
COMMENT ON COLUMN audit_logs.metadata IS 'Additional context (method, path, etc.)';
