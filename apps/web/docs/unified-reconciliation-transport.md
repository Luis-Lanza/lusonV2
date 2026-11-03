# Prepared unified reconciliation transport

Scope: S3–S7 transport, immutable attempt capture and a real HTTP-to-TypeScript read seam. No recovery coordinator, Store, hook or UI is activated by this unit.

## Transport and recovery

`createUnifiedReconciliationAPI` exposes `read`, `propose` and `decide`. Reads use private same-origin, no-store GETs and support passive reads and cancellation. Writes require explicit CSRF and capture original receipt context before asynchronous work.

Proposal and decision inputs use the existing closed intent normalizer. Replies must match the captured request, actor, action, variant, operation key, revision, quantities, attestation and reason. Local rejection performs no request. Network failures, aborts, malformed replies and service-unavailable writes remain uncertain; transport never retries automatically.

`captureUnifiedReconciliationAttempt` seals original receipt evidence and normalized intent without credentials or eligibility. Recovery resolves only from matching decoded durable operations: absent keys remain unresolved and mismatching identities conflict. Current or legacy heads do not imply success or determine retry eligibility.

## Real HTTP → TypeScript seam

The parent runs `TestURHTTPCodecSeam` against its authorized isolated database with `LUSON_UNIFIED_SEAM_EXPORT=1`, capturing stdout in a fresh host job log. The TypeScript seam requires `LUSON_UNIFIED_SEAM_STDOUT` to point explicitly to that exact log; there is no fixture fallback.

The producer uses authenticated HTTP reads and existing Store mutations. It checks complete stock transformation and immutable original evidence for the sample and prior-restoration cases. The consumer decodes the actual HTTP bodies and checks retained legacy evidence, current accounting, unresolved transit difference and unexpected-variant exclusion from the workflow.

This is a prepared transport/read-codec seam, not mutation HTTP end-to-end or browser proof. Execution and database lifecycle remain parent-owned; no test success is implied by source installation.
