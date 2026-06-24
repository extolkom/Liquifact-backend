# feat(validation): consolidate invoice payload validation on Zod schemas

## Summary

Replaces the ad-hoc, hand-rolled invoice payload checks in `src/utils/validators.js` with a
single, auditable Zod schema defined in `src/schemas/invoice.js`, while keeping every existing
caller working unchanged.

---

## Problem

Invoice validation was split across two places:

| Location | What it did |
|---|---|
| `src/utils/validators.js` — `validateInvoicePayload` | Hand-rolled field-by-field checks; error messages inconsistent, no length bounds, no unknown-key rejection |
| `src/schemas/invoice.js` | Partial Zod schema without a `validateInvoicePayload` adapter or complete required-field coverage |

`zod` was already a project dependency (used in `src/jobs/retentionPurge.js`), so this was a clear
consolidation win with no new dependency.

The `POST /api/invoices` route also returned a bare `{ errors: [...] }` array on failure instead
of the RFC 7807 `application/problem+json` envelope used everywhere else in the API.

---

## Changes

### `src/schemas/invoice.js` — rewritten

- **`invoiceCreateSchema`** — strict Zod object (`.strict()` rejects unknown keys) covering all
  required fields (`amount`, `dueDate`, `buyer`/`customer`, `seller`, `currency`) with
  `superRefine` cross-field rules. Optional fields (`description` ≤ 1 000 chars,
  `invoiceNumber` ≤ 100 chars) also validated.
- **`invoiceUpdateSchema`** — partial update schema; all fields optional, unknown keys still
  rejected.
- **`paginationQuerySchema`** — Zod schema for `GET /api/invoices` query params with coercion
  and defaults (`page = 1`, `limit = 20`).
- **`validateInvoicePayload(body)`** — thin adapter that runs `invoiceCreateSchema.safeParse` and
  returns the existing `{ isValid, errors, validatedPayload }` shape, so _no callers break_.
- **`parseValidationErrors(zodError)`** — flattens a `ZodError` into a
  `{ [fieldPath]: firstMessage }` object for RFC 7807 `fieldErrors`.
- **`validateBody(schema)` / `validateQuery(schema)`** — Express middleware factories that
  attach parsed values to `req.validated` / `req.validatedQuery` and emit RFC 7807 on failure.
- All exports carry full TSDoc.

### `src/utils/validators.js` — delegated

- `validateInvoicePayload` is now re-exported from `src/schemas/invoice.js`; the hand-rolled
  implementation is gone.
- `validateInvoiceQueryParams` and `validateMarketplaceQueryParams` (marketplace path) kept
  intact — their behavior is unchanged.
- `VALID_CURRENCIES` Set is derived from the Zod schema list so both stay in sync automatically.

### `src/app.js` — RFC 7807 error envelope

- `POST /api/invoices` now calls `invoiceCreateSchema.safeParse` directly and returns a proper
  RFC 7807 `application/problem+json` body with `type`, `title`, `status`, `detail`, and
  `fieldErrors` on validation failure.

---

## Security notes

| Concern | How addressed |
|---|---|
| Unknown / prototype-polluting keys | `invoiceCreateSchema` and `invoiceUpdateSchema` use `.strict()` — any unknown key causes an immediate parse failure |
| Oversized strings | `buyer`/`seller` ≤ 255 chars; `description` ≤ 1 000 chars; `invoiceNumber` ≤ 100 chars |
| Negative / non-finite amounts | Zod `.positive()` + `.finite()` — rejects 0, negative, `Infinity`, `NaN` |
| Currency injection | Allowlist of 30 ISO 4217 codes; input normalised to upper-case before comparison |
| Invalid dates | Regex `/^\d{4}-\d{2}-\d{2}$/` + `Date.parse` calendar validity check |
| Non-object body | Adapter returns `{ isValid: false }` immediately for `null`, arrays, or non-objects |

---

## Test output (`npm test -- tests/validation.test.js tests/unit/validators.test.js`)

