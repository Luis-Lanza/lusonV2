-- Completeness of a stock adjustment document, added after 022 was already
-- applied: migrations are immutable once a database tracked them, so this guard
-- is its own version instead of an edit of 022.
--
-- Why it is needed: a document with no lines restores nothing, and as a
-- counter-entry it would take the single-reversal slot while leaving the original
-- marked reversed with its balance uncorrected. The per-line guards of 022 cannot
-- catch that, so completeness is a deferred header invariant: it is judged at
-- commit, after every line of the document was inserted or not.
CREATE FUNCTION require_stock_adjustment_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    line_count integer;
BEGIN
    SELECT count(*) INTO line_count FROM stock_adjustment_lines WHERE adjustment_id=NEW.id;
    IF line_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='LS008', MESSAGE='Stock adjustment requires at least one counted line';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_stock_adjustment_lines AFTER INSERT ON stock_adjustments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_stock_adjustment_lines();
