# Luson visual system

Synced from `apps/web/src/style.css` (entire file). Not a proposed starter. Names below for literal colors are documentation aliases, not additional CSS custom properties. Existing access-management boards are unchanged.

## Colors (36 normalized source representations)
Every entry comes from `apps/web/src/style.css`; selectors identify the source and usage. Hex casing and white are normalized without changing values.

| Token / alias | Value | Source selector / usage |
|---|---|---|
| wine | #7A1F3D | :root; primary, focus, navigation |
| hover | #5B162D | :root; primary hover |
| tint | #F5E8ED | :root; contextual backgrounds |
| page | #F8F6F4 | :root; canvas |
| border | #DED7DA | :root; decorative dividers |
| muted | #6B6267 | :root; secondary text |
| ink | #242124 | :root; body text |
| surface | #FFFFFF | button, .sidebar; panels |
| action-alert | #BA1A1A | .transfer-action-badge, .receipt-discrepancy.shortage |
| received-bg | #ECFDF5 | .pending-list .pending-status.status-received |
| received-ink | #047857 | .pending-list .pending-status.status-received |
| received-border | #A7F3D0 | .pending-list .pending-status.status-received |
| approved-bg | #EDF7F0 | .pending-status.status-approved |
| approved-ink | #22633B | .pending-status.status-approved |
| shortage-bg | #FFF0F0 | .receipt-discrepancy.shortage |
| shortage-border | #FFDAD6 | .receipt-discrepancy.shortage |
| warning-bg | #FFFBEF | .receipt-discrepancy.excess, .transfer-impact |
| warning-border | #E8CF86 | .receipt-discrepancy.excess, .transfer-impact |
| warning-ink | #805400 | .receipt-discrepancy.excess |
| approved-border | #D9B3C1 | .transfer-outcome-metrics.approved dl:last-child |
| history-positive | #23815A | .transfer-history li::before |
| reject-ink | #991515 | .transfer-decision .transfer-reject |
| reject-border | #CCAAAA | .transfer-decision .transfer-reject |
| restitution-border | #A7D9C3 | .restitution-closed |
| restitution-ink | #065F46 | .restitution-closed |
| disabled-ink | #595459 | .count-corrections button:disabled |
| disabled-border | #AAA5AA | .count-corrections button:disabled |
| disabled-bg | #EFEDEF | .count-corrections button:disabled |
| notice-overlay | #F5E8ED99 | .login-notice |
| variant-overlay | #F8F6F466 | .variant |
| soft-shadow | #2421240D | .login-card |
| modal-shadow | #24212433 | .transfer-review |
| creation-backdrop | #24212466 | .creation-dialog-backdrop |

Source also spells the review backdrop as #24212473 and rgb(36 33 36 / 45%); these are approximately, not exactly, equivalent alpha representations. For completeness these are **2 additional source values**, and rgb(0 0 0 / 20%) is **1 additional source value** in decision/count modal shadows. Total: **36 distinct normalized source color representations**, including white; 33 tabulated plus these 3. Transparency is not a semantic status color.

## Typography (12 sizes, 1 declared family stack)
Source: `apps/web/src/style.css` :root declares `Inter, sans-serif`, 14px. Self-contained design boards use only the declared generic system fallback `sans-serif`; Inter is not downloaded.

Sizes present: 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24px (navigation badges through detail metrics). Weights: 400 (normal), 500, 600, 700. Source examples: .brand, h1, .transfer-creation h2/h3, .transfer-pending h2, .transfer-decision-recovery h3, .transfer-receipt-overview dd, .count-corrections h5.

## Spacing (14 core padding/gap values)
Source: `apps/web/src/style.css`: 2 (.transfer-action-badge), 4 (.brand), 6 (.location-tabs button), 8 (button), 10 (.login-card input), 12 (.sidebar), 14 (.login-notice), 16 (.inventory-main), 20 (.pending-summary), 24 (.inventory-heading), 28 (.login-submit margin-top), 32 (.login-header), 40 (.login-card), 48 (.login-main) px. 14 actual spacing values. This is a selected reusable scale, not every positional offset in source.

## Radius (6 values)
Source: `apps/web/src/style.css`: 3px (.badge), 4px (button), 6px (.transfer-detail-items), 8px (.product-card), 12px (.login-card), 999px (.transfer-action-badge). 50% is also used for circular history markers, not a panel radius.

## Shadows (3)
Source: `apps/web/src/style.css`:
- `0 1px 2px #2421240d` — .login-card, .product-card.
- `0 20px 50px #24212433` — .transfer-review.
- `0 16px 48px rgb(0 0 0 / 20%)` — .transfer-decision-modal, .count-modal.

## Component rules
- White 240px sidebar; 56px white app header; wine active navigation with tint background and 2px marker. Source: .sidebar, .app-header, .side-nav.
- Main desktop padding 80px 24px 24px 40px with fixed header; responsive breakpoint 767px. Source: .inventory-main and media rules.
- Panels white, decorative border, 4/6/8px radius depending on context. Small uppercase muted table headings, tabular quantities. Source: .results, th, .transfer-detail-items.
- Wine primary action, hover token, visible 2px wine focus with 3px offset. Source: button, .primary, :focus-visible.
- Touch controls 44px minimum and wrapping labels in participant surfaces. Source: F6a participant controls block.
- New mockups use the existing muted color for field/control boundaries to provide contrast; source fields use border. This is a design accessibility treatment, not a claimed production token change.
- Received status and reconciliation status must remain separate. Immutable evidence, effective quantities and stock balances are distinct in TransferDetail.tsx. New reconciliation flow is a proposal, not existing runtime behavior.

## Artboard self-check
New transfer boards use only wine, hover, tint, page, border, muted, ink, surface plus received-bg/ink/border and warning-bg/ink/border. Font: sans-serif only. No external resources or new color values. System gallery additionally renders all source color representations and source shadows.
