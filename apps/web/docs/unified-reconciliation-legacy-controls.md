# Legacy reconciliation controls

These component seams support unified reconciliation integration without activating it in Pending or Detail.

| Component | Optional input | Opt-in behavior |
| --- | --- | --- |
| `TransferCountCorrections` | `expectedHistoricalOnly` | Hides fresh expected proposals and acceptance; unexpected count mutations remain available. |
| `TransferRestitutions` | `historicalOnly` | Hides fresh proposals and acceptance. |
| `TransferDispatchReconciliations` | `historicalOnly` | Hides fresh proposals and acceptance, including controlled non-rejection drafts and reviews. |

Omitting these flags preserves legacy callers. Historical evidence, authorized rejection and exact operation recovery remain available under existing authority and uncertainty checks. Historical quantities are not the authoritative current unified table state. These flags do not fabricate revisions, apply inventory effects or emulate atomic agreement with chained legacy commands.

`TransferRestitutions.api` forwards the existing hook API option unchanged. An integrating caller can supply its coordinated audit API without replacing hook recovery, ownership or confirmation handling. Omission retains the hook's default API.

## Verification boundary

Four focused historical cases cover expected-count controls, both restitution endpoints and dispatch controls. The parent observed their RED failures before production changes. Existing tests are retained unchanged apart from the dispatch harness's optional flag; default count and restitution scenarios are not converted into historical scenarios.

Parent-owned GREEN, bounded legacy regressions, typecheck and build remain required. These component tests are not browser or backend end-to-end proof. Unexpected-count mutation and exact-recovery preservation follow unchanged code paths and still require parent regression evidence; the new focused cases alone do not prove them.
