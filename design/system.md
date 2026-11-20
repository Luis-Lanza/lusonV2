# Luson visual system

Synced on 2026-11-20 from **all 16 stylesheets** under `apps/web/src` (3 191 lines), not from `style.css` alone as the 2026-11-16 file was. Read-only: no project source was modified. This is not a proposed starter: every value below exists in the sources.

What this sync added over the previous file: the 15 section stylesheets that grew after that sync (`stock-entry.css`, `catalog-prices.css`, `point-of-sale.css`, `closings.css`, `stock-adjustments.css`, `administration.css`, `password.css`, `transfer-actions|approved|cancellation|detail|dispatch|receipt|received|transit.css`, `TransferUnifiedReconciliation.css`), the color representations of those 15 files (69 distinct now, 35 of them in `style.css` alone), the `#0000` transparent border, the 11.5 / 12.5 / 13.5 px sizes, the `kbd` component, the sticky rail and sticky action bar, and the pressed-state `inset` shadows. No value was removed. `TransferUnifiedReconciliation.css` is one line of a single import-level rule and contributes no token.

## Sources read

| File | Lines | What it carries |
|---|---|---|
| `apps/web/src/style.css` | 1 267 | `:root` tokens, base controls, shell (sidebar, top bar, main padding), tables, pager, kind/supplier steps, metrics band, modals and backdrops, mobile shell |
| `apps/web/src/stock-entry.css` | 129 | the Ingresos screen: panels, supplier choices, kind step, stock table, totals bar, history, reversal and detail dialogs, three breakpoints |
| `apps/web/src/catalog-prices.css` | 116 | catálogo de precios: panel, kind tabs, filters, expandable table row, price form, chips |
| `apps/web/src/point-of-sale.css` | 160 | sale workspace: `1fr + 380px` layout, sticky cart, line controls, payments |
| `apps/web/src/closings.css` | 280 | settlement workspace: `1fr + 380px` layout, sticky table head, sticky action bar, `kbd` legend, outside/changed row markers |
| `apps/web/src/stock-adjustments.css` | 84 | adjustment screen: panels, totals, dialog |
| `apps/web/src/administration.css` | 57 | account administration panels and table |
| `apps/web/src/password.css` | 10 | password form card |
| `apps/web/src/transfer-actions.css` | 50 | pending action summary: warm notice palette, category list, icon tile |
| `apps/web/src/transfer-approved.css` | 151 | approved transfer detail: soft table head, approved pill |
| `apps/web/src/transfer-cancellation.css` | 14 | cancellation notice |
| `apps/web/src/transfer-detail.css` | 316 | transfer detail panels and status list |
| `apps/web/src/transfer-dispatch.css` | 73 | dispatch panel |
| `apps/web/src/transfer-receipt.css` | 205 | receipt modal, matched/different preview cells, step block, footer |
| `apps/web/src/transfer-received.css` | 132 | received detail, matched/difference cells, table foot, skeleton |
| `apps/web/src/transfer-transit.css` | 146 | transit detail and in-transit pill |

No Tailwind `@theme` block, no `tailwind.config.*`, no token file and no component-library folder exist: `style.css` only does `@import "tailwindcss"` and then writes plain CSS. The six custom properties below are the whole token layer.

## Colors

**69 distinct representations, 359 occurrences**: 68 colors plus the `#0000` transparent keyword. Six are declared as custom properties; the rest are literal (documented here with an alias). `#fff` and the `white` keyword are recorded as `#FFFFFF`; hex case is normalized to upper case; alpha suffixes are kept exactly as written.

### Custom properties declared in the source

All six live in the `:root` block of `apps/web/src/style.css` (lines 8–13) and are the only CSS custom properties across `apps/web/src/*.css`.

| Token | Value | Source | Used for |
|---|---|---|---|
| `--wine` | `#7A1F3D` | `apps/web/src/style.css` | primary action, active navigation, focus ring, selected state |
| `--hover` | `#5B162D` | `apps/web/src/style.css` | primary hover only |
| `--tint` | `#F5E8ED` | `apps/web/src/style.css` | contextual and selected backgrounds, chips, notices |
| `--page` | `#F8F6F4` | `apps/web/src/style.css` | canvas, table head, quiet surfaces |
| `--border` | `#DED7DA` | `apps/web/src/style.css` | decorative dividers, panel edges |
| `--muted` | `#6B6267` | `apps/web/src/style.css` | secondary text, labels, quiet marks |

### Literal values (documentation aliases, not custom properties)

The table below holds every color representation the sources write out literally, including the six values above (they are repeated as literals across the section stylesheets) and the `transparent` keyword. The alias is documentation only; the value is the token. Ordered by occurrence count.

