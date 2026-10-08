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

## R05a2b2 pure exact-identity lifecycle ledger

`r05-lifecycle.mjs` adds **plans and receipt admission only**. No Docker/client,
CLI, callbacks, SQL, filesystem reading, resource effects or maintenance permission
exists. The running-only raw normalizer and full-active SQL driver remain frozen;
their cleanup refusal is unchanged. Parent alone grants any future effect authority,
settles checks, resolves ambiguous attempts and performs authorized local Git work.
Native RDD is unused; passing these source tests is not delivery approval.

### API and order

`createR05Lifecycle({manifest,snapshot})` copies an immutable **prepare** declaration
and admits complete empty-namespace evidence. It exposes four synchronous methods:

| Method | Contract |
|---|---|
| `plan(operation,snapshot)` | Fresh pre-effect admission; one pending attempt; inert target plus opaque instance-local `token` |
| `admitReceipt(token,{attempt,operation,result},snapshot)` | Latches valid matching response; commits owned state only after fresh complete post-effect admission |
| `settle({checksSettled:true,outcome},snapshot)` | Explicit factual `passed`/`failed` parent outcome, never effect permission |
| `status()` | Independent copy of phase, logical sequence, pending attempt and known IDs/volume fingerprint; no private file metadata |

Normal order is EMPTY → NETWORK → VOLUME → DB_CREATED → DB_RUNNING → APP_CREATED
→ FULL_ACTIVE → SETTLED → APP_STOPPED → DB_STOPPED → APP_REMOVED → DB_REMOVED
→ VOLUME_ABSENT → NETWORK_ABSENT. Operations are `createNetwork`, `createVolume`,
`createDB`, `startDB`, `createAPP`, `startAPP`, then (after settlement) `stopAPP`,
`stopDB`, `removeAPP`, `removeDB`, `removeVolume`, `removeNetwork`. No arbitrary
policy, flags, general dispatch or by-name adoption is exposed.

A `failed` settled startup may clean just the captured partial subset: stop any
created/running app, stop any created/running DB, remove app, remove DB, remove
volume, remove network. No full running app is required. Empty failed startup is
already NETWORK_ABSENT. Partial cleanup reports FAILED_CLEANUP until network absence.
Unexpected spontaneous exits are drift, not automatically inferred transitions.
A pending attempt prevents settlement and all other plans. Missing response,
timeout, wrong identity or failed admission keeps the attempt and prior known IDs;
there is no cancel/retry/adopt/recovery API. Only another complete receipt for that
**same** attempt and **same latched identity** can finish admission. If completion cannot be proven, parent must
retain the unresolved ledger for future explicit human resolution. No automatic
namespace-absence retry is implemented. Removed identities remain recorded history;
absence and presence are separate, and no identity clears before fresh absence.

Pending `candidate` safety retention is the sole deliberate mutation on refused
post-effect admission. A valid THIS-token/attempt/operation creation result latches
its full ID or expected volume Name **before snapshot copying**. It cannot be
substituted, poisoned or erased by later malformed/foreign/replayed receipts.
`status().pending.candidate` returns independent safe data, not admitted ownership
or cleanup permission. For volume, any structurally valid declaration-bound full
metadata learned before failed proof also latches with its complete fingerprint;
substituted metadata refuses. Invalid or foreign metadata does not latch, but the
valid returned Name remains known. Same-candidate fresh proof may finish admission;
owned identities, topology, phase and sequence remain atomic behind all guards.

### Bounded synthetic metadata protocol

Inputs are plain own-data-property objects and dense arrays (max128 entries), with
max256 properties, depth32 and strings up to4096 characters. Accessors, symbols, inherited/custom prototypes,
non-integer numbers and unknown schema fields refuse with a constant error. Never
supply actual credentials, environment values, contents or private diagnostics.
`config` rejects the driver's secret-key vocabulary, including environment keys.

Snapshot fields are exactly `sequence,root,files,sources,config,existing_names,
network,volume,project_ids,volume_users,containers`. Every stage reuses complete
prepare declaration/root0700/file0600/UID/no-symlink/source/config binding validation,
then separately admits the observed phase topology; it does **not** assert the
real topology is empty or use a boolean root-valid shortcut. Conflict names must
be empty. All-state project IDs, scoped containers and volume users must exactly
match the known subset, including created/exited DB volume users. Unknown roles,
foreign stopped users/members, shared attachments and any binding drift refuse.

