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

## R05a2a injected raw-evidence adapter (source only)

`r05-driver.mjs` adds no Docker client, filesystem reader, shell, discovery,
provisioning or browser runner. Tests use inline synthetic Docker-shaped records;
passing them proves neither genuine engine observations nor R04/R05 acceptance.

### Public API

- `normalizeR05Evidence({manifest,raw,labelPolicy,sequence})` returns an independent
  normalized snapshot. It validates the raw protocol, not the complete manifest
  binding; call `admit` separately. It never invents missing fields or identities.
- `volumeFingerprint(rawVolume)` SHA256-hashes the canonical **complete** identity
  record `{Name,Driver,CreatedAt,Options,Scope,Labels}`. Sorted object keys do not
  affect identity; array order does. All actual volume labels participate, including
  allowlisted Compose metadata. A name-only hash or fake native volume ID is invalid.
- `createR05Driver({manifest,labelPolicy,collectRaw,dispatchRaw})` clones bindings
  and exposes `inspect()`, `createPlan()`, `sql({text,values})`. There are no defaults.
  `cleanupPlan()` and `cleanup()` always refuse; create/build/start/remove/dispatch
  are not exposed. Prepare plans authorize **no effects**. Partial, stopped or removed
  active topologies require a separately admitted parent lifecycle policy.

`collectRaw` receives frozen `{operation:'inspect',phase,request}`. Return a new
complete observation with the same positive `request`. A replayed request refuses.
The driver assigns its instance-local positive `sequence` only after collection,
normalization and full admission; failed observations consume requests, not sequences.
This is causal bookkeeping, not wall-clock freshness or cryptographic attestation:
a malicious collector can echo a new request on old data. Parent must supply trusted
current observation provenance and independently grant real transport authority.

Every individual `sql` serializes a fresh collection and full active guard before
calling `dispatchRaw({operation:'sql',id:<exact bound DB ID>,stdin:{text,values}})`.
No argv, ENV, shell or arbitrary operation transport exists. Dispatch results are
not returned; underlying errors become only `R05 admission refused.`. Disable all
payload logging/tracing in a future transport. Boolean flags and code objects are
not human consent. No credentials, SQL values or raw diagnostics are persisted here.

### Raw collector protocol

The envelope has exactly `request,root,files,sources,config,existing_names,network,
volume,project_ids,volume_users,containers`. File/root metadata uses the binding
schema only (never contents); source SHA256 and complete canonical secret-free
Compose `config` must come from current source bytes and filesystem metadata via
future trusted collection. Config object keys sort recursively; arrays retain order.
Its digest is separate from each service's Compose config-hash. Config environment
or secret-content fields are unsupported, not silently redacted for digest matching.

Docker records are explicit secret-free **projections**, not unfiltered inspect JSON:
container `{Id,Name,Image,Config:{User,Labels},HostConfig:{ReadonlyRootfs,PortBindings},
Mounts,NetworkSettings:{Networks},State:{Status,Running}}`; each network attachment
contains exactly `NetworkID`. Network is `{Id,Name,Labels,Internal,Driver,Containers}`,
where member full-ID keys map to `{Name}`; volume is the full identity record above.
Unexpected fields (including Config.Env) refuse; a future collector must project
only admitted metadata while retaining every identity label, attachment and binding.
All IDs are full64hex; images require `sha256:` before stripping. Container names
lose exactly one leading slash, never basename normalization. Bind mounts retain
canonical Source paths; volume mounts retain actual Name, not Docker's host path.
Mounts require Type/Source/Destination/RW (+Name for volume); other kinds refuse.
PortBindings require numeric TCP targets and string numeric HostPort1–65535; empty
or wildcard HostIp is preserved so active admission rejects it, never rewritten.
`Config.User` is preserved exactly, **including empty**. R05a2b1 permits an explicitly
present DB manifest `user: ''` (Docker's configured default) or the prior positive
numeric `uid:gid` string. Active observation must exactly match that declaration;
empty observed/numeric declared and numeric observed/empty declared both refuse.
Missing, null, non-string, whitespace and named users refuse. The app still requires
its exact positive manifest UID:GID and readonly root; empty app users never admit.

This is configuration/ownership binding, not evidence of the running PostgreSQL
PID's effective UID or a genuine engine/image observation. Source Compose declares
`postgres:17.9-bookworm` without a DB user override and uses `POSTGRES_PASSWORD_FILE`;
no numeric UID, wrapper image or secret-permission change is inferred. Tests exercise
synthetic metadata only. Real image identity, effective PG UID and collection
provenance remain unverified. The adapter currently rejects environment config keys,
including Compose's public file-secret environment declarations: faithful config
projection/digest design remains a separate collector gap, not silently fixed here.
Lifecycle/partial-topology policy, TLS, browser privacy and R04/R05 runtime acceptance
remain separately admitted work; all other active ownership guards are unchanged.

`labelPolicy` explicitly supplies `scopeKey,runKey,reservedOwnerKeys`; the two
mapping keys must be distinct and listed as reserved. Raw ownership values must
match manifest scope/run, with Compose project/service/config-hash independently
bound. No guessed keys or retired L05 adoption. All unknown labels and conflicting
reserved keys refuse. The fixed Compose metadata allowlist is in `r05-driver.mjs`;
it includes version, project paths, container-number, oneoff, image, depends_on,
network, volume and replace, not arbitrary `com.docker.compose.*` keys.

`project_ids` and `volume_users` enumerate **all states**, including foreign exited,
stopped and created containers; never filter to running. Active inspected services
must both be running. Extra network attachments, users or project IDs fail full
admission. Prepare has null resources, empty containers/users/project IDs and all
manifest IDs null; `existing_names` still reports conflicting proposed names.
Incomplete observations cannot claim absence. Current metadata alone cannot prove
symlink ancestors or opened-handle provenance; those remain collector obligations.

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