| Alias | Literal value | Occurrences | First source | Usage (first selector) | Also in |
|---|---|---|---|---|---|
| `ink` | `#242124` | 43 | `apps/web/src/style.css:5` | `:root` | style.css (16), point-of-sale.css (6), closings.css (5), stock-entry.css (3) |
| `muted` | `#6B6267` | 32 | `apps/web/src/style.css:13` | `:root` | transfer-detail.css (9), transfer-received.css (8), transfer-approved.css (6), transfer-transit.css (6) |
| `reject-ink` | `#991515` | 30 | `apps/web/src/style.css:619` | `.transfer-decision .transfer-reject` | closings.css (13), style.css (5), transfer-detail.css (5), transfer-cancellation.css (3) |
| `border` | `#DED7DA` | 23 | `apps/web/src/style.css:12` | `:root` | transfer-detail.css (7), transfer-received.css (6), transfer-approved.css (4), transfer-transit.css (4) |
| `wine` | `#7A1F3D` | 17 | `apps/web/src/style.css:8` | `:root` | transfer-actions.css (5), transfer-detail.css (4), transfer-received.css (4), transfer-dispatch.css (2) |
| `surface` | `#FFFFFF` | 17 | `apps/web/src/catalog-prices.css:9` | `.catalog-panel` | point-of-sale.css (4), catalog-prices.css (3), stock-entry.css (3), administration.css (3) |
| `received-ink` | `#047857` | 16 | `apps/web/src/style.css:465` | `.pending-list .pending-status.status-received` | style.css (6), point-of-sale.css (4), closings.css (4), stock-adjustments.css (2) |
| `soft-shadow` | `#2421240D` | 14 | `apps/web/src/style.css:44` | `.login-card` | style.css (7), point-of-sale.css (2), catalog-prices.css (1), stock-entry.css (1) |
| `shortage-border` | `#FFDAD6` | 13 | `apps/web/src/style.css:565` | `.receipt-discrepancy.shortage` | closings.css (6), style.css (4), point-of-sale.css (2), stock-adjustments.css (1) |
| `shortage-bg` | `#FFF0F0` | 12 | `apps/web/src/style.css:565` | `.receipt-discrepancy.shortage` | closings.css (5), style.css (4), point-of-sale.css (2), stock-adjustments.css (1) |
| `warning-border` | `#E8CF86` | 10 | `apps/web/src/style.css:566` | `.receipt-discrepancy.excess, .receipt-discrepancy.unexpected` | style.css (6), closings.css (4) |
| `page` | `#F8F6F4` | 10 | `apps/web/src/style.css:6` | `:root` | transfer-detail.css (5), transfer-dispatch.css (3), style.css (2) |
| `warning-bg` | `#FFFBEF` | 10 | `apps/web/src/style.css:566` | `.receipt-discrepancy.excess, .receipt-discrepancy.unexpected` | style.css (6), closings.css (3), transfer-receipt.css (1) |
| `warning-ink` | `#805400` | 8 | `apps/web/src/style.css:566` | `.receipt-discrepancy.excess, .receipt-discrepancy.unexpected` | style.css (5), closings.css (3) |
| `received-bg` | `#ECFDF5` | 8 | `apps/web/src/style.css:465` | `.pending-list .pending-status.status-received` | style.css (3), point-of-sale.css (3), closings.css (1), stock-adjustments.css (1) |
| `received-border` | `#A7F3D0` | 7 | `apps/web/src/style.css:465` | `.pending-list .pending-status.status-received` | point-of-sale.css (3), style.css (2), closings.css (1), stock-adjustments.css (1) |
| `action-alert` | `#BA1A1A` | 7 | `apps/web/src/style.css:66` | `.transfer-action-badge` | style.css (7) |
| `reject-border` | `#CCAAAA` | 7 | `apps/web/src/style.css:619` | `.transfer-decision .transfer-reject` | closings.css (4), style.css (3) |
| `approved-border` | `#D9B3C1` | 4 | `apps/web/src/style.css:587` | `.transfer-outcome-metrics.approved dl:last-child` | style.css (2), closings.css (2) |
| `decision-backdrop` | `rgb(36 33 36 / 45%)` | 4 | `apps/web/src/style.css:621` | `.transfer-decision-backdrop` | style.css (3), stock-adjustments.css (1) |
| `disabled-ink` | `#595459` | 3 | `apps/web/src/style.css:803` | `.count-corrections button:disabled` | style.css (2), closings.css (1) |
| `disabled-bg` | `#EFEDEF` | 3 | `apps/web/src/style.css:803` | `.count-corrections button:disabled` | style.css (2), closings.css (1) |
| `tint` | `#F5E8ED` | 3 | `apps/web/src/style.css:10` | `:root` | style.css (2), transfer-approved.css (1) |
| `table-head-soft` | `#FCFAFB` | 3 | `apps/web/src/transfer-approved.css:76` | `.transfer-approved-products .transfer-detail-items th` | transfer-approved.css (1), transfer-received.css (1), transfer-transit.css (1) |
| `modal-footer-bg` | `#FDFBFC` | 3 | `apps/web/src/transfer-receipt.css:59` | `.transfer-receipt .transfer-receipt-modal > footer` | transfer-receipt.css (3) |
| `approved-ink` | `#22633B` | 2 | `apps/web/src/style.css:477` | `.pending-status.status-approved` | style.css (1), transfer-received.css (1) |
| `modal-shadow` | `#24212433` | 2 | `apps/web/src/style.css:384` | `.transfer-review` | style.css (1), stock-adjustments.css (1) |
| `received-difference-ink` | `#925400` | 2 | `apps/web/src/transfer-received.css:49` | `.received-difference` | transfer-received.css (2) |
| `receipt-difference-ink` | `#935600` | 2 | `apps/web/src/transfer-receipt.css:110` | `.receipt-preview-difference.different` | transfer-receipt.css (2) |
| `disabled-border` | `#AAA5AA` | 2 | `apps/web/src/style.css:803` | `.count-corrections button:disabled` | style.css (1), closings.css (1) |
| `approved-bg` | `#EDF7F0` | 2 | `apps/web/src/style.css:477` | `.pending-status.status-approved` | style.css (1), transfer-received.css (1) |
| `receipt-effect-bg` | `#F9F6F7` | 2 | `apps/web/src/transfer-receipt.css:111` | `.receipt-preview-effect` | transfer-receipt.css (2) |
| `decision-shadow` | `rgb(0 0 0 / 20%)` | 2 | `apps/web/src/style.css:622` | `.transfer-decision-modal` | style.css (2) |
| `transparent` | `#0000` | 1 | `apps/web/src/catalog-prices.css:19` | `.catalog-kinds button` | catalog-prices.css (1) |
| `restitution-ink` | `#065F46` | 1 | `apps/web/src/style.css:733` | `.transfer-restitutions .restitution-closed` | style.css (1) |
| `receipt-matched-ink` | `#08745A` | 1 | `apps/web/src/transfer-receipt.css:109` | `.receipt-preview-difference.matched` | transfer-receipt.css (1) |
| `received-matched-ink` | `#22763B` | 1 | `apps/web/src/transfer-received.css:50` | `.received-matched` | transfer-received.css (1) |
| `history-positive` | `#23815A` | 1 | `apps/web/src/style.css:593` | `.transfer-history li::before` | style.css (1) |
| `creation-backdrop` | `#24212466` | 1 | `apps/web/src/style.css:302` | `.transfer-creation .creation-dialog-backdrop` | style.css (1) |
| `review-backdrop` | `#24212473` | 1 | `apps/web/src/style.css:383` | `.review-backdrop` | style.css (1) |
| `modal-ink` | `#272327` | 1 | `apps/web/src/transfer-receipt.css:6` | `.transfer-receipt .transfer-receipt-modal` | transfer-receipt.css (1) |
| `hover` | `#5B162D` | 1 | `apps/web/src/style.css:9` | `:root` | style.css (1) |
| `transit-ink` | `#624A53` | 1 | `apps/web/src/transfer-transit.css:42` | `.transfer-transit-detail .transfer-transit-heading .pending-status.status-in_transit` | transfer-transit.css (1) |
| `action-categories-ink` | `#6D5733` | 1 | `apps/web/src/transfer-actions.css:26` | `.transfer-action-categories li` | transfer-actions.css (1) |
| `action-summary-icon-ink` | `#91621E` | 1 | `apps/web/src/transfer-actions.css:21` | `.transfer-action-summary-icon` | transfer-actions.css (1) |
| `alert-ink` | `#9B2424` | 1 | `apps/web/src/transfer-receipt.css:180` | `.receipt-capture [role="alert"]` | transfer-receipt.css (1) |
| `restitution-border` | `#A7D9C3` | 1 | `apps/web/src/style.css:733` | `.transfer-restitutions .restitution-closed` | style.css (1) |
| `receipt-matched-border` | `#A7EFD4` | 1 | `apps/web/src/transfer-receipt.css:109` | `.receipt-preview-difference.matched` | transfer-receipt.css (1) |
| `received-detail-border` | `#BDE2C4` | 1 | `apps/web/src/transfer-received.css:33` | `.transfer-received-detail .pending-status.status-received` | transfer-received.css (1) |
| `action-summary-accent` | `#C38E32` | 1 | `apps/web/src/transfer-actions.css:6` | `.transfer-pending > .transfer-action-summary` | transfer-actions.css (1) |
| `receipt-step-border` | `#D9BCC6` | 1 | `apps/web/src/transfer-receipt.css:34` | `.transfer-receipt-step` | transfer-receipt.css (1) |
| `transit-border` | `#DDBCC7` | 1 | `apps/web/src/transfer-transit.css:39` | `.transfer-transit-detail .transfer-transit-heading .pending-status.status-in_transit` | transfer-transit.css (1) |
| `approved-pill-border` | `#E7C6D2` | 1 | `apps/web/src/transfer-approved.css:39` | `.transfer-approved-detail .transfer-approved-heading .pending-status.status-approved` | transfer-approved.css (1) |
| `action-summary-border` | `#E7D6B7` | 1 | `apps/web/src/transfer-actions.css:5` | `.transfer-pending > .transfer-action-summary` | transfer-actions.css (1) |
| `action-categories-border` | `#E9DDC9` | 1 | `apps/web/src/transfer-actions.css:26` | `.transfer-action-categories li` | transfer-actions.css (1) |
| `receipt-difference-border` | `#EFD18B` | 1 | `apps/web/src/transfer-receipt.css:110` | `.receipt-preview-difference.different` | transfer-receipt.css (1) |
| `receipt-matched-bg` | `#EFFCF6` | 1 | `apps/web/src/transfer-receipt.css:109` | `.receipt-preview-difference.matched` | transfer-receipt.css (1) |
| `skeleton-bg` | `#F2EEF0` | 1 | `apps/web/src/transfer-received.css:60` | `.received-skeleton > span` | transfer-received.css (1) |
| `transit-bg` | `#F4ECEF` | 1 | `apps/web/src/transfer-transit.css:41` | `.transfer-transit-detail .transfer-transit-heading .pending-status.status-in_transit` | transfer-transit.css (1) |
| `notice-overlay` | `#F5E8ED99` | 1 | `apps/web/src/style.css:55` | `.login-notice` | style.css (1) |
| `receipt-step-bg` | `#F5EDEF` | 1 | `apps/web/src/transfer-receipt.css:36` | `.transfer-receipt-step` | transfer-receipt.css (1) |
| `closing-outside-bg` | `#F5F1F3` | 1 | `apps/web/src/closings.css:101` | `.closing-table tr.outside td` | closings.css (1) |
| `action-summary-icon-bg` | `#F7EBD4` | 1 | `apps/web/src/transfer-actions.css:21` | `.transfer-action-summary-icon` | transfer-actions.css (1) |
| `variant-overlay` | `#F8F6F466` | 1 | `apps/web/src/style.css:200` | `.variant` | style.css (1) |
| `table-foot-bg` | `#FAF7F8` | 1 | `apps/web/src/transfer-received.css:46` | `.received-table tfoot` | transfer-received.css (1) |
| `action-summary-bg` | `#FFF9EF` | 1 | `apps/web/src/transfer-actions.css:8` | `.transfer-pending > .transfer-action-summary` | transfer-actions.css (1) |
| `received-discrepant-bg` | `#FFFDF5` | 1 | `apps/web/src/transfer-received.css:47` | `.received-table .received-discrepant` | transfer-received.css (1) |
| `receipt-discrepant-bg` | `#FFFDF7` | 1 | `apps/web/src/transfer-receipt.css:98` | `.receipt-preview-table .receipt-preview-discrepant` | transfer-receipt.css (1) |
| `action-categories-bg` | `#FFFDFA` | 1 | `apps/web/src/transfer-actions.css:26` | `.transfer-action-categories li` | transfer-actions.css (1) |

