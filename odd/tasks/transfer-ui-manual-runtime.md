# Latest transfer UI manual runtime

## Goal and authorization
Start the latest tested working-tree frontend for human visual testing at https://localhost:4323, preserving the existing manual database, accounts, stock, private configuration and retained artifacts.
The human explicitly selected `authorize_latest_ui_4323_cutover_preserve_existing_data`: current frontend asset build, existing APP-only replacement with the old APP retained, same DB start, normal backend startup initialization/migration effects, trusted HTTPS/static verification and one anonymous session GET. No login, business mutations, reset, account provisioning, deletion, cleanup, installs, source edits, commits, push, PR or release.

## Scope and constraints
- Repository HEAD: `73c073cbf69805a21d181f2c9ed971a5bb2c36f3`. Approved mockup adaptation all 28 tasks already complete; do not reopen or reuse its burned native authority.
- Build the current working tree, not HEAD alone: protected pre-existing Creation source/test/global style are part of the tested visual environment. Preserve their hashes and all existing dist/cache/untracked files.
- Existing APP: `799e24c64b9fe713005a427e2915a68588d3beca3c59dceda06e5e0f9f91f86f`, `luson-dev-a3732a63-app`, initially stopped; exact backend image `sha256:f2938d86975b120d99411e68c129dac6dabfecf8fe46d10e8c32ad387c273306`.
- Retained older APP `9903b5df60a2ed8b424371a78c6401c735052499a1ca877dc0238afc5f37d835` stays stopped and unchanged.
- Existing DB: `b2d5ff7f921e233883a30713d122f736f6e2781122c1a9a2a36a7c85a0242884`, `luson-dev-a3732a63-db`, initially stopped; PostgreSQL image `sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641`, volume `luson-dev-a3732a63-pgdata`, no published DB port.
- Existing network `luson-dev-a3732a63-net`, ID `365f397ee5ebbd5d1f958b3b71631bfaa13fac92058a57e5e4ab3f82d3ea2c94`.
- Exclusive private artifact root `/home/luis/.local/share/luson/dev-a3732a63/frontend-ui-73c073cb-01/`. Preserve old F6b assets; freeze source, dependency copies, output and manifests in the new root. No dependency downloads. Private parents0700, private metadata0600; only mounted public assets receive required nonroot-readable permissions.
- Preserve APP image, network, nonroot user, read-only root, dropped capabilities, no-new-privileges, exact loopback4323 publication, secrets/TLS mounts and existing configuration. Only change the RO frontend asset source and descriptive runtime identity metadata.
- Private launch configuration, environment values, DB/session data and diagnostics must never appear in tool output, memory or repository. No raw inspect/logs or TLS bypass. Parent owns existing-resource mutations because the dedicated runtime role's historical authorization does not cover them.
- Stop on collision, unexpected identity, source drift or failure; no blind retries, rollback, deletion or expanding scope.

## Tasks
- [x] R1: Current working-tree snapshot and single build PASS; 59 assets/1,555,254 bytes, source/dependency/dist/cache integrity unchanged. Initial authorization timeout and pre-execution syntax failure preserved; corrected AST PASS before the sole actual build.
- [x] R2: Hash-bound corrected cutover executed once successfully. Same DB started/readiness passed; old APP retained stopped; new APP `1d3426eab75459d021272407a3d139e8131fdef1223be773650e25636e166a3b` running with latest RO assets, same backend/config/security/network/loopback4323.
- [x] R3: Independent one-shot verification PASS: exact runtime/configuration/security/storage bindings; trusted CA/hostname/pinned leaf; all59 static files/1,555,254 bytes HTTP200/hash match; exactly one anonymous session GET200/unauthenticated/no-store. Ready for human visual testing.

## Acceptance and checks
Latest current-working-tree assets served byte-for-byte at https://localhost:4323; DB/storage/accounts retained; APP hardening and secret mounts preserved; no authenticated or business requests. Leave the selected APP/DB running. Browser trust and actual visual/business acceptance remain the human's checks. Existing bundle-size warning and previously documented visual/deferred scope are not silently fixed by startup.

## Progress and evidence
- Read-only exploration identified `odd/tasks/frontend-fidelity-manual-smoke.md` as superseding older manual ledgers; frozen F6b assets are not latest all28 UI.
- Selected Docker preflight confirmed APP799e and DBb2d5 stopped; no listener4323. DB exact image/volume/network match; dedicated runtime preflight reported TLS chain/localhost fingerprints valid, frontend tools/dependencies available and backend unchanged.
- Fresh task/artifact paths absent, HEAD correct and index empty before this task document was created.
- This is an operational run with no authorized source change or Git delivery. Task metadata remains local/uncommitted; no work-unit commit is authorized or implied.

