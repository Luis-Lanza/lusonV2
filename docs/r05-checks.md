# R05a1: source guards, not browser acceptance

R05a1 supplies pure admission and an in-memory ACCOUNT bridge. It does **not**
start Docker, Compose, PostgreSQL, a browser, NSS or a PTY. R04 overall browser
criteria and R05 acceptance remain open. Self-checks are not independent review,
resource preservation proof, trusted TLS proof or delivery approval.

## Review path

1. Read `r05-binding.mjs` and the negative ownership cases first.
2. Read `r05-owned-compose.mjs`: every dispatch needs fresh admitted evidence.
3. Read `r05-ipc.mjs` and its lifecycle tests; keep logging/tracing disabled.

All module paths above are under `apps/web/e2e/`. No retired L05 identity is
imported and no default environment, admin database or resource adoption exists.

## Ownership API and phases

The caller supplies a manifest **object**, not an implicit file discovery path.
Schema `luson.r05/v1` requires explicit `phase`, fresh hexadecimal `run_id`,
`project=luson-r05-<run_id>`, positive non-root `uid`, external canonical private
`root`, `manifest` and administrative `dsn` file metadata, `labels`, `sources`,
`config_digest`, `network`, `volume`, and exactly `services.app` and `.db`.
Labels are exactly `{scope: 'transfer-requests/R05', run_id}`. Unknown manifest,
resource, file and container metadata fields fail closed.

| Evidence | Required binding |
|---|---|
| Root and files | Directory0700; direct-child regular files0600; matching UID; no symlinks |
| Sources/config | Config-source SHA256 plus canonical sorted-key normalized Compose digest |
| Services | Pinned image IDs, Compose hashes, user, readonly, ports and exact mounts |
| Active topology | Full64hex unique captured resource IDs; private bridge; exactly app+db members |
| Publication/storage | App127.0.0.1→8443 only; DB unpublished; one exact DB volume; app readonly binds |

`admit(manifest, snapshot, phase)` checks normalized evidence, **not raw Docker
output**. The future driver must inspect all stopped/project/volume users too,
reject conflicting names and symlink ancestors, stat through opened handles,
derive current source checksums and normalized config, and increment `sequence`
only after a new complete inspection. `existing_names` means conflicting names,
not the two already-bound services. Docker volume identity has no native64hex ID:
the driver must bind `volume.id` to a recorded immutable metadata fingerprint,
and resolve removal to the recorded name only after reinspection. Never invent
an ID from a name alone. Caller provenance is required; these functions cannot
prove an injected snapshot was genuinely fresh against a malicious same-UID JS caller.

Prepare requires **all four IDs null** and no existing resources. `createPlan()`
only returns name/run/config expectations; it does not authorize adoption or
creation effects. Parent must capture newly created identities through separately
admitted future creation code, then supply a complete active manifest.
Active SQL and cleanup cannot use prepare metadata or partial deployment evidence.

`R05OwnedCompose({manifest, inspect, dispatch})` copies its manifest, serializes
operations and rejects reused inspection sequences. SQL dispatch is
`{operation:'sql', id:<exact DB ID>, stdin:{text,values}}`; use parameterized stdin,
not credentials in argv/ENV. Driver errors become constant admission errors.
`cleanupPlan()` is inert and instance-bound. `cleanup(plan,{settled:true})` checks
again before dispatching `cleanup-exact` with recorded IDs. This is an explicit
parent-called plan, **not human maintenance permission**. A future cleanup driver
must re-inspect before each individual effect, stop at drift, and never translate
this into down/prune/force/all or foreign/manual/R01 resource removal.

## ACCOUNT IPC consumer contract

Create an exclusive private0700 directory for **one bridge instance**. Supply
`new CredentialBridge({root,endpoint,run_id,uid,provider})`, then `start()`,
`requestCredentials({root,endpoint,run_id,uid})`, and finally `stop()`.
Only endpoint/root/run metadata may travel in worker ENV. The provider is lazy,
called only after fresh root/socket/run binding, with `{signal}` for cancellation.
Return exactly three distinct roles W/A/B with only `role`, `username`, `password`;
no sessions, CSRF, cookies or bootstrap secrets. Responses are fresh copies.
No account payload is written to files, ENV, argv or a module-global cache.

Requests/replies are limited to4096 bytes; default32 lifetime requests, at most8
live connections, bounded two-second timeouts. Invalid messages/provider errors
produce only `R05 credential IPC refused.` locally, never raw JSON or errors.
Disconnect/stop cancels waiting consumers and clears bridge-held provider/socket
references; the injected provider must honor cancellation and clear its own data.
RAM zeroization and malicious same-UID developer isolation are not promised.

On Linux, Node's server close unlinks by pathname, even after replacement.
Shutdown temporarily makes the **captured directory handle**0500 while closing,
restores0700, then unlinks only a matching captured socket inode. This requires
an exclusive non-root-owned directory; do not share it with manifest/secret files
or another bridge. A replacement endpoint is retained. Parent must keep the
root directory identity stable throughout the lifecycle, including shutdown.
Disable DEBUG, console payloads, call logs, HAR, tracing, video and storageState
in every future consumer; never serialize ACCOUNT records into context.json.
Administrative file-secret policy is separate from ACCOUNT memory-only policy.

## Next separately admitted steps

- R05a2: real evidence normalization/effect driver, source-derived four migration
  checksums, compiled two-service runner, private trust/NSS and PTY transport.
- R05b: independent real three-context browser/privacy/SSE, stock invariance,
  session limits, desktop/mobile/font/cookie/MIME acceptance and settled cleanup.

Do not run retired runners or inspect/reuse retained manual/R01 resources to fill
these gaps. Parent alone owns real manifests, files, resources, data and Git.