```
PASS  tests/unit/validators.test.js
  validateInvoiceQueryParams
    ✓ should validate valid status
    ✓ should reject invalid status
    ✓ should validate valid SME ID
    ✓ should validate valid Buyer ID
    ✓ should reject empty Buyer ID
    ✓ should validate valid dates
    ✓ should reject invalid date format
    ✓ should reject logically invalid dates
    ✓ should validate sorting parameters
    ✓ should reject invalid sortBy
    ✓ should reject invalid order
    ✓ should handle multiple errors

PASS  tests/validation.test.js
  invoiceCreateSchema
    valid payloads
      ✓ accepts a fully-specified payload
      ✓ accepts customer as alias for buyer
      ✓ normalises currency to upper-case
      ✓ trims whitespace from buyer and seller
    required fields
      ✓ rejects missing amount
      ✓ rejects missing buyer (no customer either)
      ✓ rejects missing seller
      ✓ rejects missing currency
      ✓ rejects missing dueDate
      ✓ reports all missing fields in one pass (empty object)
    amount validation
      ✓ rejects zero
      ✓ rejects negative amount
      ✓ rejects Infinity
      ✓ rejects NaN
      ✓ rejects string amount
    dueDate validation
      ✓ rejects wrong format (DD-MM-YYYY)
      ✓ rejects impossible date (month 13)
      ✓ rejects non-string date
    buyer / seller string bounds
      ✓ rejects empty buyer
      ✓ rejects buyer longer than 255 chars
      ✓ rejects empty seller
      ✓ rejects seller longer than 255 chars
    currency validation
      ✓ rejects unsupported code
      ✓ rejects 2-letter code
      ✓ rejects 4-letter code
      ✓ accepts every listed currency
    optional field bounds
      ✓ rejects description longer than 1000 chars
      ✓ rejects invoiceNumber longer than 100 chars
    unknown key rejection (.strict)
      ✓ rejects a payload with unknown keys
  invoiceUpdateSchema
    ✓ accepts an empty object (full partial update)
    ✓ accepts a partial update with only amount
    ✓ rejects negative amount on update
    ✓ rejects unknown keys
    ✓ accepts valid status on update
    ✓ rejects invalid status on update
  paginationQuerySchema
    ✓ applies defaults when nothing is provided
    ✓ coerces string page to number
    ✓ rejects page = 0
    ✓ rejects negative page
    ✓ rejects non-integer page (1.5)
    ✓ rejects limit = 0
    ✓ rejects limit > 100
    ✓ accepts limit = 100 (boundary)
    ✓ rejects invalid status
    ✓ accepts valid status values
    ✓ rejects invalid dateFrom format
    ✓ rejects invalid order value
  validateInvoicePayload
    ✓ returns isValid=true and non-empty validatedPayload for a valid body
    ✓ returns isValid=false and errors array for missing amount
    ✓ returns isValid=false for negative amount
    ✓ returns isValid=false for missing buyer
    ✓ returns isValid=false for unsupported currency
    ✓ returns isValid=false for oversized description
    ✓ returns isValid=false for non-object body (null)
    ✓ returns isValid=false for array body
    ✓ rejects unknown keys (prototype-pollution attempt)
    ✓ is the same function as re-exported from validators.js
  parseValidationErrors
    ✓ maps each issue path to the first error message
    ✓ uses _root for issues with empty path
    ✓ handles nested paths with dot notation
  validateBody middleware
    ✓ calls next() and attaches req.validated on valid body
    ✓ returns 400 RFC 7807 response on invalid body
  validateQuery middleware
    ✓ calls next() and attaches req.validatedQuery on valid query
    ✓ returns 400 RFC 7807 response on invalid query

Test Suites: 2 passed, 2 total
Tests:       76 passed, 76 total
```

> **Note on pre-existing test failures:** The full `npm test` run shows failures in
> `tests/soroban.sim.test.js` and a few other suites. These are confirmed pre-existing on
> `main` before any change in this PR (verified via `git stash` + re-run).

---

## Lint

`npx eslint src/schemas/invoice.js src/utils/validators.js tests/validation.test.js` — **0 errors, 0 warnings**.

Pre-existing lint errors across other files in the repo are untouched and unchanged.

---

## Files changed

| File | Change |
|---|---|
| `src/schemas/invoice.js` | Full rewrite — Zod create/update/query schemas + adapters |
| `src/utils/validators.js` | Delegates `validateInvoicePayload` to schema; removes hand-rolled impl |
| `src/app.js` | POST `/api/invoices` uses `invoiceCreateSchema.safeParse` + RFC 7807 errors |
| `tests/validation.test.js` | Comprehensive edge-case test suite (64 tests) |

---

closes #268
