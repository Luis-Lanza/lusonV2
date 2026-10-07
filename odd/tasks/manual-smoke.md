# Manual smoke environment

## Goal and authorization

Start the verified Luson login/inventory vertical for a human Windows Chromium smoke test, using fictional stock and a separate persistent volume. The user approved HTTP restricted to loopback inside an encrypted SSH tunnel, without installing a CA or disabling browser certificate validation. Account provisioning remains human-only through the private hidden-input CLI. This is runtime setup, not new application behavior or operational rollout.

## Runtime boundaries

- Exactly two deployed services: nonroot Go SPA/API and PostgreSQL17.9.
- HTTP is permitted only by existing local-trial policy: origin and listener must both be loopback, and TLS settings absent. No source-policy relaxation.
- The private Compose app uses host networking solely to bind 127.0.0.1:4322, read-only rootfs, dropped capabilities and no-new-privileges. No app port publication or public listener.
- PostgreSQL remains on a newly owned private bridge with no host publication and its own persistent named volume. Allocate a fixed DB address from the new network's actual assigned subnet and store a private file DSN; never invent or reuse a subnet/address.
- Browser origin: http://localhost:8443. Windows SSH local127.0.0.1:8443 forwards to luis-ai127.0.0.1:4322. Different local/remote ports are intentional.
- Remote4321 belongs to an unrelated Node process and must remain untouched. Existing Docker services on8443/54329/55464 are unrelated.
- Reuse only inspected final candidate image44eb677d8af202c7681e1984326b67b60815a0c52f1137a7466c9aa73b10fcc8, user1000:1000, pinned by full image identity; no historical missing-image or retired test-binding reuse.
- Fresh project, network and volume names with explicit owner/manual-persistent/fictional labels. Reject collisions; record full container/network identities and real volume metadata outside the repository. Never adopt unrelated resources or delete operational data.
- Runtime configuration and database secrets outside the repository in a newly created0700 directory, files0600 owned by1000. Only secret-file paths in container environment. No account credentials in files, environment, argv or chat.
- Leave app/db, fictional-data volume and private configuration running/preserved after success. No automatic teardown, pruning or volume deletion. Persistent volume is not a backup.
- No CA stores, certificates, browser bypass flags, system installations, other project services, Git delivery or RDD settings changed. Source behavior is unchanged; only this ODD record is created in the repository.

## Tasks

- [x] **M01 — Resolve safe local transport and runtime topology.** Existing ParseAuth local-trial loopback-only HTTP rule verified; parent identified occupied4321/free4322 and inspected final image/user. Recorded separate host-loopback app/private bridge DB plan and private human bootstrap constraints.
- [x] **M02 — Create and start the isolated persistent manual runtime.** Sole runtime executor owns private external configuration and new manually persistent resources. Safety readback before effects; check exact identities, nonroot listener, unpublished DB, schema/catalog/trial balances, zero accounts, real SPA/API/static responses, no credential output, protected-source preservation and unrelated resource preservation. Do not claim authenticated human smoke before provisioning. Independent muxkuxt9-2u-shsu PASS: fresh exact ownership guards plus all570 source-aligned rows/8565 total/zero mismatches; prior72 HTTP/config/source83 checks carried. Accounts were absent at this startup verification; later human provisioning is recorded below.
- [x] **M03 — Deliver private provisioning and manual test instructions.** Provided corrected Windows tunnel and HTTP URL, private-TTY bootstrap instructions, test checklist and stop-without-volume-deletion guidance. The user subsequently reported successful three-account provisioning and overall manual smoke acceptance. Optional checklist cases have no itemized execution evidence.

## Checks and evidence

No meaningful test-first RED exists for runtime-only configuration using unchanged compiled sources. Prior independent2990 seven-command functional/TLS acceptance remains historical evidence; do not rerun retired fixtures or claim a new authenticated browser acceptance. Perform ordinary actual startup, configuration, listening-address, anonymous HTTP and resource-identity checks. Check HTTP cookies are intentionally not Secure for this local-trial transport; HTTPS/Secure-cookie evidence is not reclassified as HTTP.

No passwords, URLs containing database credentials, tokens, cookies, private keys, private account hashes or populated-form screenshots in logs/tool output. Diagnostics are bounded and sanitized. The original runtime-only request did not authorize a delivery commit. After successful human smoke feedback, the user explicitly requested a local commit of this record. Only this document is included; private configuration, database contents and unrelated task histories are excluded. No push, remote, merge or RDD change is authorized.

