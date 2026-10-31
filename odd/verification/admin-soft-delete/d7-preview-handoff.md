# D7 preview update — runtime and independent review passed

## Actual parent execution after L89 authorization

Job76 prepare passed once (11s); exact current record
`/home/luis/.local/share/luson-local-preview/d7-update-84abee3141644eb8`.
All five builds and readonly-before passed, original four binaries/public tree
were backed up, and the accepted assets were installed while retaining old
immutable files. Parent started exact managed run-server as intentionally
persistent job77. Single job78 verification passed (4s): schema16→17,29 public
nonsecret table counts/digests equal, accounts4→4, markers0→0, source/data/readiness/
exact loopback listener process binding true; result `result-459234a1.json`.
Independent source/receipt review `mvvsgcdb-2l-4a3c` passed D7-only S1–S4/item5,
with 368 source bindings and zero binary/asset/receipt mismatches; no runtime
checks were repeated. See acceptance.md and task L92 for the complete limits.
Do not rerun this historical sequence or infer permission to provision/reset/read credentials.
No human-authenticated actions were performed on the manual database.

## Historical source-only preparation handoff

The following describes preparation before the authorized execution above;
its NOT RUN/pending statements are historical, not current runtime status.

Parent job75 **FAILED** at `readonly-before` (exit1,8s), after all five builds
passed. Exact original failed receipt:
`/home/luis/.local/share/luson-local-preview/d7-update-becc67a18baf650c/result-60b890b5.json`.
No installation, server startup or migration occurred. Original failure/build
receipts remain intact; missing original probe diagnostics cannot be reconstructed.
The parent reports appending both exact original tooling source copies inside that
failed record and checking their hashes against original `tooling.json` before
this correction. This repository-only writer did not read that private record.

Task L89's fresh user “autorizo” permits only the identifier/diagnostic correction
and **ONE new parent prepare; only if it passes, one exact server start/verify**.
That fresh conditional attempt is **NOT RUN**. Parent source review and the
planned source-regex structural regression check (frozen digit-containing
identifiers plus preserved alphabetic controls) must precede it. No timeout,
schema, auth, account, business, environment or cleanup scope changed.

D7 / **S1–S4 preservation and delivery preparation only**. This corrective writer
performed repository source inspection/edits only: no tests, Go/build, DB, Docker,
HTTP, service, credential or outside-root reads. This is not runtime acceptance.
Both corrected ignored tooling sources require parent review and execution.

## Exact narrow correction and source review

- Go: only the three `expected()` regex literals changed. All four declaration
  identifier captures (CREATE table, column, ALTER table/ADD column) now use
  `[a-z_][a-z0-9_]*` instead of `[a-z_]+`. SQL001's `source_sha256` and
  `fixture_sha256`, and SQL003's `payload_sha256`, are legitimate frozen column
  names affected by the same old grammar. No new field whitelist, datatype,
  catalog-equality bypass or sensitive projection was added.
- Python: only `snapshot()` changed. It now preserves phase-specific native
  stdout/stderr/exit before checking exit0 or parsing JSON, with sanitized
  exit/elapsed/timeout/output-digest metadata. All caller/CLI/install checks remain.
- Source-only review of declaration/ALTER syntax across frozen001–017 identified
  no further extraction mismatch: table blocks end at newline `);`, columns use
  the existing four-space/type grammar, and ADD COLUMN declarations retain their
  existing form. Constraint-only changes and account_id's type alteration do not
  add/remove column names. This is manual source evidence, not a structural-test,
  compile or database result. Parent structural verification remains pending.

Readonly/native file-provider, ledger checksums, explicit auth safe projections,
pre17 marker NULL normalization, exact HEAD and all resource/provenance checks
remain unchanged.

## Parent sequence (once, stop on failure)

Working directory: `/home/luis/velay/luson_v2`. Review
`.cache/admin-soft-delete-d7-update.py` and
`.cache/admin-soft-delete-d7-snapshot.go` first. Keep HEAD exactly
`d008932fd2798485f7f5cb0b846079651c842aef` through both phases.
No legacy tests, frontend build, dependency installation or cache repair.