Network is `{id,name,labels,internal,driver,members,provenance}`; each container is
its exact declared service specification with captured `id`, plus `service,name,
project,labels,network_id,network_mode,state,provenance`. `state` is explicitly
created/running/exited. The declared network ID/mode remains bound when stopped;
actual network members are precisely running known containers. This is a narrow
normalized model, **not an observed engine collector contract**: a collector must
faithfully establish detached stopped/created membership or refuse this model.
`provenance` binds `{root,sources:<ordered source paths>,config_digest}` on each
resource. Network/container labels equal the declaration's normalized scope/run.

Volume is `{metadata,users,provenance}`. Metadata has ALL `Name,Driver,CreatedAt,
Options,Scope,Labels`; this narrow model requires local driver/scope, null options,
and labels exactly scope/run plus project. Creation returns `{Name}` only; fresh
inspection captures full metadata, whose canonical fingerprint binds all fields.
Network/DB/app creation returns `{id:<full64hex>}`; it must match the immediate
inspect of the planned name and every binding. Other receipts use `result:null`.
Stop/remove targets use only captured full IDs; volume removal carries captured
full metadata and fingerprint, not an invented native ID or destructive name lookup.
Members/users must already be empty before network/volume removal.

Sequence is monotonic logical protocol freshness, not engine attestation or a clock.
Parent supplies authentic complete current observations; the module cannot prove
absence from an incomplete collector or defend against malicious same-UID callers.
Raw label/source mapping and authentic **full original** Compose observations
remain future collector work. The source-only opt-in codec below reverses admitted
public data (including `*_FILE` references), not engine observations. No silent
stripping or authentic full-config equivalence is claimed. Source checks prove no
actual images/cache, PG process effective UID, TLS, browser privacy, migrations,
physical stock, NSS/PTY/tool ownership, deployment or global R04/R05 acceptance.
No manual stopped fixture, R01 resource, retired L05 identity or user data is used.

## R05a2c2a pure lifecycle observation normalization prerequisite

`normalizeR05LifecycleEvidence({manifest,raw,labelPolicy,sequence})` in
`apps/web/e2e/r05-driver.mjs` returns a deeply frozen independent lifecycle
**observation**, not admitted ownership, a pending creation receipt or an effect
permission. It does not call ledger methods, read resources or provide transport.
The collector remains deferred. Existing running-only `normalizeR05Evidence`,
`createR05Driver` and full-active SQL admission retain their contracts.

### Input and output contract

| Input | Required observation |
|---|---|
| Manifest | Complete prepare declaration with all resource IDs null; never retained history as presence |
| Raw envelope | Same exact secret-free envelope as RawActive, including positive `request`; resources may be null and containers partial |
| Container | Existing selected keys plus **observed** `HostConfig.NetworkMode`; explicit created/running/exited status and matching Running boolean |
| Attachment | Exactly the declared network name with a full actual NetworkID matching the observed network; unavailable/detached attachment refuses |
| Census | Project IDs exactly selected container IDs; network members exactly running selected IDs; volume users all selected DB states |
| Volume | Original complete Name/Driver/CreatedAt/Options/Scope/Labels; no invented native ID or reduced-label fingerprint |

The output is exactly the lifecycle snapshot schema documented above. Network and
containers carry normalized labels and declaration-bound provenance. Containers
retain actual state, actual attachment ID and observed declared network mode;
volume carries **unaltered native metadata**, users and provenance. Root/files,
ordered sources and supplied public config bind to the prepare declaration through
existing `admit` metadata validation using an empty *validator projection*, not a
claim that the actual namespace is empty. Conflicting names remain in the output
for downstream refusal. Shared private envelope/network/container/label/mount/port
validators avoid a second ownership policy. Normalization does not validate phase
transitions, captured IDs or service pins as owned resources: the ledger must.

