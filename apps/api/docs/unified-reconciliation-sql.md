# Unified reconciliation SQL delivery unit

This unit installs the complete migration018. It is **not inert**: SQL callers
can propose, accept or reject per-expected-variant agreements through
`transfer_unified_reconcile`. No unified Go Store reader/mutation API, HTTP route
or modal is delivered by this unit.

## Accounting and consent

For original debit E, agreed dispatch D, arrival A and origin retention R:

- `0 <= R <= max(E-D,0)`; overdispatch cannot accompany positive retention.
- Target source debit is `max(E,D)-R`; destination credit is `min(D,A)`.
- Stock deltas use actual accumulated effects, not historical declarations.
- Origin unknown is `max(E-D,0)-R`; transit unknown is `max(D-A,0)`.
  Excess arrival `max(A-D,0)` is not credited. These are not confirmed losses.

E10/D9/A8/R1 produces +1/0 from baseline10/8, with transit unknown1.
A previous restitution1 changes the source baseline to9, so the same agreement
produces0/0, not another credit. Original receipt and legacy evidence remain.

Either physical endpoint may initiate; only the counterparty may decide.
Positive retention requires origin attestation at proposal or acceptance.
Acceptance validates predecessor generations, locks both endpoint balances in
order and applies both effects atomically. Existing reservation, admission,
immutable-evidence and personal-activity helpers remain authoritative.

The four new ledgers are operations, proposals, decisions and applications.
The first proposal claims ownership; ownership is not an application. New legacy
proposals/acceptances are fenced on owned variants. Exact old retries and legacy
rejection retain their SQL entrypoint behavior. No evidence is backfilled.
Pending unified consent extends the existing retirement blocker.

## Focused verification

`TestUnifiedReconciliationSQLUnit` uses `testpg.Open` and baseline public
bootstrap/lifecycle helpers in an admitted random database. It checks SQL
accounting, empty ownership, a preownership legacy restitution, a zero-effect
unified acceptance after restoration, exact replay, and immutable ledger
UPDATE/DELETE/TRUNCATE refusals with unchanged stored data and counters.
It is a bounded migration probe, not full Store/API/UI or concurrency proof.

Parent-owned serial commands from `apps/api`, with the admitted91ac7e42 fixture:

```sh
go test ./migrations -run '^TestUnifiedReconciliationSQLUnit$' -count=1 -v
go test ./internal/bootstrap -run '^TestPostgres$/^schema_seed_and_preservation$' -count=1 -v
go test ./... -run '^$'
```

The named SQL test failed before installation with missing accounting/ownership
functions (SQLSTATE42883). GREEN and compile results must be reported separately
by the parent; test presence does not imply execution. Migration018 is copied
whole from the verified candidate, never installed as an edited prefix.

Risk: item1 persisted inventory/schema; item2 guarded mutation capability.
The complete SQL boundary requires review even without Go integration.
