# Unified reconciliation

Received participant details mount the unified recovery hook. **Gestiones →
Resolver diferencia** opens one modal for expected variants over the existing
detail table. The original receipt remains available unchanged. Nested Legacy
histories remain audit evidence, never a fallback for authoritative Current.
Independent read-only full-feature source verification assessed S1–S7 within the
accepted scope and found no concrete production blocker; it executed no workloads.
The parent observed all eight synthetic browser cases passing on both the main
candidate and the final delivery tree, with exact Gestiones focus and zero page
errors. Final focused realtime/HTTP/historical-count checks, typecheck and build
also passed on the delivery tree. The historical full API
run failed; corrected failing selections passed, not a new full-suite run.
Native ASSESS was unavailable due to untracked scope, not review approval.

## Modal and legacy coexistence

Enter exact canonical decimal strings for actual dispatch, arrival and physical
retention, plus a reason. Zero, partial retention, excess arrival and overdispatch
with zero retention are allowed. Either endpoint may initiate. Only origin may
attest physical retention; the other endpoint accepts or rejects. Explicit review
shows hypothetical source/destination effects and separate unresolved differences
before confirmation. Proposing or rejecting does not move stock. Acceptance uses
one atomic server command, never a chain of legacy commands.

The existing table reads coordinated Current fields. A failed unified read never
substitutes original or nested Legacy quantities. Pending/rejected later proposals
do not replace the previous accepted Current. History distinguishes original
receipt, current source and proposal outcomes.

The caller injects coordinated audit reads into existing legacy recovery hooks;
these fetch the unified endpoint rather than legacy current endpoints. Expected
legacy variants expose historical rejection and exact operation recovery, not new
proposals or fresh acceptance. Unexpected-variant count correction remains on its
existing path. Audit quantities describe historical ledger state, not Current.

Network uncertainty exposes the exact operation key, explicit GET consultation,
and an explicitly labeled identical retry. No effect automatically POSTs, generates
a replacement key, or treats absent evidence as failure. Identity/request changes
mask the modal; focus restoration uses the existing scope-bound focus binding.
The Gestiones button is captured before its menu item is removed and carried
through that binding. Explicit Escape/close/return restores that stable opener;
automatic scope retirement never queues focus restoration. Capturing
`document.activeElement` after the menu closes instead loses the opener and
incorrectly selects the detail Back fallback. The browser runner records the
actual active element and requires exact Gestiones button identity after Escape;
there is no intentional animation-frame restoration delay in the shared helper.

## Explicit mutation intent

`propose(original, actor, input, csrf, signal)` sends only `variant_id` (number),
`operation_key`, `expected_revision`, `dispatch_quantity`, `arrival_quantity`,
`retained_quantity` (canonical decimal strings), `retained_at_origin` (boolean)
and `reason`. `decide(original, actor, 'accept' | 'reject', input, csrf, signal)`
omits all three quantities. Actor identity and accounting baselines are never
sent. Action comes from the URL, never an `accept` body member. Invalid local
intent does not fetch. Retention bounds and origin-only attestation are checked
against captured original evidence, never the current workflow head.

The closed result envelope is `{schema, operation}`, with schema
`luson.transfer-reconciliation-operation/v2`; `operation` has exactly the same
closed fields as each unified GET operation. Bigint facts remain lossless and
explicit nulls are required. The codec binds it to original request/variant and
participants; transport additionally matches every exact attempted field.
Reasons and keys are preserved, not normalized for retry identity.

Writes use same-origin credentials, no-store, JSON and `X-CSRF-Token`. Each call
captures context and intent before awaiting fetch. Network errors, abortion,
malformed responses and 503 mark `uncertainReconciliation: true`; admitted other
error/status pairs are certain refusals. No automatic retry, read fallback,
optimistic effect or operation-key replacement occurs. Recovery must retain the
original attempt, even if later proposals exist. These helpers and review
metadata grant no mutation capability.