Own-data cloning occurs before access or hashing: plain objects, dense arrays up
to128 elements, max256 properties, depth32, strings4096, nodes16384 and aggregate
string/key bytes262144. Proxies, accessors, hidden/symbol keys, custom prototypes,
cycles and non-JSON values refuse without exposing input diagnostics. Output is
recursively frozen; caller mutations cannot change retained observations. Logical
request/sequence values are supplied data, not engine freshness authentication.

### Known native-volume incompatibility remains fail-closed

The driver label policy requires native Compose project labels and permits its
fixed additional Compose labels. The frozen lifecycle ledger instead requires
native volume Labels **exactly** `{scope,run_id,project}`. These contracts are not
currently compatible. The new normalizer preserves the native evidence rather
than claiming compatibility; the regression test supplies that frame to the
ledger and observes receipt refusal with no volume ownership committed. Every
native identity field remains fingerprint-significant. Do not strip labels,
rewrite fingerprints or treat a normalized volume as an admitted one. Resolving
this guard gap requires separately authorized changes and authentic observations.

A future collector must validate original public config with project+restore on
**every** collection, bind source hashes and independent service Compose hashes,
collect complete scoped census before inspecting only permitted explicit IDs, and
repeat root/source/config/identity/census bindings before returning a frame. It
must supply actual THIS-attempt response/context for pending safety inspection;
this API neither adopts pending candidates nor promotes them to active SQL.
Detached created/exited observations cannot satisfy the current frozen lifecycle
network-ID shape and must refuse, never manufacture an attachment. Synthetic tests
prove neither authentic filesystem/engine observations nor PostgreSQL UID, images,
TLS, browser privacy, fixture preservation or real R04/R05 acceptance.

## R05a2c2b injected collector protocol (no real adapter)

`apps/web/e2e/r05-collector.mjs` exports
`createR05Collector({manifest,labelPolicy,transport})`. The only injected capability
is an own-data `transport.read` function; there is no default client, filesystem
reader, command string, dispatch, operation plan or effect permission. Static
factory checks reuse the existing prepare declaration/policy validators using a
validator projection, never claim synthetic filesystem or ownership evidence.

### Collections and parent trust boundary

- `collectRawActive({request,identities})` returns the exact frozen RawActive
  envelope after running-only normalization and full phase admission. Identities
  must equal the immutable manifest's captured IDs/fingerprint. Prepare can return
  only absent resources. A complete active manifest must come from the parent's
  independently fully admitted captured identities, **not pending safety frames**.
- `collectLifecycle({sequence,identities,pending})` returns the exact frozen
  lifecycle observation through the public pure normalizer, without ledger calls.
  Created/exited/running state and actual NetworkMode/attachment are retained;
  unavailable actual attachment refuses. Normalization is not ledger admission.
- Identities are exactly `{network,db,app,volume}`: full64hex IDs or null, and
  volume null or `{name,fingerprint}`. Retained ledger IDs are history, not presence:
  fresh scoped census determines which resources are selected for inspection.

The parent supplies authentic ledger context, known admitted identities and real
creation responses. These objects cannot authenticate that claim against a
malicious caller. Boolean `owned`, `rootValid` or `complete` flags are not accepted
as evidence or human/maintenance authority. Collections serialize; overlapping
calls refuse without interleaving reads. Successful sequence/request completion
advances only after a whole consistent frame; failed calls can retry the same
logical value. A separate attempt counter advances on reads for correlation.
These values are not engine timestamps, atomic snapshots or authentication.

### Exact read selectors and response DTOs

Every request contains `kind,project,frame`, where frame is exactly
`{mode,attempt,sequence,request}`. Modes are active/lifecycle. Every response is
exactly `{frame,value}`, echoing the same frame. Requests and responses are safely
cloned; selectors and returned frames are deeply frozen. Do not log payloads or
underlying errors; all exposed failures are only `R05 collector refused.`.

| Kind | Additional selector keys | Exact value contract |
|---|---|---|
| metadata | paths,source_paths | root,files,sources,handles |
| public-config | sources | original,projected,service_hashes:{app,db} |
| census | planned_names:{network,volume,db,app},volume_name | project_ids,volume_users,containers,network,volume,conflicts |
| network | id | Existing selected raw network DTO |
| volume | name | ALL native Name/Driver/CreatedAt/Options/Scope/Labels |
| container | id,role,view | Existing raw container DTO; lifecycle view additionally requires observed HostConfig.NetworkMode |
| image | id,role | Id with sha256 prefix,ConfiguredUser only; no Env/argv/history |

