# Audit Log Service

## Overview
The Audit Log Service manages immutable audit records for invoice mutations,
backed by the `audit_log_events` table.

## Page Size Cap

`getAuditLogs` enforces a hard maximum page size of **100 records** per query
to prevent loading the entire audit table into memory and causing
out-of-memory errors or denial of service.

### Behaviour
- Default limit: `100`
- Maximum limit: `100` (any value above this is clamped)
- Passing `Infinity` or a value larger than `100` will return at most `100` records
- Negative or non-numeric limits are treated as the default (`100`)
- Zero limit is treated as the default (`100`)

## Pagination
To retrieve more than 100 records, use the `offset` parameter to paginate:

```js
// Page 1
getAuditLogs({ limit: 100, offset: 0 });

// Page 2
getAuditLogs({ limit: 100, offset: 100 });