### R1 evidence
Verifier continuation `mve84n0t-k-ygqh` passed AST validation and exactly one `npm run build -- --outDir /home/luis/.local/share/luson/dev-a3732a63/frontend-ui-73c073cb-01/assets --emptyOutDir=false` from private source. Known >500 kB chunk warning remains. Initial command-authorization query expired without execution; next orchestration failed parsing a nested command-recording literal before any Python body/build. Corrected command removed self-reconstruction; no unchanged retry or artifact overwrite.
Source provenance aggregate `f32a482fec314ad024a3cb4c616cb5885b5eda3ee097ed835f84cba51b635ec1`; asset manifest SHA `0813d45c929b9ed1c5922e0e78b5892487f27b1b4f83f5f1c2e056afa2c4c300`; canonical before/after `abdf11ea81581fca004d9e770c93213515f99fa3bdf65f68b053566dcf11379e` across 7,863 web entries and 20 task documents. Dependency copy byte-identical. Private build.log/build-result.json/integrity.json/source-provenance.json/assets-manifest.json/assets-files.sha256 retained. Index SHA `b7df3532280fd9ebc38b6ec14ed78c06e2fe16fb235bb372b147fc0feff8dfd7`; entry JS `assets/index-COANyAW-.js`, CSS `assets/index-o_tQPxzG.css`. Canonical source/dist/dependencies/caches unchanged.

### R2 admission-only incident
Parent script `cutover.py` SHA `515c437795383cb388ec2731f6d4a46a08215745f96452809aa811e03dce0d8a` passed independent static review. Its single execution stopped at the first manifest admission check, before Docker API access: R1 reported a canonical compact-JSON aggregate, while the script compared raw pretty-printed bytes. Private runtime/failure evidence records admission/asset-manifest-drift, zero attempted API mutation receipts, zero successful mutations and null replacement ID. No DB or APP start occurred.
Read-only diagnosis proved raw manifest SHA `eeba83b988c472ce9b64a98d5d6ecd50ff3c771551bef25a588bb35cec0f0a0b` and sorted compact-JSON SHA `0813d45c929b9ed1c5922e0e78b5892487f27b1b4f83f5f1c2e056afa2c4c300`. Assets did not drift. Preserve the failed attempt; new `cutover-02.py` uses fresh runtime-02 receipts and checks BOTH hashes without changing other protection. AST PASS, SHA `b47ee62551561fe4510eb260e57d4e5b8fc361b3671c161c8e51a3cc67c5aa41`. Corrected technical admission is within the existing human scope; no actual startup has yet been attempted. Independent exact-diff review is pending; no unchanged retry.

### R2 startup outcome
Independent exact-diff/hash review `mve8dewq-m-c5mi` passed the dual-hash correction and prepared R3 verifier. Parent executed only hash-bound `cutover-02.py` SHA `b47ee62551561fe4510eb260e57d4e5b8fc361b3671c161c8e51a3cc67c5aa41` once; exit0/started. Replacement APP `1d3426eab75459d021272407a3d139e8131fdef1223be773650e25636e166a3b`; existing DB `b2d5ff7f...` started once and passed bounded readiness. Prior APP799e retained stopped as `luson-dev-a3732a63-app-retained-ui-799e24c64b9f`; older9903 untouched. Private runtime-02/handoff.json, baseline/launch payloads and attempt/success receipts retained. Ordinary startup effects were authorized; no claim of zero DB writes. Independent HTTP/readiness verification remains pending.

### R3 independent readiness and handoff
Verifier `mve8fqeb-n-3xzx` executed only hash-bound verify-runtime.py SHA `ab3d1bbc6c83e57c0b42f08978ee62fa5377c3dbd60f5126fe69f4b40bedeb64` once, exit0/PASS. All59 static files/1,555,254 bytes returned HTTP200 with exact bytes/SHA; CA/hostname/served leaf passed. Exactly one anonymous session GET returned HTTP200, unauthenticated, valid CSRF shape and no-store; sensitive headers/body stayed in owner-only private evidence and were not read or emitted. No authenticated/business requests. Complete configuration/hardening/network/mount/storage comparisons passed; APP1d3426ea and same DBb2d5 remain running, prior799e retained stopped. Result: private verification/result.json.
Parent independently fetched only the public index with trusted CA and reproduced SHA `b7df3532280fd9ebc38b6ec14ed78c06e2fe16fb235bb372b147fc0feff8dfd7`; selected Docker inspection confirmed newAPP/DB running, oldAPP stopped and loopback4323 only. This was an additional static request, not a second session probe.
All three operational tasks are complete; no repository source changes, credential changes, installs, cleanup or commits were performed. Tracking metadata is intentionally uncommitted. Known build warning and original failed preparation/admission evidence remain preserved. Runtime health checks do not establish browser trust, human visual acceptance or full business E2E; normal startup effects were authorized and zero DB writes is not claimed.

## Next step
Human opens https://localhost:4323, hard-refreshes (Ctrl+Shift+R) and uses the existing accounts. Leave APP/DB running. Actions confirmed by the human persist in the existing test database. Record specific visual/business findings when reported; no automated login, business smoke, publication or further runtime mutation is scheduled. Report any browser certificate warning rather than bypassing TLS.