Metadata paths are exactly manifest root/files; only declared public SOURCE paths
request SHA evidence. Root/files/sources use the existing public metadata schema.
DSN and manifest receive **metadata only**, never bytes or content hashes. Each
handle is `{path,device,inode,opened:{device,inode},ancestors}`. Ancestors enumerate
all canonical parent paths root-first, each `{path,device,inode,uid,mode,type,
symlink}`; identities/opened handles must agree across records, with safe directory
owners/modes and no symlinks. This is an adapter obligation expressed as injected
public data, not proof that a genuine opened filesystem handle was observed.

Census containers are `{id,role,name,state}` for all states. Network is null or
`{id,name,members}`; volume null or `{name,fingerprint}`. Conflict names are explicit
and must be empty. Unknown project IDs, foreign/shared volume users, foreign
network members, wrong role/name/ID selections and conflicting names refuse
**before any resource/image inspection**, without reading foreign contents.

Read order is metadata → public-config → scoped census → permitted selected
network/volume/container/image reads → repeat those resource/image reads → repeat
metadata/config/census. Every binding must match. Images are queried only by each
present role's declared exact image ID; configured image/container User must match
that role, including explicitly declared empty DB User. This proves no PG process
UID. No name adoption, unavailable-field defaults or inferred stopped attachment
exists. Read agreement bounds isolation but cannot establish engine atomicity.

### Config, pending safety and the native-volume gap

Both `projectR05PublicConfig(original)` and `restoreR05PublicConfig(projected)` run
on **every** config read. Supplied projection including its record must match,
with full original digest in the record and the distinct complete projected digest
matching the manifest. SOURCE SHA pins remain separate. Observed service hashes
bind independently to declared Compose hashes; no Docker CLI label-hash algorithm
or equality to the full original SHA is invented.

Pending is null or exactly `{operation,attempt,base_sequence,context,expected_name,
result}` for createNetwork/createVolume/createDB/createAPP. Context is exactly
`{project,root,config_digest}`. Result is the parent's actual `{id}` response, or
volume `{Name}`. Before safety inspection, base_sequence must identify this
collector's prior complete absence frame with the same identities and expected
role/name absent. The first matching response/context is latched; conflicting
responses refuse. A pending name alone cannot adopt an existing volume or fixture.
This latch never becomes owned identities, a ledger receipt or active SQL authority.

Full native volume metadata/Labels/fingerprint remain unchanged. The known frozen
ledger exact-Labels incompatibility above remains: a lifecycle frame may be safely
collected yet **unadmitted**, and consumer receipt validation refuses volume
ownership. Regression tests observe that refusal. Never strip Labels, rewrite the
fingerprint or use successful normalization as an ownership/effect bypass.
Descriptor-safe boundaries reject proxies, getters, hidden/symbol keys, sparse
arrays, cycles/custom prototypes; limits are depth32, arrays128, properties256,
strings4096, nodes16384 and aggregate key/string bytes262144.

All tests use synthetic injected DTOs only. A genuine adapter, authentic ledger
context/resource observations, effect authority, PG UID/images/cache/migrations,
trusted TLS/browser privacy, fixture preservation and actual R04/R05 acceptance
remain separately scoped and unproved. Historical lifecycle test-first caveat
remains unchanged; collector RED/GREEN evidence is writer-only.

## R05a2d1 selected volume/image reader (source-only)

`apps/web/e2e/r05-selected-metadata.mjs` exports
`createR05SelectedMetadataReader({project,volumeName,images:{app,db},execute})`.
It returns only `read(selector)`, compatible with the collector's volume/image
selectors and `{frame,value}` replies. All other selector kinds refuse; composing
filesystem/config/census/container/network readers remains future work. Nothing
here creates a default executable/client, reads environment/files, spawns processes
or grants ownership/effects. Parent approves immutable project/name/full image IDs
and supplies the trusted execution capability; approval data is not human consent.

