# Legacy reconciliation controls

The three legacy audit workflows were removed from the product UI in S5/T5. Only
the unified reconciliation flow is reachable: the received detail offers the
direct **Resolver diferencia** action and keeps no management menu. What follows
separates what was deleted from what still exists as read-only historical
evidence.

## Removed from the product UI

| Removed surface | What is gone |
| --- | --- |
| `TransferCountCorrections` and `useTransferCountCorrections` | Component, hook, `transfer-count-corrections.css` and its tests. No count proposal, decision, preview or recovery control is reachable. |
| `TransferRestitutions` and `useTransferRestitutions` | Component, hook, `transfer-restitutions.css` and its tests. No restitution proposal, decision or recovery control is reachable. |
| `TransferDispatchReconciliations` and `useTransferDispatchReconciliations` | Component, hook, `transfer-dispatch-reconciliations.css` and its tests. No dispatch regularisation, proposal or decision control is reachable. |
| `TransferDetail` legacy composition | The `corrections`, `correctionsEnabled`, `correctionRequestID`, `reconciliations`, `reconciliationRequestID`, `reconciliationsEnabled`, `restitutionRequestID`, `restitutionsEnabled` and `restitutionAPI` inputs, the legacy panes and the "Gestiones" menu. The received detail now renders only the direct unified action. |
| `TransferPending` legacy mounting | The legacy API adapters and both legacy hooks; `TransferDetail` receives only `unified`, gated by the same mount-bound authority fence. |

## Kept as read-only historical evidence

| Kept surface | Why it stays |
| --- | --- |
| `transferCountCorrectionModel`, `transferRestitutionModel`, `transferDispatchReconciliationModel` | Parsers and decoders for the historical payloads. |
| `transferUnifiedReconciliationModel`, `transferUnifiedReconciliationView`, `transferUnifiedReconciliationStore`, `useTransferUnifiedReconciliations` | The single remaining flow's decoder, projection and recovery store. |
| `transferCountCorrectionRecovery`, `transferRestitutionRecovery` and their stores | Recovery and owner-scoped pin utilities the unified snapshot and the inventory controller still consume. |
| Legacy HTTP routes, SQL readers and tables | Read-only history. `unified_reconciliation_store.go` reads the count, restitution and dispatch evidence through them; no legacy write path is called from the web client. |

These parsers do not fabricate revisions, apply inventory effects or emulate
atomic agreement with chained legacy commands. Historical quantities are never
the authoritative current unified table state, and no removed component can be
re-imported without reintroducing its deleted file.

## Verification boundary

There is no legacy component test left to run: the component, hook, stylesheet
and test files were deleted, and a repository-wide grep finds no importer of any
deleted module. The surviving evidence is the unified flow's own tests
(`TransferDetail.unified.test.tsx`, `TransferPending.test.tsx`,
`useTransferUnifiedReconciliations.test.tsx`, `transferUnifiedReconciliation*.test.ts`)
plus `crossWorkflow.test.ts`, which keeps the controller's exact-confirmation
fence and cross-reader refresh assertions. These are not browser or backend
end-to-end proof; the browser runner under `e2e/transfer-unified/` asserts the
direct action and the absence of the menu, but was not executed for this change.