## Existing list/count and personal-history compatibility

The strict transfer model appends `review_unified_reconciliation` after
`review_dispatch_reconciliation` in ordered list reasons and the exact count
breakdown. When a breakdown is supplied all seven categories are required;
legacy totals-only responses remain valid without invented categories. Counts
remain lossless bigint values and overlapping reviews do not sum into the union.
The server owns counterparty eligibility for either endpoint. Stale predecessor
generations or insufficient stock must not suppress a rejection obligation.
Existing participant fences, lifecycle checks, ordering and legacy category
meanings remain unchanged.

Labels distinguish “Revisar conciliación unificada” and “Conciliaciones
unificadas por revisar” from historical dispatch regularization. Personal
activity admits the existing `unified` category only with `propose`, `accept`,
or `reject`, through the same strict actor, endpoint, UTC time and variant
validators. History renders “Conciliación unificada propuesta/aceptada/rechazada”
with escaped recorded personal/location snapshots, never a fabricated author.
Original receipt quantities and legacy validators are unchanged.

## Decode before consumption

`parseUnifiedReconciliations(raw, originalRecord)` requires the closed schema
`luson.transfer-reconciliation/v2` and the original received transfer context.
It rejects unknown/missing members, duplicate decoded JSON member names,
noncanonical numeric tokens, noncanonical decimal strings, overflow and malformed
UTC timestamps. Variant/location IDs are numbers; request IDs, quantities,
revisions, generations and signed deltas decode losslessly to bigint. Null facts,
decisions and applications must be explicit. Empty collections must be arrays.
The returned evidence is deeply frozen and does not modify input or context.

The transport captures the original record before awaiting fetch. It uses
same-origin credentials, no-store and the caller's abort signal; passive reads
send `X-Luson-Passive: 1`. It requires JSON content type and valid UTF-8, validates
status/error pairs and distinguishes invalid local context, invalid response,
network failure and abortion. It never retries or sends a CSRF token/body.

## Keep three different views

- `original` is immutable receipt evidence, checked against the supplied record.
- `legacy` is audit evidence, decoded through the existing public count,
  restitution and dispatch parsers. Dispatch receives the **original** context.
  The unified boundary additionally binds count operation/proposal identities,
  participants, receipt quantities and coordinated legacy generations/accounting.
- `current` is authoritative accounting. Never fall back to legacy quantities
  after a failed unified decode, and never unwrap legacy as current state.

Ownership starts with a proposal, not an application. Pending/rejected first
proposals are unified-owned but legacy-sourced. After acceptance, later pending
or rejected proposals retain the previous acceptance's revision and operation
key as current source. Selection uses durable identity, never timestamp ordering
or comparison between unrelated workflow revisions. Unexpected received variants
remain in original/current and count audit only, without unified workflow lines.

## Accounting and consent

For immutable original debit E and agreed dispatch D, arrival A, retention R:

- `0 <= R <= max(E-D,0)`; overdispatch requires zero retention.
- Source debit is `max(E,D)-R`; destination credit is `min(D,A)`.
- Origin unknown is `max(E-D,0)-R`; transit unknown is `max(D-A,0)`.
- Excess is `max(A-D,0)` and is not credited.

The decoder sums actual legacy and unified effects with bigint intermediates,
checks proposal baseline pins and generations, and matches every unified
operation, decision, application and stock delta. It never chains warehouse
stock snapshots across unrelated inventory activity. Either endpoint may propose;
only the other endpoint decides. Positive retention requires origin attestation
when origin proposes or accepts. Partial unknowns, zero/downward counts and
quantities above the original debit remain valid.

For E10/D9/A8/R1 with baseline debit10/credit8, application deltas are +1/0 and
transit unknown1. Prior restoration must already be in the source baseline: it
must not produce another credit. Unknowns are not confirmed losses, returns or
unexpected-variant incorporation.

## Owner-fenced recovery