## Progress and continuity

M01–M03 complete for runtime setup and instruction handoff. Independent muxkuxt9-2u-shsu PASS after one bounded readonly SQL command exit0 with fresh full app/DB/image/labels/configHash/network/volume identity guards. All570 balances match unchanged seed.go:90; each location has190 rows, existing2842/2855/2868=8565 total,0 mismatches/0 reservations,available=existing. Accounts0/sessions0 at verification. Prior muxkqtm8-2t-y51x72 HTTP checks/configuration/private permissions/83 tracked-source HEAD and hash checks passed and were carried, not rerun. The user later reported successful human provisioning and overall manual acceptance; this is user-reported evidence, not a new independent browser run.

Running project luson-manual-smoke-5cf214a8, private root /home/luis/.local/share/luson-manual-smoke-5cf214a8. App fullID2bd6d236adbb4a782b6cf0ae19dcfa04aeb0221913da3f68c7b55c72c2f2d0be; DB fullID9bb37b34c6df1336639833589e90204511e6222887bf30c553a6d2d96aa9b0b9; network fullID85f205faa63441f0774ddca7fe10d32e23e90ac47aea749a0ee282f6a0faa123; named volume luson-manual-smoke-5cf214a8-pgdata. Private runtime.json records full metadata/labels/config/image hashes and status ready-for-human-provisioning. Parent freshly matched both running container identities before this status-only update. Two services and all manual resources/private configuration persist; no teardown.

Historical failed checks retained: initial verifier role refused creation before any effect; parent post-start audit mistakenly compared short Docker ps IDs to full inspect IDs (fixed in bookkeeping without restart); two readonly verifier checks mistakenly required all18 historical containers running (18 identities resolve,5 running and others historically stopped/created); one SQL check mistakenly required2510 units. Parent verified observation2510 is a decision ID, not a quantity requirement; original scope requires fictional stock/no manual adjustments, no fixed total. Source formula8565 and all rows independently passed. No business data, code, account, reseed or service correction was made. Initial unrelated baseline used18 unique short prefixes, not a full-ID/port/state baseline; current independent identities match. Node4321 and existing ports8443/54329/55464 untouched; no helper containers.

## Human handoff and reported manual acceptance

The commands below document the original handoff. The user provisioned the accounts directly in the server's private Fish terminal and reported `Three accounts provisioned.` Do not rerun bootstrap after success. The first rejected attempt reused passwords; the user resolved it privately with distinct credentials, without source changes.

The user then reported: "uta estoy sorprendido todo funciona 10 de 10" (acceptance observation3039). This records overall functional smoke approval, not proof that every optional expiry, network-failure, restart or accessibility case was executed. No credentials were shared or read.

For a future browser session, close any previous Windows tunnel targeting remote4321 with Ctrl+C. Run in PowerShell and leave open:

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8443:127.0.0.1:4322 luis@luis-ai
```

Open http://localhost:8443 (exact localhost HTTP origin; not https or127.0.0.1). In another private, unrecorded PowerShell terminal, provision once:

```powershell
ssh -t luis@luis-ai "docker compose -p luson-manual-smoke-5cf214a8 -f /home/luis/.local/share/luson-manual-smoke-5cf214a8/compose.yaml exec -it app /usr/local/bin/bootstrap-accounts"
```

Enter hidden username/password/confirmation for Almacén, Sucursal A and Sucursal B. Three distinct usernames (3–64 ASCII letters/digits/_.-) and three distinct passwords (12–128 valid UTF-8 bytes, no NUL); do not send or record credentials. No default accounts exist. Replay refuses overwrites. After success, test each login/assigned identity, consultation of all locations, literal/combined filters, page10/25/50, warehouse mobile390px, reload and logout. Disabled transfer controls are expected, not an implemented workflow.

Human provisioning and overall manual smoke are reported successful. Optional cases remain unitemized, not silently marked PASS. SSH tunnel closure does not stop server containers or erase fictional data. If stopping the environment is requested, freshly validate ownership then stop only its app/db without volume removal; no destructive cleanup recipe is handed off. Services and fictional data are preserved; no operational rollout or backup claim.

The user authorized a local documentation commit after acceptance. Existing application commits623edb1/1684df0 are preserved; this record's actual commit identity is stored externally in Engram to avoid a self-referential hash. No push, application behavior or RDD changes. Task mirror odd/manual-smoke/tasks observation3007. All executor tasks settled; no active writer/verifier.