### Contrast facts (measured on the tokens above)

| Pair | Ratio | Reading |
|---|---|---|
| `ink` on `surface` | 15.9:1 | body text |
| `muted` on `surface` | 5.89:1 | secondary text, passes AA |
| `muted` on `page` | 5.46:1 | quiet labels on canvas |
| `muted` on `tint` | 4.95:1 | quiet labels on selected surfaces, passes AA |
| `wine` on `surface` | 10.0:1 | primary text, active nav |
| `surface` on `wine` | 10.0:1 | primary button label |
| `approved-ink` on `approved-bg` | 6.57:1 | Aplicado tag |
| `disabled-ink` on `disabled-bg` | 6.36:1 | disabled label |
| `warning-ink` on `warning-bg` | 6.37:1 | excess/difference note |
| `received-ink` on `received-bg` | 5.21:1 | received status |
| `reject-ink` on `surface` | 8.49:1 | destructive action |
| `border` on `surface` | 1.35:1 | decorative divider only, never a control boundary |
| `disabled-border` on `disabled-bg` | 2.08:1 | disabled control outline, exempt from 1.4.11 |

## Typography

One family, declared once: `Inter, sans-serif` (`apps/web/src/style.css:4`). Inter is not downloaded, so every self-contained board falls back to the declared generic `sans-serif`. Textarea and `kbd` rules only ever say `font-family: inherit`.

