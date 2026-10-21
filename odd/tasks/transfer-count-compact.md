# Compact transfer count management
Implement the selected Stitch count-management designs inside the existing transfer detail.
Preserve the transfer table, domain rules, permissions, recovery and existing modal workflows.

## Specs
- S1: "ok! entonces guardamos los mockups finales y a implementar en una rama nueva pa"
- S2: "recuerda que estamos dentro de las vista que debe mostrar la tabla de la tranferencia, etc no?"
- S3: "aqui nmo me gusta como se ve la seccion de restituciones de origen o de corregir conteo." This unit covers count corrections only; restitution redesign is separate.

## Tasks
- T1 [completed] S1 — Archive the five selected final mockups and source metadata; route: parent asset retrieval + worker archive; commit: pending.
- T2 [completed] S1-S3 — Implement compact count management and secondary audit disclosures, reusing existing forms and authority helpers; route: worker; commit: pending.
- T3 [partial] S1-S3 — Verify focused/full tests, typecheck/build and synthetic browser desktop/mobile roles; route: worker self-check + parent assessment; commit: pending.

## Log
- L1: "ok! entonces guardamos los mockups finales y a implementar en una rama nueva pa"
- L2: Branch fix/transfer-count-compact created from master dda4e77. Existing dirty ODD documents and untracked files remain excluded. No runtime/DB changes authorized in this implementation unit.
- L3: Final Stitch project 5192357064021617628; overview36e9038241de4aa6b9565397632c2777, reviewer17e5d3fe9cdd4c55ba23567a1a2b8fba, waiting657e7b01563c47bd838a064988a86a8a, mobile waiting430452650a6645cc8eab7afab47897a8, mobile reviewer f107ba64901540099f8743900a51df63. HTML must be fetched fresh; screenshots can lag DOM-only edits and are not pixel-truth for edited screens.
- L4: Initial worker had no Stitch tools and made no edits. Parent retrieved fresh get_screen metadata for all five to unblock asset handoff. No tests run yet.
- L5: Archived all five original HTML/PNG pairs without executing their scripts; manifest.json records titles, IDs, UTC retrieval time, byte sizes and SHA-256 hashes. PNGs may lag DOM edits. Delivery slices: design archive/tracking, then count-only implementation/tests/docs (target ~400 authored lines).
- L6: Focused RED observed: 3 new tests failed (missing pending summary and history disclosure), 167 existing passed. GREEN: all 170 passed. Count-only overview uses aligned desktop columns and labeled mobile blocks; exact audit content retained in disclosures. No business handlers or modal helpers changed. Engram mirror unavailable: gentle-engram/core capability incompatibility.
- L7: Full suite 2581 tests/36 files, typecheck and build all exit 0. Build reports >500 kB chunk advisory. Synthetic Chromium at 1280 and 390 for both endpoint roles passed overflow, touch target, disclosure, modal focus restoration and zero writes checks after one probe-module correction. See odd/design/transfer-count-compact/verification.md. Main table/restitution preservation checked by isolated source diff; no integrated-page browser claim. S1-S3 covered within count-only scope; restitution redesign remains separate.
- L8: Parent reopened T2/T3: secondary count technical/application evidence, visible pending reason, and integrated actual-App synthetic browser proof required. One bounded correction batch; no business scope expansion.
- L9: S1/S3 correction implemented: count technical evidence and applied-effect text moved inside collapsed history; exact pending reason now visible before consultation. No quantities, dates, audit content, guards, actions or forms removed. RED: new rule failed (missing raw pending reason), 170 existing passed; GREEN: 171 focused passed. Full suite 2582/36 files, typecheck and build exit 0.
- L10: S2 integrated proof remains missing. Single bounded actual-App probe exited 1 before launching Chromium: dynamic CJS import exposed no named chromium export (`Cannot read properties of undefined (reading 'launch')`). No integrated screenshots or results produced; no retry under bounded-attempt instruction. T3 partial, not complete. Prior isolated screenshots predate L9 and do not prove final integrated layout. Probe retained in design folder for parent diagnosis.