### Fixed selected projections

| Selector | Internally fixed argv | Selected JSON fields |
|---|---|---|
| volume | volume inspect --format VOLUME -- approvedName | Name,Driver,CreatedAt,Options,Scope,Labels |
| image | image inspect --format IMAGE -- sha256:approvedID | Id,ConfiguredUser from native Config.User |

VOLUME/IMAGE are internal Go-format templates applying `json` to each selected
native field, **not** `json .` full inspection followed by redaction. Exact literal
vectors/templates are regression-tested. No caller args/format/executable/shell/
host/context override is accepted. These templates are conceptual SOURCE contracts:
actual Docker version/CLI compatibility and authentic engine provenance are still
**unobserved**, not proven by fake execution. Returned native Name/Id must match the
approved target; image role/full ID/project and exact selector/frame keys must match.
Empty ConfiguredUser is preserved and proves no PostgreSQL process effective UID.

### Execution and decoding bounds

The sole capability call is exactly `{argv,timeout_ms:5000,max_stdout_bytes:32768,
max_stderr_bytes:0}`, recursively frozen. It must return only `{exitCode,stdout}`,
with exitCode0 and one selected JSON object. The **parent capability must enforce**
process deadlines, output bounds before buffering, stderr rejection, cancellation,
trusted engine identity and settlement only after execution/cancellation ends.
The adapter has no timeout race: unresolved execution retains its instance busy
and concurrent reuse refuses. It cannot make an untrusted/hanging executor enforce
the deadline; separate reader instances need parent-level execution coordination.
Fake tests verify the bound request and pending serialization, not real enforcement.

Adapter validation separately checks stdout bytes before parsing and bounds public
objects to depth16/nodes1024/properties128/string4096/aggregate key-string bytes32768.
Arrays, getters/proxies, hidden/symbol keys, custom prototypes, cycles, unknown or
forbidden top-level output fields, unsupported native metadata and nonzero exits
refuse. Outputs/frames are cloned/frozen; raw executor errors/stdout/stderr never
become diagnostics, only `R05 selected metadata refused.`. Do not log payloads.

Full native volume Labels/Options and fingerprint meaning remain untouched. This
reader performs no label-policy or ledger admission; the existing exact-Labels
compatibility gap remains **unadmitted/refused downstream**, never filtered away.
Complete all-state census, opened filesystem/SOURCE SHA versus metadata-only DSN,
original/projected config and independent service-hash algorithms, image/cache/PG
UID, trusted TLS/browser privacy/manual-fixture preservation and actual R04/R05
acceptance remain future obligations. Historical lifecycle TDD caveat is unchanged.

## R05a2d2 composed owned-process capability

`apps/web/e2e/r05-selected-process.mjs` exports
`createR05SelectedProcessReader({project,volumeName,images,binary,cwd,env,spawn,
clock?})`. Its only result is the frozen selected reader's `{read}` interface.
Execution is private; vectors/templates/selector policy remain in the unchanged
public selected reader. No default spawn/client, arbitrary argv API or selector
spawn-options override exists. Injected spawn must synchronously return a fresh
OWN Node-compatible ChildProcess, or throw before returning any handle.

Binary/cwd are explicit canonical absolute path pins, **not binary authentication**.
Env is independently cloned: only LANG/LC_ALL=C and optional canonical public
HOME/DOCKER_CONFIG/DOCKER_HOST=unix://path references are allowed. These three refs
must appear together or not at all. No process.env, account HOME, loader variables,
NODE_OPTIONS or implicit cwd inheritance is supplied. Parent must separately trust
binary/client configuration, public config directories and endpoint identity; none
is authenticated or inspected here. Spawn options are exactly shell:false,
detached:false, stdio:[ignore,pipe,pipe], explicit cwd and env.

### Settlement, deadlines and owned cancellation