Base size `14px` on `:root`. **16 numeric sizes plus `inherit`** appear:

| Size | Occurrences | Role in the product | Source example |
|---|---|---|---|
| `10px` | 9 | mobile badge, table cell label | `.bottom-nav .transfer-action-badge` (style.css:73) |
| `11px` | 89 | captions, table heads, tags, meta | `small`, `th` (style.css:28, 141) |
| `11.5px` | 1 | kind chip | `.stock-chip` (style.css:129) |
| `12px` | 154 | labels, secondary body, nav | `.side-nav a` (style.css:65) |
| `12.5px` | 1 | kind explanation line | `.stock-kind-line` (style.css:125) |
| `13px` | 81 | body, inputs, table cells | `table`, `.search-field input` (style.css:140, 99) |
| `13.5px` | 2 | supplier/kind choice title | `.stock-kind-choice strong` (style.css:117), `.stock-supplier-choice strong` (stock-entry.css:120) |
| `14px` | 18 | root size, compact headings | `:root` (style.css:7) |
| `15px` | 4 | dialog sub-headings | `.count-corrections h5` (style.css:791) |
| `16px` | 19 | panel headings, receipt values | `.variant-bottom b` (style.css:209) |
| `17px` | 4 | pending heading, price | `.transfer-pending h2`, `.pos-price` (style.css:434) |
| `18px` | 12 | brand, top bar, panel h2 | `.app-header > strong` (style.css:81) |
| `20px` | 14 | mobile h1, totals | `.stock-totals dd` (stock-entry.css:40) |
| `22px` | 17 | page h1, dialog h2 | `h1` (style.css:86) |
| `24px` | 11 | login h1, detail total | `.transfer-receipt-overview dd` (style.css:584) |
| `26px` | 2 | the figure a measuring screen leads with | `.metrics-amount`, `.cash-band-value.cash-lead` (style.css:985) |
| `inherit` | 1 | receipt cell note | `.receipt-preview-table small` (transfer-receipt.css:103) |

