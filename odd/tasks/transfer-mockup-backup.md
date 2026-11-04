# Transfer mockup backup

## Goal and authorization
Preserve the transfer-detail design evidence before a separately authorized frontend adaptation. User explicitly selected **backup only**. No application/source edits, backend changes, runtime updates, business operations, commits, publishing, or new Stitch generation.

## Scope
- Existing evidence under `odd/design/transfer-detail-ux/` and its design task document `odd/tasks/transfer-detail-ux.md`.
- Current design project `5192357064021617628`; retain historical/superseded proposals, user-approved references, and unverified artifacts without conflating them.
- Original project `6509355458249521776` remains untouched; existing backups are references, not a request to re-export unrelated designs.
- Local initial inventory: 72 files, approximately 9.7 MB. This is not yet a completeness guarantee.

## Tasks
- [x] B1: Read-only explorer `mvbbvd0b-5-lgcn` reports 72 local files (36 PNG, 36 JSON), 35 distinct generated screen IDs in structured responses plus historical full-shell-01 `2c4fa57f9d54450fb63c45226c0ac9dd` recorded only in task/PNG. Pending `0cbc54a85a814d4aa3294b558ffac916` has two JSONs/no PNG. Explorer lacks exec/Stitch/memory; byte counts/hashes and recursive parsing belong to backup writer. Baseline dirty app diff SHA-256: `53fa2bd638b7181c9685ba8fca1dc2a33c727ff02539c9645153bc0247df8ab0`.
- [x] B2: Writer `mvbbxtl6-6-ajp3` created additive snapshot `backups/stitch/transfer-detail-ux-20261016T185630Z/` (73 payload files, 79 total), registry, manifest, README, one-shot builder/verifier and SHA256SUMS; sibling archive 7,285,663 bytes and `.tar.gz.sha256`. Writer self-checks passed: 72 designs (36 PNG/36 JSON), exact task snapshot, 9,962,600 payload bytes, 36 screen identities and zero unidentified PNGs. Archive SHA-256 `41e7a7dcc6a11d2adfa8dd68f971ded77daed3449dce9b33e50eed4399ae67fd`. App diff hash unchanged. Originals and unrelated prior backup untouched; no commits.
- [x] B3: Independent verifier `mvbc25uk-7-cha7` PASS: all 73 payload files match originals byte-for-byte; 79 snapshot files, all 78 non-checksum files covered; safe tar contains 79 regular files and 6 directories, no links/special/duplicate/unsafe members, all bytes match snapshot. Independently reconciled 36 identities (35 current/1 original), all 36 PNGs uniquely registered, known gaps correctly disclosed. Writer verifier, snapshot checksums, sibling archive checksum and independent stdlib checks passed. App diff SHA-256 and Git status unchanged before/after verification; no unexpected source mutation. Parent reran sibling archive checksum successfully. Native read-only ASSESS unavailable due ambient undeclared untracked files; its independent-verifier fallback was satisfied, with no authority mutation. No application tests needed for passive preservation; no commits.

## Acceptance criteria
Every existing scoped evidence file is preserved byte-for-byte in a clearly identified snapshot, with checksums and screen provenance. A registry distinguishes approval status from image availability and visual inspection; unknowns stay unknown. Missing remote/local images are explicitly listed rather than reconstructed or reported as complete. The backup can be inspected offline without relying solely on remote URLs. No credentials are collected.

## Known limitations
Screen `0cbc54a85a814d4aa3294b558ffac916` (Sucursal B pending restitution) was generated but its PNG could not be downloaded or visually inspected: exact metadata repeatedly returns an API-only file URL and the partial inventory omits it. Preserve its raw response and mark the image missing/unverified. No blind regeneration. Static mockups do not establish behavior, accessibility, responsive fidelity, or exact viewport.

## Verification strategy
This is passive backup work, not a behavior change; deterministic RED/GREEN application tests do not apply. Use structural readback, cryptographic hashes, archive listing/readability, registry checks, and an isolated scope check instead. No commits are authorized.

## Next step
Backup complete for the existing LOCAL evidence scope. No frontend adaptation starts without separate user authorization. Originals and prior backups remain untouched. Archive: `backups/stitch/transfer-detail-ux-20261016T185630Z.tar.gz`; index: `backups/stitch/transfer-detail-ux-20261016T185630Z/README.md` and `screen-registry.json`.

## Independent verification caveats
Registry approval conclusions remain supported, but three extraneous secondary approval citations point to unrelated task entries (`screen-registry.json:1419`, `:1469`, `:1519`), and `:817` cites a section heading one line before its substantive acceptance statement. No demonstrated approval misclassification or integrity blocker. Preserve the verified timestamped snapshot rather than silently rewriting it; consult the exact copied task and correct supporting citations. Pending restitution PNG, historical full-shell-01 raw response, remote HTML/design-system exports and remote-project completeness remain unavailable/not claimed. These do not invalidate complete preservation of the 72 existing local design files.