Default clock is local monotonic performance.now with Node timers. Optional own-data
clock supplies trusted now/setTimeout/clearTimeout callbacks for deterministic
checks, not engine timestamps. Existing 5000ms budget includes spawn time; event
checks reject late success even when alarm delivery is delayed. Stdout32768 applies
to **raw bytes before copying/retaining chunks**; buffers are copied to prevent alias
mutation, then strictly UTF8-decoded. First stderr byte is discarded and fails.
Timeout, overflow, stream/child errors, nonzero/signal exits and clock failures are
irreversible; failures stop alarms and discard all subsequent output.

Only child `close` AND both pipe close observations (or absent spawn-failure stdio)
settle execution. Exit/error alone cannot release reader busy. At most one default
SIGTERM attempt uses the returned handle's kill(), never ambient PID/group APIs;
observed exit/close or non-null exitCode/signalCode prohibit signalling a draining
process. Killfalse/throw/error is not termination proof: unresolved execution stays
pending/quarantined, with settlement listeners retained and no repeated alarm,
escalation, grace timer or invented cleanup deadline. Eventual proven closure
rejects once and releases busy. No unref/disown hides pending handles.

These follow Node's documented [exit/close/error and kill semantics](https://nodejs.org/docs/latest-v24.x/api/child_process.html),
including PID-reuse risk after exit. Trusted spawn/handle semantics remain an
external capability boundary. Tests cover synthetic event-ordering/quarantine and
four controlled OWN local Node programs: selected JSON success, multibyte overflow,
first-byte stderr and real approximately5000ms timeout-to-close. All real helpers
are individually returned handles with proven closed streams; fake never-close
cases do not claim disposal. These are process-bound proofs, **not Docker CLI,
engine identity, resource ownership or R04/R05 acceptance**. Native volume metadata,
fingerprint and the existing downstream unadmitted Label gap remain unchanged.
Historical lifecycle-before-RED caveat remains; new TDD evidence is writer-only.

## R05a2c1 source-only public config codec

`apps/web/e2e/r05-config-projection.mjs` exports `projectR05PublicConfig(original)`
and `restoreR05PublicConfig(projected)`. Review the round-trip test first. Neither
function reads files, contacts Docker, authenticates provenance or permits effects.
A future parent collector MUST validate this codec before freezing a manifest or
binding effects; the frozen driver/binding/lifecycle only check supplied data.

| Original segment path | Projected segment path |
|---|---|
| `services.<app/db>.environment` | `services.<app/db>.public_env_bindings` |
| `services.<app/db>.secrets` | `services.<app/db>.public_secret_refs` |
| `secrets` | `public_secret_declarations` |

The embedded `projection_record` has exactly `schema,full_config_digest,renamed_paths`.
Schema is `luson.r05.public-config/v1`; mappings are a fixed ordered array of
`{original:[segments],projected:[segments]}`. Restore validates reconstructed public
SOURCE data again, matches its canonical full SHA256, then requires exact canonical
reprojection. Object key order is irrelevant; every array order is retained.
Aliases, duplicate/missing/conflicting paths, unknown versions and tampering refuse.
Projection of already projected data also refuses; inputs and outputs share no
mutable objects. Errors are generic and never include config values.

This bounded SOURCE-shaped fixture contract accepts only app/db, source service
fields and `luson`/`pgdata` resources; it is not the complete Docker Compose DSL.
Environment objects have exactly the compose.yaml vocabulary: app UID/GID positive
uint32 strings, production/local-trial profile, credential-free HTTPS origin,
`0.0.0.0:8443` listen, `/srv/web` assets, and the three declared `/run/secrets` paths;
DB has public user/database identifiers and `/run/secrets/database_password`.
These are local SOURCE fixture bounds, not permanent deployment policy. Environment
arrays, arbitrary env/build args/commands, unknown carriers and inline credentials
are unsupported. Other admitted fields and dependency semantics are preserved.
Build is app-only, with canonical public path strings for `context,dockerfile`,
not nested data. Healthcheck is DB-only: exactly the SOURCE two-element CMD-SHELL
vector `pg_isready -U <public POSTGRES_USER> -d <public POSTGRES_DB>`. SOURCE uses no
variable expansion; arbitrary programs, assignments, operators, newlines, variable
references and extra argv refuse, including on restore with a recomputed full SHA.
Durations are positive integral ms/s/m/h strings (six-digit amount, at most24h);
retries are integers1–1000. Dependencies use `service_healthy` and optional boolean
`required,restart`. These bounds apply to the local SOURCE fixture, not a generic DSL.
Named declarations contain only canonical absolute `file` paths (optional public
`name`); references are source names or `{source,target?}` with the declared target.
No external providers, literal contents, duplicate refs or opaque extensions.
TLS private-key **path metadata** is public here, never private-key contents.
No referenced file is opened, hashed or persisted.