Weights: `400` (14), `500` (13), `600` (125), `700` (30).

Line heights: 15 values — fixed `14px`, `16px`, `18px`, `19px`, `20px`, `22px`, `24px`, `32px`, plus ratios `1`, `1.3`, `1.35`, `1.4`, `1.5`, `1.55`, `1.6`. Dense rows use the fixed 16/18 px values; prose uses 1.5–1.6.

Letter spacing: 8 values — `0`, `-.015em` (`h1`), `-.02em` (amounts, mobile h1), `-.025em` (login h1), `.03em` (table heads), `.04em` (uppercase labels), `.06em`, `.08em`.

Numerals: `font-variant-numeric: tabular-nums` on every quantity, unit total, price, date and metrics figure (`td:nth-child(n+5)`, `.stock-totals dd`, `.metrics-amount`, `.closing-*`).

## Spacing

**29 distinct positive lengths** appear in `padding`, `gap` and `margin`; 21 of them form the reusable scale below, the rest are one-off optical offsets listed after it. This is a selected scale, not every positional value in source.

| Value | Occurrences | Source example |
|---|---|---|
| `1px` | 5 | `.metrics-band { gap:1px }` — the hairline seam between joined cells (style.css:969) |
| `2px` | 38 | `.transfer-action-badge` padding `2px 6px` (style.css:66) |
| `3px` | 9 | `.stock-chip` padding `3px 10px` (style.css:128) |
| `4px` | 110 | `.side-nav` gap (style.css:64), `.sidebar .brand` padding (style.css:62) |
| `5px` | 4 | `.page-controls button` padding (style.css:154) |
| `6px` | 96 | `.page-controls` gap; `.login-intro h1` margin-bottom (style.css:152, 46) |
| `7px` | 8 | `.filter-pair select` padding (style.css:101) |
| `8px` | 207 | `button` gap and vertical padding (style.css:20) |
| `9px` | 4 | `.purchase-kind button` padding `9px 16px` (style.css:889) |
| `10px` | 104 | `.brand` gap; `.login-card input` padding `10px 14px` (style.css:32, 50) |
| `12px` | 280 | `button` horizontal padding (style.css:20), `.sidebar` padding (style.css:61), `.stock-entry-panel` gap (stock-entry.css:9) |
| `14px` | 43 | `.login-notice` padding; `.stock-kind-choice` padding `14px 16px` (style.css:56, 113) |
| `16px` | 236 | `.inventory-main` gap (style.css:83), panel padding on narrow screens (stock-entry.css:53) |
| `18px` | 13 | `.metrics-band-cell` padding `16px 18px` (style.css:972) |
| `20px` | 48 | `.pending-summary` padding (style.css:489), `.login-footer` padding `20px 32px` (style.css:58) |
| `22px` | 1 | `.transfer-action-summary` padding `20px 22px` (transfer-actions.css:5) |
| `24px` | 61 | `.inventory-heading` padding (style.css:84), `.stock-entry-panel` padding (stock-entry.css:9) |
| `28px` | 1 | `.login-submit` margin-top (style.css:57) |
| `32px` | 5 | `.login-header` padding `24px 32px` (style.css:36) |
| `40px` | 2 | `.login-card` padding; `.inventory-main` left padding (style.css:44, 83) |
| `48px` | 1 | `.login-main` padding `48px 16px` (style.css:47) |

