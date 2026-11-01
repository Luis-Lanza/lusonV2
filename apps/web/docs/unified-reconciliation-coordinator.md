# Unified reconciliation coordinator

`transferUnifiedReconciliationStore.ts` is an inert, owner-held frontend coordinator.
It performs no HTTP requests and is not the backend transactional Store.
No hook, modal or existing table is activated by this unit.

## Intent and recovery

- Synchronize account, location, epoch and generation before selecting a received record.
- Selection captures immutable original evidence using the existing recovery helper.
- Read tickets accept only the latest selected owner/record flight; results use the strict codec.
- Prepare captures intent without writing. Confirm requires the same snapshot and eligible head.
- Confirmation returns a write ticket; the caller owns transport and explicit user consent.
- Uncertain or conflicting attempts block replacement work. Explicit retry retains the exact payload.
- Reads resolve attempts only from matching durable operation evidence, never head presence alone.
- A fresh definite refusal permits new work; refusal after uncertainty does not erase uncertainty.
- Owner changes clear attempts; record selection cannot adopt another record's read ticket.
- Privacy refusals mask private state until a successful explicit read. Passive reads cannot unmask it.
- Stale write settlement is ignored; malformed current results do not confirm an attempt.

## Scope and proof

S3–S5: reuse coordinated evidence and one-command intent, without chaining legacy mutations,
replacing history, adding loss closure or crediting unexpected variants.
S6: arithmetic and inventory effects remain the existing codec/backend contract, not local writes.
S7: counterpart acceptance checks source generations and origin retention attestation;
either endpoint may initiate, with attempts keyed by record and variant.

The exact main-source tests cover immutable retries, durable read recovery, owner/stale-flight
fences, privacy masking, counterpart acceptance and malformed results.
Parent job51 observed the expected missing-module RED before production assembly.
Store/API/recovery/model tests, typecheck and build remain parent-owned GREEN checks.
No browser, hook integration or backend end-to-end proof is claimed by this unit.