Plain own JSON data is cloned before value access/canonicalization: no proxies,
custom prototypes, accessors, hidden/symbol keys, dangerous keys, sparse arrays,
cycles, nonfinite/non-JSON values or negative zero. Bounds are depth32, 16384 nodes,
4096 entries/container, 8192 characters/string and 262144 UTF8 data/key bytes.
Keys are printable ASCII, sorted canonically; arrays are never sorted.
Both frozen guards use whole-key matching: `environment` fails, plural `secrets`
does not. The explicit aliases implement this typed reversible contract, not a
substring workaround. Unsupported forbidden locations are rejected, not encoded.

`manifest.config_digest` already hashes the supplied `snapshot.config`; with this
opt-in version it hashes projected config INCLUDING the record. The record's
`full_config_digest` hashes the full reconstructed original public config. Old
minimal synthetic fixture digests are not original Compose proof. Source-file SHA
and each service's `compose_hash` label pin remain independent; observed Docker
Compose label hashes versus canonical full SHA256 remain UNPROVEN. An attacker
can rewrite data and digests together: this codec is integrity consistency, not
engine/frame authentication. Collector/root/file identity, images/cache, PG UID,
migrations, trust/browser privacy and real R04/R05 acceptance remain deferred.

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

## R05a2e1 injected filesystem metadata reader

`createR05FilesystemMetadataReader({project,root,uid,manifest,dsn,sources,fs})`
exports only `read(request)` and count-only `status()`. Reference approvals are
canonical path strings; sources are ordered `{path,sha256}` public snapshots.
All files must be distinct direct root children. No default filesystem provider,
copying, generic path reader or configuration/resource selector is supplied.

`read` accepts the collector's exact metadata selector, project, ordered paths,
source_paths and `{mode,attempt,sequence,request}` frame (active or lifecycle).
Replies echo that frame with frozen `{root,files,sources,handles}` metadata.
SHA256 appears in both source files and sources. References are never read/hashed.
Ancestors include slash; pathname and opened stats agree before/after and repeat.
Full permission/special bits are retained; native-width device/inode values must
be exactly positive safe integers, including when provided as BigInt.

Trusted `fs` owns functions `lstat/open/stat/read/close`. Stat results are own-data
`{device,inode,uid,mode,type,symlink}` records. A native provider must project full
07777 permission bits without dropping special bits. Open receives fixed readonly,
nofollow, nonblock, directory and bigint intent; `read(token,{offset,length})`
returns raw bytes from that same opaque handle, maximum65536 bytes per chunk and
1MiB per public source, checked before copying/hashing. Source handles restat.
Close fulfillment must mean actually closed; rejection means UNKNOWN, not closed.
All acquired opaque handles receive one close attempt, even after earlier errors.
Unknown closures retain private references permanently, quarantine future reads
and expose only busy/quarantined/count; there is no retry/disposal authority.

Human3437 selected exclusive controlled LOCAL fixtures: these observational
checks are **not atomic defense against malicious same-Linux-UID processes**.
OWN synthetic native tests do not authenticate an engine or authorize effects.
DSN/manifest/TLS key/account-secret contents remain outside this public reader.
Native Label gap remains UNADMITTED; R04/R05 deployed acceptance remains pending.

## R05a2e2a pure native stat projection

`projectR05NativeStat(raw)` selects only own data descriptors `dev/ino/uid/mode`
from a Node BigIntStats-shaped object. Stats prototypes and unrelated timestamps
are allowed; no getters, caller methods, constructor or unrelated fields are read.
Proxies (including revoked proxies), arrays and non-object inputs are refused.
Selected fields must be primitive BigInts: device/inode are 1..MAX_SAFE_INTEGER,
UID is 0..MAX_SAFE_INTEGER. There is no numeric/string/boxed coercion.