One-off offsets that are not scale steps: `11px` (`.current-page` padding), `36px` (search icon inset), `42px` (password eye inset), `50px` (action category indent), `54px` (cart remove clearance), `80px` (main top padding under the 56px fixed bar), `112px` and `140px` (mobile bottom-nav clearance), and the negative `-1px`, `-8px`, `-16px` overlaps (`sr-only`, expanded detail row, pending origin).

Compound paddings are combinations of the scale: `5px 12px`, `7px 11px`, `8px 12px`, `10px 12px`, `10px 14px`, `12px 16px`, `14px 16px`, `16px 18px`, `20px 22px`, `20px 24px`, `24px 32px`, `16px 18px 14px`.

## Radius

| Value | Occurrences | Source example |
|---|---|---|
| `0` | 15 | `.side-nav a, .side-nav button` — navigation strips meet square (style.css:65) |
| `2px` | 1 | `.received-original > summary:focus-visible` (transfer-received.css:91) |
| `3px` | 17 | `.polarity`, `.badge`, `.tag` chips (style.css:146, 149) |
| `4px` | 81 | `button`, `input`, `.results` (style.css:20, 24, 138), `.stock-entry-panel` (stock-entry.css:9) |
| `6px` | 25 | `.stock-kind-line`, `.transfer-decision-modal`, dialog bodies (style.css:124, 622) |
| `8px` | 41 | `.login-intro .logo` (style.css:46), mobile cards and panel radius (stock-entry.css:53, 67), `.closing-balances` cells (closings.css:184) |
| `12px` | 2 | `.login-card` (style.css:44) |
| `20px` | 4 | `.pending-status` pills in the approved detail (transfer-approved.css:40) |
| `999px` | 8 | `.transfer-action-badge`, `.stock-chip` — pills (style.css:66, 128) |
| `50%` | 6 | `i` history marker, `.stock-kind-dot` (style.css:42, 120) |

## Shadows

| Value | Occurrences | Source |
|---|---|---|
| `0 1px 2px #2421240d` | 13 | `.login-card`, `.product-card`, `.stock-entry-panel`, `.catalog-panel`, `.closing-*` panels |
| `inset 0 0 0 1px var(--wine)` | 3 | pressed supplier/kind choice (style.css:116) |
| `inset 2px 0 0 var(--wine)` | 2 | `.catalog-row[aria-expanded="true"]` (catalog-prices.css:40) |
| `inset 3px 0 0 var(--wine)` | 1 | `.closing-table tr.outside td:first-child` (closings.css:102) |
| `inset 3px 0 0 #E8CF86` | 1 | `.closing-table tr.changed td:first-child` (closings.css:70) |
| `inset 0 0 0 3px white` | 1 | the white ring of a pressed kind dot (style.css:123) |
| `0 20px 50px #24212433` | 2 | `.transfer-review` (style.css:384) |
| `0 16px 48px rgb(0 0 0 / 20%)` | 2 | `.transfer-decision-modal` (style.css:622) |
| `0 -2px 10px #2421240D` | 1 | `.closing-bar` sticky action bar (closings.css:148) |
| `none` | 1 | reset on a nested cell inside an elevated surface (style.css:412) |

## Layout and breakpoints

