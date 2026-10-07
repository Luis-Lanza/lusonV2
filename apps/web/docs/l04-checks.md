# L04 worker check record

## Disposition

Frontend source candidate and worker self-checks only. **Real Go/PostgreSQL/browser rendering and cleanup are PENDING the separate parent-delegated verifier.** This record does not close L04, L05 or the vertical slice, and is not native review authority.

The complete updated canonical task document was read before writing. The injected `gentle-ai/SKILL.md` was read successfully. Initial inspection found no `apps/web` directory; existing untracked `.codegraph/`, root README, API and ODD files were preserved. All worker writes are inside `apps/web`: source, package/lock/dependencies, `.cache`, `dist`, tests and these docs. No Docker, Go build, bootstrap, PTY, private external fixture or real runner was executed by this worker. No Git staging/commit/remotes/publication/RDD operation occurred.

## Dependencies — observed, independent root commands

```sh
NPM_CONFIG_CACHE=$PWD/apps/web/.cache/npm PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm --prefix apps/web install --save-exact react@19.3.0 react-dom@19.3.0 @fontsource/inter@5.3.0 lossless-json@4.3.1
NPM_CONFIG_CACHE=$PWD/apps/web/.cache/npm PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm --prefix apps/web install --save-dev --save-exact vite@8.3.3 @vitejs/plugin-react@6.1.2 typescript@7.0.2 tailwindcss@4.3.3 @tailwindcss/vite@4.3.3 vitest@5.0.3 @testing-library/react@16.3.3 @testing-library/dom@10.4.2 @testing-library/user-event@14.6.7 @testing-library/jest-dom@7.0.1 jsdom@30.1.2 @types/react@19.3.0 @types/react-dom@19.3.0 @types/node@26.6.4 @playwright/test@1.62.1
```

Both exited0. First added5 packages; second added120; audit reported0 vulnerabilities. Browser download was disabled. All requested versions are exact package/lock pins. No system or browser installation occurred.

## Test-first evidence

| Phase | Exact command | Observed result |
| --- | --- | --- |
| Compiling scaffold | `npm --prefix apps/web run typecheck` | exit0 before behavioral implementation |
| Initial RED | `npm --prefix apps/web run test` | exit1:45 failed/1 passed,3 files; no import or environment failures |
| First implementation | `npm --prefix apps/web run test` | exit1:45 passed/1 failed; branch test mock incorrectly returned location1 for location2; repaired isolated mock mapping, not credited as product RED |
| GREEN | `npm --prefix apps/web run test` | exit0:46 passed/0 skipped,3 files |
| Additional binding RED | `npm --prefix apps/web run test` | exit1:2 failed/46 passed; relative manifest path remained relative and descriptor parse returned empty object |
| Triangulate/refactor | `npm --prefix apps/web run test` | exit0:51 passed/0 skipped,3 files; rerun green after focus timing/pager clarity refactors |
| Final tests | `npm --prefix apps/web run test` | exit0:52 passed/0 skipped,3 files; added coverage proves immediate expiry clearing/focus while anonymous refresh stalls and no second focus steal |
| Final typecheck | `npm --prefix apps/web run typecheck` | exit0; includes parsing authored e2e JavaScript, without executing it |
| Final build | `npm --prefix apps/web run build` | exit0; Vite8.3.3,33 modules, local font assets and compiled CSS/JS |

Initial RED assertions observed missing login labels/table/zero-availability presentation; parser stubs discarded exact numeric data, accepted invalid quantities/capacities/bounds and omitted query mapping/grouping; binding accepted12 invalid in-memory descriptors/inspection combinations. Component tests were authored before behavior. Deep stale/expiry/logout/paging assertions were reached in GREEN, not separately observed failing at those individual assertions; do not overstate the RED trace.

Current52 tests exercise (the final pending-refresh test is coverage-only, not a separately observed RED):

- Anonymous session200/CSRF without expires; authenticated restoration without login POST; exact login body/CSRF/cookies; password clearing/no browser storage; bad credentials with fresh anonymous CSRF retry.
- Logout204 plus refresh/focus; rejection of a200 logout; truthful400/403/429/503 form messages; expiry clearing all protected state and focusing login.
- Literal Unicode/search mapping, optional omission, AND brand/polarity, page and size resets, selected location state and unchanged assignment; no ordinary-fetch focus theft.
- Obsolete success, obsolete401 and obsolete rejected fetch despite ignored AbortSignal; abort observation across filter/paging/size changes; late protected errors after logout and another login.
- Current service errors clear results; 128 UTF-8-byte/NUL/unpaired-surrogate bounds prevent a request; page-local ordered grouping/singletons; warehouse-only mobile renderer and native disabled controls; positive existing with server available0 says `Sin disponible`, never `Sin stock`.
- Exact quantity9007199254740993 beyond2^53, int64 maximum, exact6.5/canonical trailing zeros/tiny decimal, malformed numeric tokens/JSON/shapes, bounded IDs/pages/counts and duplicate variants.
- Exact active network binding, missing/inactive/malformed/mismatched/extra ownership labels and nonempty inspection; canonical-root relative paths. All inspections are in-memory test values, not Docker.

## Passive design and harness qualification

All three actual cached images and targeted HTML references were read. The desktop `.png` is JPEG and scaled, not a CSS-pixel reference. Source implements Inter, the exact wine/hover/tint/page/border/text palette,420px login card,240px sidebar,56px header,44px table rows, warehouse390px maximum/16px spacing/64px bottom navigation/112px clearance. Zoom remains enabled and there is no global selection prohibition. Existing role/initials/pending badges were replaced/removed rather than invented.

Styles/docs have no meaningful behavioral RED; actual build passed. The authored real specifications assert the target geometry, palette, local font loading,9 account/location matrix and full mobile scrolling against actual server data. **No browser layout, compatibility, PTY or lifecycle PASS is claimed here.** Python/harness runtime behavior is unexecuted. No visual screenshots were produced.

Future verifier-only command, NOT run by this worker:

```sh
LUSON_TEST_NETWORK=luson-l04-test-isolated-44fea1f86fda LUSON_TEST_NETWORK_MANIFEST=/home/luis/velay/luson_v2/odd/evidence/login-inventory/l04-test-network.json node apps/web/e2e/run-real.mjs
```

There are no known environmental failure exemptions or skipped tests. The verifier must run the actual fixture and report observed protocol/geometry/assertion/cleanup results before any L04 closure. Loopback HTTP is not operational HTTPS; fixture processes are not three deployed services.

## Immutable baseline

Read-only command, exit0:

```sh
python3 -c 'import hashlib,json,pathlib; files=json.loads(pathlib.Path("odd/evidence/login-inventory/l03-source-baseline.json").read_text())["files"]; changed=[p for p,h in files.items() if hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()!=h]; print(f"Baseline: {len(files)} files, {len(changed)} changed"); print("\n".join(changed)); raise SystemExit(bool(changed))'
```

Observed: **36 files,0 changed**. No Go/API/config/auth/SQL/CLI/module/catalog/root README exception was taken. Parent descriptor and network ownership remain untouched.