`useTransferUnifiedReconciliations({controller, record, enabled, api?, store?,
onConfirmed?})` supplies `snapshot`, `prepared`, `attempts`, `busy`, `error` and
`masked` getters. The modal calls `prepare(action, input)` to capture a
strict, deeply immutable review intent, then `confirm()` only from an explicit
user action. Input includes a fresh operation key and the reviewed workflow
revision; proposal input includes all three quantities and origin attestation.
No key is regenerated during recovery. `cancel()` discards only prepared review,
not an unresolved submitted attempt. The existing table layout is retained while
its quantities consume authoritative Current.

`refresh()` and `recover()` GET only. An uncertain attempt is confirmed only by
its exact unified operation key and every captured field, never from a current
quantity, a legacy ledger, absence of evidence, or an optimistic stock effect.
`retry(variantID)` is a separate explicit POST of the exact original intent.
Recognized fresh domain refusals permit new review; a refusal after an uncertain
flight cannot erase the earlier uncertainty. Any unresolved intent blocks new
work, including another variant or request, until resolved. Changed snapshot
evidence invalidates prepared confirmation. Rejection remains available for a
stale counterpart proposal; acceptance additionally pins all predecessor
generations and accounting baselines. These affordances do not replace server
authorization or stock validation.

Default recovery memory follows the existing dispatch pattern: weakly held by
the controller's stable authority reader, synchronized to account, location,
authority epoch and session generation. An injected owner-held store is also
supported. No credentials are retained. Owner changes discard private memory;
selection changes mask data synchronously. Equivalent record rerenders preserve
flights; scope changes/unmount abort transport and retain same-owner uncertainty.
Obsolete tickets cannot settle replacement flights. Newer reads supersede older
reads, and read proof retires an outstanding POST without accepting its late
reply. Privacy failures mask attempts until a successful explicit read. Passive
reads send the passive header and never invoke session settlement; explicit 401
refresh or write may settle only the still-current authority epoch.

`onConfirmed(owner, operation)` reuses the existing shared reconciliation
confirmation seam for table, inventory and counter invalidation, not an authority capability. It receives only strictly
validated durable evidence for the still-selected owner. No inventory, history,
loss, return, or unexpected-variant effects are fabricated by this hook.

## Serverless Chromium proof (parent-run)

After source review, run once with a fresh output name:

```sh
LUSON_UNIFIED_BROWSER_SCRATCH_ROOT=/home/luis/velay/luson_v2 node apps/web/e2e/transfer-unified/run.mjs --output odd/verification/transfer-unified-reconciliation/browser-delivery-final
```

The runner builds the real caller/detail/hook/modal with an in-memory synthetic
transport and serves built assets through browser routing, without a server or
DB. Build/cache/results stay inside that fresh output directory. Browser temp,
profile and cache use an exclusively created repository-root `.uc-XXXXXX/`
tree (`t/`, `p/`, `c/`) to avoid Unix socket path limits. By default its root is
the current repository. For this long delivery worktree, the explicit environment
variable above selects only the authorized canonical main-clone root. Before any
writes, the runner requires that exact root, canonical realpath and matching Git
common-directory identity with the delivery tree; any other override fails closed.
Only a new exclusive `.uc-*` tree is written there; build and results remain in
the fresh delivery output, with no traversal or cleanup of other scratch/cache.
The runner refuses
symlink ancestors and checks a conservative socket pathname against 107 bytes.
It records the exact owned tree in `browser-scratch.json` and `result.json`,
and leaves it for parent cleanup without deleting anything. No external writable
roots are used. Installed PATH Chromium is preferred; only the exact approved external
executable below is allowlisted. Other external dependency-cache browser paths
are reported and refused without inspection. No downloads,
existing user profiles or screenshots are used.