| Constant | Value | Source |
|---|---|---|
| Sidebar width | `240px`, fixed, white | `.sidebar` (style.css:61) |
| Top bar height | `56px`, fixed, white | `.app-header` (style.css:79) |
| Main desktop padding | `80px 24px 24px 40px` | `.inventory-main` (style.css:83) |
| Content max width | `1600px` (stock and catalogue), `1400px` (transfer creation) | `.stock-entry` (stock-entry.css:3), `.catalog-prices` (catalog-prices.css:4), `.transfer-creation` (style.css:244) |
| Workspace split | `minmax(0,1fr) 380px` (POS cart, closing rail), `360px` (closing decision) | `.pos-layout` (point-of-sale.css:9), `.closing-layout` (closings.css:43, 228) |
| Panel padding | `24px` desktop, `16px` at `767px` | `.stock-entry-panel` (stock-entry.css:9, 53) |
| Control target | `44px` minimum on interactive controls | `button` (style.css:20), `.stock-add` (stock-entry.css:28), `.closing-bar-action button` (closings.css:155) |
| Dense row height | `40px` head, `44px` body | `th`, `td` (style.css:141–143) |
| Mobile shell | `390px` max width, bottom nav `64px`, `112px` / `140px` clearance | `.warehouse`, `.bottom-nav` (style.css:161, 217), third mobile destination (stock-entry.css:59–61) |
| Breakpoints | `1279`, `1150`, `1100`, `1050`, `820`, `767`, `600`, `min-width:601` | media queries across the 16 files; `767px` is the desktop→mobile shell switch |
| Motion query | one `prefers-reduced-motion: no-preference` guard | transfer-received.css:67 |

## Component rules

- **Shell.** Fixed 240px white sidebar with the wine brand, 12px nav gap steps of 4px, the active destination as `tint` background with a 2px wine left marker, and an identity block on `page` at the bottom. 56px top bar with the screen name at 18px and the assigned location at 12px, `muted` label with `ink` value. Source: `.sidebar`, `.side-nav`, `.identity`, `.app-header` (style.css:61–82).
- **Page heading.** Uppercase `muted` 11px breadcrumb with `.04em`, `h1` 22px/600/`-.015em`, one 13px `muted` sentence under it. Source: `.stock-entry-heading` (stock-entry.css:4–7), `h1` (style.css:86).
- **Panel.** White, 1px `border`, 4px radius, `0 1px 2px #2421240d`, 24px padding, 16px gap; heading 18px/600 with a 12px `muted` line and a quiet `tag` on the right. Source: `.stock-entry-panel`, `.stock-panel-head` (stock-entry.css:9–12).
- **Primary action.** Wine fill, white 600 label, wine border, 4px radius; hover to `--hover`; the only filled control on a screen. Source: `.primary` (style.css:26–28).
- **Secondary action.** White fill, 1px boundary, ink label; hover to `tint`. Source: `button` (style.css:20–22).
- **Disabled action.** Source keeps `opacity:.72` on `.primary:disabled` and `muted` text on `button:disabled`; the count-corrections screen additionally defines a full disabled set (`disabled-bg #EFEDEF`, `disabled-ink #595459`, `disabled-border #AAA5AA`, style.css:803). Boards use that full set plus an adjacent reason line, because a disabled control cannot be focused to explain itself.
- **Focus.** `outline: 2px solid var(--wine); outline-offset: 3px` on every focusable element; on wine-filled controls the outline flips to white and sits inside the edge. Source: style.css:23, 358.
- **Field.** White, 1px boundary, 4px radius, 8px 12px padding; 44px minimum in operational forms; uppercase 11px/`.04em` label above. Source: `input` (style.css:24), `.stock-search` (stock-entry.css:18–19).
- **Tag vs chip.** `tag` = 4px 8px, 3px radius, `page` fill, 1px `border`, `muted` 11px, for neutral state (`Sin elegir`, `33 productos`, `1 ingreso`). `chip` = 3px 10px, 999px radius, `tint` fill, `wine` 11.5px/600, for the document's own context (supplier, kind). Source: `.stock-tag` (stock-entry.css:14), `.stock-chip` (style.css:128).
- **Table.** Full width, `13px`, collapsed borders; 40px uppercase `muted` 11px head on `page`; 44px rows; 1px `border` bottom; numeric columns right-aligned with tabular numerals. Source: `table`, `th`, `td` (style.css:140–145), `.stock-table` (stock-entry.css:21–25).
- **Polarity mark.** 3px 7px, `page` fill, 1px `border`, 3px radius, 11px — a badge, not a control. Source: `.polarity` (style.css:146).
- **Pressed choice.** `aria-pressed="true"` keeps the white surface, adds a wine border and `inset 0 0 0 1px var(--wine)`, and colours the title wine; the kind dot fills wine with a 3px white inner ring. Source: `.stock-kind-choice[aria-pressed="true"]` (style.css:116, 122).
- **Totals.** A `dl` with uppercase 11px labels and 20px tabular values; the leading figure may reach 26px/700/`-.02em` (`metrics-amount`). Boards use 24px for the unit total. Source: `.stock-totals` (stock-entry.css:35–36), `.metrics-amount` (style.css:985).
- **Pager.** `page` strip with 11px `muted` range text, 12px controls and a wine current page. Source: `.pager`, `.current-page` (style.css:151, 156).
- **Sticky rails.** The right rail sticks under the bar (`top:72px`) or at `top:16px`; the action bar sticks to the bottom with `0 -2px 10px #2421240D`. Source: `.closing-rail` (closings.css:110), `.pos-cart` (point-of-sale.css:44), `.closing-bar` (closings.css:146–148).
- **Dialog.** Centered white panel, 6px radius, `0 16px 48px rgb(0 0 0 / 20%)`, 24px header/body padding, 20px 24px footer; backdrop `rgb(36 33 36 / 45%)`. Source: `.transfer-decision-modal`, `.transfer-decision-backdrop` (style.css:621–630).
- **Keyboard legend.** `kbd` = 11px, `2px 6px`, 3px radius, white fill, `border` edge with a `2px` bottom border, `muted` label. Source: `kbd` (closings.css:54–55).
- **Notices.** One quiet tint line (`.stock-kind-line`, 12.5px wine on tint, 6px radius) or the warm action summary (`#FFF9EF` fill, `#E7D6B7` edge, `#91621E` icon) — never a second full-width banner competing with the work. Source: style.css:124, transfer-actions.css:5–8.
- **Mobile shell.** At `767px` the sidebar and top bar disappear for a `390px` warehouse column with a sticky 12px 16px mobile header and a bottom nav; `Ingresos` becomes the third destination and the bar grows to `min-height:64px`. Source: style.css:161–220, stock-entry.css:59–61.
- **Table on narrow screens.** At `600px` the head is clipped to a screen-reader-only element and each row becomes an 8px-radius card with `data-label` cells. Source: stock-entry.css:63–71, catalog-prices.css:103–110.

