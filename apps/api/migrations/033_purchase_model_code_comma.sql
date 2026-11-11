-- The catalogue itself serves model codes with a comma: 12N6,5_3B and YB6,5_BS.
-- The frozen pattern of 032 refused that comma, so GET /api/purchases/models offered
-- a code that POST /api/purchases refused with 400 invalid_request.
--
-- 032 is applied and checksummed, so it is never edited; this migration widens the
-- same bound forward-only. A code is still trimmed and upper-cased, still begins with
-- a letter or digit and is still at most forty characters; the comma is the only
-- admitted character that was missing. No line changes and no data moves: the
-- constraint PostgreSQL named in 032 is dropped and recreated with the wider pattern.
ALTER TABLE purchase_used_lines
    DROP CONSTRAINT purchase_used_lines_model_check,
    ADD CONSTRAINT purchase_used_lines_model_check
        CHECK (model ~ '^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$');
