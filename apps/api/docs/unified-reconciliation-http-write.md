# Unified reconciliation HTTP writes

This unit exposes the existing atomic Store contract for expected variants. It
supports S3–S7; it does not add losses, returns or unexpected-variant incorporation.

## Explicit commands

POST `/api/transfers/{id}/unified-reconciliations/propose`, `/accept` or `/reject`.
GET on these command paths returns 405. The existing snapshot GET is unchanged;
reading never submits a command. Unknown suffixes return 404.

Each body is one UTF-8 JSON object, at most 64 KiB, with exactly these fields:

- `variant_id`: positive JSON integer, at most 2147483647.
- `operation_key`: 16–128 ASCII letters, digits, underscores or hyphens.
- `expected_revision`: canonical nonnegative decimal string, at most
  9223372036854775806.
- `retained_at_origin`: JSON boolean.
- `reason`: string, 1–2000 Unicode code points after trimming ASCII spaces;
  NUL is forbidden and the original text is preserved.

Proposals additionally require `dispatch_quantity`, `arrival_quantity` and
`retained_quantity`: canonical nonnegative decimal strings through
9223372036854775807. Decisions forbid those fields; accept/reject comes from the
path, never a caller-supplied `accept` field. Actor and accounting baselines are
server-owned. Duplicate keys, including escaped equivalents, unknown or missing
fields, trailing JSON, invalid UTF-8 and numeric quantity tokens are rejected.
Content-Type must occur once and be `application/json`, optionally with one
`charset=utf-8` parameter. Query strings, including a bare `?`, are forbidden.

## Admission, effects and retries

Admission order is method, authenticated inventory identity, duplicate-aware
Sec-Fetch-Site check, existing mutation guard, action/query/path validation,
private transfer access, then body decoding. Unauthenticated or private requests
must not read the body. The handler does not inspect current-head eligibility
before the Store's exact historical retry lookup.

The existing Store owns bilateral authorization, origin retention attestation,
revision and baseline validation, atomic acceptance effects and retry conflicts.
The handler does not chain legacy commands or change domain validators.
Successful commands return HTTP 200 with exactly `schema` and `operation`:
`schema` is `luson.transfer-reconciliation-operation/v2`; `operation` uses the
existing operation DTO, preserving decimal strings, nullable facts and original
recorded evidence. Exact historical retries retain that envelope after later
proposals or decisions. Errors use the existing transfer error mapping.

## Proof and remaining boundaries

`TestURMutationDecode` checks strict input framing and precision.
`TestURHTTPMutations` exercises production routing, atomic stock effects,
bilateral decisions, historical retries, unchanged original evidence, security
headers and refusal-without-change guards. Existing production GET and serializer
checks remain in place. Database verification is parent-owned and serial.

This slice leaves the six-category action API unchanged. Action discovery,
HTTP-to-TypeScript proof, frontend transport and modal activation belong to later
units; no automatic POST behavior is introduced here.