Full native mode is validated within 0..0177777 before type extraction or masking.
Only regular files and directories are accepted; symlink/FIFO/device/socket and
unknown/missing types refuse. Permissions retain all 07777 bits, including setuid,
setgid and sticky. The detached frozen JSON row is exactly
`{device,inode,uid,mode,type,symlink:false}`; errors have constant public wording.

This is selected-data consistency, **not native origin authentication**. Root UID,
root0700/file0600 and ancestor policy remain solely in the existing metadata reader.
Synthetic integration exercises its real projected DTOs, slash ancestor identity,
SHA in both files/sources and fake closes before publication; it proves no real FD
closure. Pure projection needs no new physical filesystem functional checks.
No native client/provider I/O, path opening, engine/frame authority or partial
selected-filesystem wrapper is supplied. Open flags and native-handle lifecycle
remain a separately admitted future unit; controlled-local same-UID limits and the
UNADMITTED native Label gap are unchanged.

## R05a2e2b selected native filesystem wrapper

`createR05SelectedFilesystemReader({approval,native})` returns frozen `{read,status}`
only. Approval uses the metadata reader's project/root/uid/manifest/dsn/sources
shape. That frozen reader remains the sole constructor, selector, frame, owner,
root0700/file0600 and complete-slash-ancestor policy. The pure native projector
handles BigIntStats width/type/full07777 consistency, not origin authentication.

Native supplies own-data nonproxy functions `lstatBigInt(path)`,
`openReadonly(path,flags)`, `fstatBigInt(handle)`,
`readInto(handle,buffer,offset,length,position)` and `closeHandle(handle)`.
Results may be direct values or native Promises, not accessor-bearing thenables.
Mandatory flags are explicit O_RDONLY=0 and distinct nonzero single-bit
O_NOFOLLOW/O_NONBLOCK/O_DIRECTORY; absent platform flags refuse, never fall back.
Directory flags include all four; regular file flags omit only O_DIRECTORY.
These selected functions and flag semantics are external trusted SDK contracts.

Actual acquisitions are captured before shape/stat validation. Private fresh
opaque tokens never expose native handles; duplicates do not grant another close.
Malformed numeric/null/proxy acquisitions retain UNKNOWN safety candidates without
unsafe close calls. Known own malformed arrays receive one external close attempt.
Every acquired usable handle receives one close attempt, including error paths.
Only undefined close fulfillment confirms disposal after pending operations;
rejection or another fulfillment value retains actual native references permanently.
Quarantine refuses future reads; immutable status exposes only busy/quarantined/owned.
No public retry, path-opening capability or debug API exists.

Only approved public-source handles read bytes; directories and manifest/DSN
references never read/hash. Explicit same-FD positions advance by validated
bytesRead; results require the exact supplied buffer and own-data integer counts.
Node null-prototype read-result records are supported. Positive native reads prove
EOF; no zero-length probe or fabricated boundary EOF is used. Supported sources
are **less than1MiB**; exactly1MiB refuses. Cumulative requested/allocation bytes
are bounded to1MiB+65536 per source before allocation/I/O; pathological partial
progress may exhaust this budget and refuse. Chunks remain at most65536 bytes.
Same-FD restat, post-read pathname identity and pins in both lists remain enforced.

OWN public synthetic native fixtures verify real flags, ancestry, same-FD pins,
symlink/permission drift refusals, zero reference reads and confirmed closures.
This is controlled-local observation, **not atomic malicious-same-UID defense**,
engine authority, effect permission or deployed R04/R05 acceptance. Native Label
compatibility remains UNADMITTED; unknown fake closures are retained, not disposed.

## Next separately admitted steps

- R05a2: real evidence normalization/effect driver, source-derived four migration
  checksums, compiled two-service runner, private trust/NSS and PTY transport.
- R05b: independent real three-context browser/privacy/SSE, stock invariance,
  session limits, desktop/mobile/font/cookie/MIME acceptance and settled cleanup.

Do not run retired runners or inspect/reuse retained manual/R01 resources to fill
these gaps. Parent alone owns real manifests, files, resources, data and Git.