1. Run this exact command once in the parent's background facility:

   ```sh
   python3 .cache/admin-soft-delete-d7-update.py prepare
   ```

   It prints `D7 private record: /home/luis/.local/share/luson-local-preview/d7-update-<16hex>`.
   Record that exact path; **do not glob-select another attempt**. Require exit0
   and `prepared.json` status `prepared-not-serving`. Preparation does not start
   the server, run migration/seed, provision accounts or execute credential CLIs.
2. Separately background the exact existing wrapper, once:

   ```sh
   /home/luis/.local/share/luson-local-preview/run-server
   ```

   Its ordinary native `Initialize` applies schema17 transactionally, then the
   existing `Seed` checks initialized data and returns without stock reset or
   account creation. The probe first requires initialized metadata1, catalog95,
   variants190, locations>=3 and balances190×locations. There is no empty/partial
   dataset fallback. Preserve the parent's exact process/job identity and logs.
3. Run once with the **exact path printed in step1** as the final argument:

   ```text
   python3 .cache/admin-soft-delete-d7-update.py verify /home/luis/.local/share/luson-local-preview/d7-update-<16hex>
   ```

   `<16hex>` is a receipt locator emitted by step1, not a literal shell argument.
   `verify-started.json` prevents silent repetition. Read the new `result-*.json`
   for that exact record, not an older success. Exit0 and status
   `verified-parent-independent-review-pending` are required but do not close D7.
4. Parent records actual observations, failures and limitations; preserve all
   receipts/backups. No rollback, retry, cleanup, provisioning, resource restart,
   password read, URL rewrite or timeout increase is provided or authorized here.
5. **Independent D7 delivery/environment verification (risk item5) remains
   required after runtime**, covering source/receipt binding, exact resource and
   process identity, readiness, schema17, preservation and accepted limitations.
   Do not mark D7/S1–S4 delivered from preparation or script exit alone.

## Admission, provenance and outputs

The updater reuses the historical `prepare.py` resource validator and wrapper
producer in memory (the producer's exclusive writer is replaced by an in-memory
sink). It never invokes historical `main` or edits the historical manifest.
It additionally pins run553c177d, exact container/network/image/volume/IP and
labels, database/user `luson_preview`, no published DB ports, private uid1000
root0700 and original owned regular wrappers. Docker inspection remains only in
memory; no environment/configuration dump is saved. The managed allowlist uses
only the database-provider **file path**, never a DSN. Credential files are not
manually read, copied or hashed; only native `config.LoadEnv` consumes the locator.

Port8080 must be free at preflight and immediately before installation. Conflict
refuses; nothing is killed, adopted or repaired. The original manifest remains
historical HEAD11f170 and is hash-checked unchanged. Resource identity is checked
again at verification. Existing DB container/network/volume are never recreated,
restarted, removed or provisioned.

Every tracked API/web file must match exact HEAD; every tracked web file must also
match accepted production `0bbb729adf40db7270475999336a09af201db92d`.
API compilation uses only `git archive` of exact HEAD plus the readonly probe at
`cmd/d7-snapshot`, offline existing private compiler/caches, `-mod=readonly`,
`GOPROXY=off`, `GOSUMDB=off`, `GOTOOLCHAIN=local`. All four existing binaries and
probe build before any install. Missing dependencies stop; no repair/install.

Accepted assets are located through the accepted D6 receipt's `source.json`
dist group, fixed to the D5 build provenance at
`d5-authorized-pH2r66RF/candidate/apps/web/dist`. The accepted D6 receipt's recorded
receipt hashes and complete current dist inventory are checked, along with D5's
successful build exit and source hashes. **No historical build-time asset digest
exists:** provenance explicitly records `historicalAssetDigest: null`. Current
asset hashes are bound to accepted-build source provenance, not invented old SHA.

The exclusive private update directory retains:

- `api.tar`, `tooling.json`, archived `source/`, compiled `stage/`;
- five original compiler `<binary>.stdout`, `.stderr`, `.exit` receipts; result
  metadata contains sanitized exit/elapsed/output hashes, never raw diagnostics;
- separate native `readonly-before.stdout`, `.stderr`, `.exit` and, only when
  verification reaches it, `readonly-after.stdout`, `.stderr`, `.exit`. Streams
  are exclusive private files, preserved on nonzero exit or timeout before any
  failure/JSON interpretation. `snapshots[phase]` records exit, elapsed, timedOut
  and stream SHA256s in the append-only result; timeout uses exit124 with
  `timedOut: true`, not a claimed native exit. Outer35s, probe30s, statement5s and
  lock2s bounds are unchanged. JSON is parsed only on exit0. These native receipts
  never collide with compiler `d7-snapshot.*`; no raw stream is echoed;