## Artboard self-check

Run on the three directions in `design/ingresos-proveedor/` after they were written, by extracting every `#hex`, every `font-family`, every `font-size`, every `border-radius` and every `box-shadow` from the three files and comparing them with the tables above. Results, as measured:

- **Colors**: exactly **14 aliases**, none outside the system, and identical in all three boards: `wine`, `hover`, `tint`, `page`, `border`, `muted`, `ink`, `surface`, `soft-shadow`, `disabled-bg`, `disabled-ink`, `disabled-border`, `approved-bg`, `approved-ink`. Two non-hex color syntaxes also appear and both are system values: the `transparent` keyword as a border color (recorded above as `transparent`), and `currentColor` on the decorative SVG icons, which inherits `ink` or `muted` from the text. No `white` keyword is used as a color; `#FFFFFF` is written as `surface`.
- **Font family**: one stack, `Inter, sans-serif`, declared once on `body` via the `font:` shorthand; `font-family: inherit` on `kbd` only, the same rule the source uses. No downloaded font.
- **Type sizes**: `11`, `11.5`, `12`, `13`, `13.5`, `14`, `16`, `18`, `20`, `22`, `24` px and `26` px in `03` only. All in the 16-size scale above.
- **Radii**: `3`, `4`, `8`, `999` px, plus the deliberate `0` on the state frames in `01` (the same square-edge choice the system records). All in the 10-value set.
- **Shadows**: `0 1px 2px #2421240D` in all three, `inset 0 0 0 1px var(--wine)` in `01` (pressed supplier/kind choice) and `inset 2px 0 0 var(--wine)` in `03` (the active search row). All three are source shadows.
- **Deviations found and fixed before reporting** (each one observed in a rendered screenshot, not assumed): `01` state E had a fixed 780 px height that cut off the confirm bar and the mobile nav — now auto height. `01` printed `Sin aplicar` twice (context strip and document chip) — the strip copy was dropped. `01` state B carried an invented detail line for the other product — replaced by its single real action. `02`'s remito header duplicated the document status field — removed, the panel chip states it once. `02`'s narrow state put the remito below the catalogue — reordered so the document context precedes the search, and the caption was corrected. Sidebar and bottom-nav destinations were anchors to fragments that do not exist — converted to buttons, and the mobile active marker moved from the top edge to `border-bottom` as `style.css:496` does. `03` clipped about 10 px of its history at 1440×1000 — the search panel lead and row padding were tightened until the whole screen fitted.
- **Colors, sizes, radii, shadows**: the two accessibility treatments this file records (`--muted` as the boundary of interactive controls, the full disabled token set) were in the boards from the first draft; no value outside the tables above was found in the final files.