Cases cover both endpoints at 390×844 and 1280×1022: original receipt/table,
single unified entry, native Tab/Shift+Tab containment, inert background, Escape
restoration, modal horizontal overflow, zero/partial retention/overdispatch
review, counterpart accept/reject review, explicit confirmation, uncertain
response, GET consultation, identical explicit retry and authority masking.
This intentionally uses the coherent existing E5/A7/credit5 baseline, not the
10/9/8/1 example. Every synthetic POST loses its reply; successful applications,
backend atomicity, stock persistence and HTTP authorization are **not proved**.
The main-candidate and fresh delivery-tree parent runs each passed all eight
cases. Delivery evidence is stored in
`odd/verification/transfer-unified-reconciliation/browser-delivery-final/result.json`.
Node CommonJS interop is resolved explicitly for Playwright's Chromium API.
The installed dependency API currently reports
`/home/luis/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
no PATH browser was resolved. Human approval now permits inspection and launch
of this executable only, not cache-directory traversal or existing user profiles.
The runner allowlists this exact path; writable state is confined to the fresh
output directory and the exclusively owned short repository-local scratch tree.
The worker did not launch the executable. The parent built the fixture and ran
the real browser; source assembly checks alone were not treated as runtime proof.

## Focused checks

From `apps/web`, the self-contained UI checks need no generated seam input:

```sh
npm test -- src/TransferUnifiedReconciliation.test.tsx src/TransferDetail.unified.test.tsx src/TransferUnifiedReconciliationHistory.test.tsx src/transferUnifiedReconciliationView.test.ts
npm run typecheck
```

The existing large DOM regression files exceed a 30-second combined budget.
Use foreground, disjoint test-name selections instead of increasing that budget
or dropping cases. Count correction currently partitions by `^[a-mA-M]`,
`^[n-pN-P]`, `^[q-rQ-R]` and `^[s-zS-Z]`; restitution partitions by
`^[a-mA-M]` and `^[n-zN-Z]`. These selections cover every test in those files.
Caller fixtures must serve the closed coordinated schema, including the seventh
`review_unified_reconciliation` counter category; separate legacy-current
responses are deliberately not consumed. Caller settlement checks exercise the
real App inventory controller, immutable receipt/history and exact recovery.

Recovery engine checks remain separate:

```sh
npm test -- src/transferUnifiedReconciliationRecovery.test.ts src/transferUnifiedReconciliationStore.test.ts src/useTransferUnifiedReconciliations.test.tsx
```

## Actual HTTP-to-codec seam

The parent runs `TestURHTTPCodecSeam` against the already authorized isolated
PostgreSQL fixture, with `LUSON_TEST_PG_MANIFEST` supplied privately. From
`apps/api`, capture stdout outside the repository:

```sh
LUSON_UNIFIED_SEAM_EXPORT=1 go test ./internal/httpapi -run '^TestURHTTPCodecSeam$' -count=1 -v
```

The single `LUSON_UNIFIED_SEAM=` line contains only public authenticated original
transfer and before/after unified GET bodies. It covers the 10/9/8/1 sample,
unexpected audit-only variants, and previous restitution without double credit.
The seam agreement uses the public Store contract rather than HTTP mutation;
production HTTP mutation routes are enabled and separately tested.
From `apps/web`, pass the absolute captured stdout path explicitly:

```sh
LUSON_UNIFIED_SEAM_STDOUT=/absolute/system-scratch/go.stdout npm test -- --no-cache src/transferUnifiedReconciliationSeam.test.ts
```

Missing input, a missing/duplicate export line, or rejected wire evidence fails;
there is no copied-fixture fallback. A general frontend test invocation must
supply this generated input too (or explicitly exclude this integration test).
Never commit generated wire captures or include credentials in them. The parent observed both the HTTP export and codec seam passing on the main
candidate and the delivery worktree; generated wire captures are not committed.

The parent observed all three populated prefix-upgrade scenarios passing;
pre/post-upgrade counter preservation is not proven. Runtime validation remains
parent-owned. Independent source verification is not native review approval or
final delivery closure.