- `before.json`, `backup/{server,migrate,bootstrap-accounts,recover-warehouse}` and
  full `backup/public/`, with original digests;
- `prepared.json`: source/provenance/resource binding/binary+asset digests,
  initialized-before snapshot, old and installed inventories;
- `verify-started.json`, `check.stdout` (exact
  `data foundation check succeeded\n`), `after.json`, append-only `result-*.json`;
- failures: `status: failed`, `failureStage`, and already completed evidence.
  Earlier failed receipts and original manifest are untouched.

Old immutable assets are retained. Same-path/different-content assets refuse
before binary replacement. New assets append exclusively, each binary is replaced
atomically only after all builds/snapshot/backups, and index is replaced atomically
last. This is **not** a multi-file transaction: installation failure may leave a
mixed set; preserve evidence and stop for the parent, never auto-rollback.

## Readonly preservation boundary

The single-command Go probe uses `config.LoadEnv`, pgx and only the configured
application role (`luson_preview`, as in historical setup), never the test/admin
admission helper. It verifies database/user/host/port, connection-default and
repeatable-read transaction readonly mode, 30s total/5s statements/2s lock bounds.
It does not call Apply, Seed, login or other write helpers. It validates the
embedded ledger prefix16/17 without including that expected-changing ledger in
the preservation comparison.

Expected table/column names come from frozen embedded migration declarations;
unknown public relations, views, foreign/partitioned tables or columns fail
closed before row projection. A declaration the narrow parser cannot recognize
also fails closed through complete catalog equality; it must not be bypassed.
All nonsecret business tables, including realtime revisions and historical
activity, contribute count + SQL canonical sorted-row multiset MD5. Only those
aggregates leave PostgreSQL. MD5 is a preservation checksum, **not** cryptographic
authentication. No raw business or account identity rows are fetched.

Auth uses explicit safe metadata projections:

- accounts: id/location, username/display name, created time, enabled,
  must-change-password, authority version, deletion marker;
- sessions: account, created time, absolute deadline, revocation time,
  authority version; token hash is excluded **before** JSON construction;
- throttle: bucket/window/attempts metadata.

Exact exclusions: account `password_hash`; session `token_hash`, renewable
`last_seen_at` and `idle_deadline`; migration ledger from preservation digests;
sequence objects and non-public schemas. No passwords, salts or credential/session
hash values are inspected, even for fingerprints. Thus this does **not** prove
excluded secret-byte or session-token identity preservation, sequence-state
preservation, or absence of privileged concurrent DB changes. Account0 is valid:
never provision missing accounts. New `deleted_at` is normalized to NULL before17
and compared afterward; both marker non-NULL counts must remain0. Before/after
complete table sets/counts/digests must match exactly.

Verification anonymously observes GET `/` for one bounded readiness window (30s,
2s per request), without service relaunch. No login, credentials, mutating HTTP
or session touch is used. Index and every accepted immutable dist asset require
200, expected MIME and exact installed/accepted hash. The native existing
`check-database` wrapper then verifies schema17/catalog without application writes.
Source/resource/installed inventories are rechecked. Result exposes source/data/
schema17/loopback readiness booleans. When `ss` supplies the sole loopback listener
PID, `/proc/PID/exe` must be the exact installed server inode; unavailable `ss` or
unreported PID leaves `listenerProcessBound: false`, an explicit independent-review
limit, not process identity proof. Nothing signals or kills a process.

## Writer validation / pending proof

Read-only repository inspection and manual source inspection only; no syntax
runner, Go formatter/compiler, tests, archive execution or runtime checks were
run by this corrective writer. The corrected tooling remains
**uncompiled/unexecuted**; job75's old five successful builds are not proof of
these corrected sources. Parent structural verification and the L89-authorized
single fresh conditional workflow remain pending. Any new failure stops work,
not permission for automatic repair or another attempt. S1–S4 feature behavior
remains covered by the accepted D6 evidence; this tooling adds no new UI/security/
concurrency proof. Runtime readiness/preservation and independent item5 disposition
remain pending.
