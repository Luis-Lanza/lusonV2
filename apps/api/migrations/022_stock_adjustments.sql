-- Warehouse stock adjustment by physical count: immutable documents that record
-- what was counted, keep the expected snapshot the database had at apply time,
-- and apply the difference atomically. Only the warehouse (location 1) adjusts,
-- and a confirmed document is corrected only by a counter-entry.
--
-- No new realtime code is required here: migration 004 already installs
-- invalidate_balance_change on inventory_balances, so every difference applied by
-- these triggers invalidates the 'inventory' scope inside the same transaction.
CREATE TABLE stock_adjustments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    location_id smallint NOT NULL REFERENCES locations(id),
    -- The motive is mandatory for every document: an adjustment states why it was
    -- counted, and the counter-entry that corrects one states why it was reversed.
    reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
    detail text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 500),
    reverses_adjustment_id bigint REFERENCES stock_adjustments(id),
    created_by_account_id integer NOT NULL REFERENCES auth_accounts(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- A document never reverses itself.
    CHECK (reverses_adjustment_id IS NULL OR reverses_adjustment_id <> id)
);

-- At most one counter-entry per original document: both stay visible forever.
CREATE UNIQUE INDEX stock_adjustments_single_reversal ON stock_adjustments(reverses_adjustment_id)
WHERE reverses_adjustment_id IS NOT NULL;

-- expected_quantity is written by this migration's trigger from the database's own
-- balance, never by the caller: the blind-count contract is enforced here, not in
-- the client. difference is derived on read, so it can never disagree with the
-- two persisted facts it comes from.
CREATE TABLE stock_adjustment_lines (
    adjustment_id bigint NOT NULL REFERENCES stock_adjustments(id),
    variant_id integer NOT NULL REFERENCES catalog_variants(id),
    expected_quantity bigint NOT NULL CHECK (expected_quantity >= 0),
    counted_quantity bigint NOT NULL CHECK (counted_quantity >= 0 AND counted_quantity <= 1000000),
    PRIMARY KEY (adjustment_id, variant_id)
);

-- Location and reversal target are database authority, not a caller promise.
CREATE FUNCTION admit_stock_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target stock_adjustments%ROWTYPE;
BEGIN
    IF NEW.location_id <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='LS005', MESSAGE='Stock adjustment is registered only by the warehouse';
    END IF;
    IF NEW.reverses_adjustment_id IS NOT NULL THEN
        SELECT * INTO target FROM stock_adjustments WHERE id=NEW.reverses_adjustment_id;
        IF NOT FOUND OR target.location_id IS DISTINCT FROM NEW.location_id
           OR target.reverses_adjustment_id IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='LS006', MESSAGE='Reversal target must be an original adjustment of the same location';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_stock_adjustment_header BEFORE INSERT ON stock_adjustments
FOR EACH ROW EXECUTE FUNCTION admit_stock_adjustment();

-- Each line is applied immediately, in the caller's ascending variant order, so
-- rows are locked (location_id, variant_id) ascending. The expected snapshot is
-- taken here, under the row lock, and a counter-entry swaps counted and expected
-- so its difference is the exact negation of the original line. The covered
-- existing invariant is enforced on the exact numeric total before any bigint
-- cast; reserved is never modified by an adjustment.
CREATE FUNCTION apply_stock_adjustment_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header stock_adjustments%ROWTYPE;
    original stock_adjustment_lines%ROWTYPE;
    balance inventory_balances%ROWTYPE;
    delta numeric;
    total numeric;
BEGIN
    SELECT * INTO header FROM stock_adjustments WHERE id=NEW.adjustment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LS004', MESSAGE='Stock adjustment line requires a persisted document';
    END IF;
    SELECT * INTO balance FROM inventory_balances
    WHERE location_id=header.location_id AND variant_id=NEW.variant_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LS004', MESSAGE='Stock adjustment requires an existing balance row';
    END IF;
    IF header.reverses_adjustment_id IS NULL THEN
        IF NEW.counted_quantity < 0 OR NEW.counted_quantity > 1000000 THEN
            RAISE EXCEPTION USING ERRCODE='LS002', MESSAGE='Counted quantity is out of bounds';
        END IF;
        -- A caller-supplied expected is overwritten by the database's own value.
        NEW.expected_quantity := balance.existing;
    ELSE
        SELECT * INTO original FROM stock_adjustment_lines
        WHERE adjustment_id=header.reverses_adjustment_id AND variant_id=NEW.variant_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LS002', MESSAGE='A counter-entry only mirrors counted variants';
        END IF;
        NEW.expected_quantity := original.counted_quantity;
        NEW.counted_quantity := original.expected_quantity;
    END IF;
    delta := NEW.counted_quantity::numeric - NEW.expected_quantity::numeric;
    total := balance.existing::numeric + delta;
    IF total > 9223372036854775807 OR total < -9223372036854775808 THEN
        RAISE EXCEPTION USING ERRCODE='LS007', MESSAGE='Stock adjustment exceeds bigint inventory';
    END IF;
    IF total < balance.reserved THEN
        RAISE EXCEPTION USING ERRCODE='LS001', MESSAGE='Stock adjustment requires covered existing stock';
    END IF;
    UPDATE inventory_balances SET existing=total::bigint
    WHERE location_id=header.location_id AND variant_id=NEW.variant_id;
    RETURN NEW;
END;
$$;
CREATE TRIGGER apply_stock_adjustment_line BEFORE INSERT ON stock_adjustment_lines
FOR EACH ROW EXECUTE FUNCTION apply_stock_adjustment_line();

-- A counter-entry is all-or-nothing: at commit every counted line of the original
-- must be mirrored with counted and expected swapped. A partial counter-entry
-- never reaches the ledger.
CREATE FUNCTION validate_stock_adjustment_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target bigint;
BEGIN
    SELECT reverses_adjustment_id INTO target FROM stock_adjustments WHERE id=NEW.adjustment_id;
    IF target IS NULL THEN
        RETURN NULL;
    END IF;
    IF EXISTS (
        SELECT 1 FROM stock_adjustment_lines original
        WHERE original.adjustment_id=target
        AND NOT EXISTS (
            SELECT 1 FROM stock_adjustment_lines counter
            WHERE counter.adjustment_id=NEW.adjustment_id
            AND counter.variant_id=original.variant_id
            AND counter.expected_quantity=original.counted_quantity
            AND counter.counted_quantity=original.expected_quantity
        )
    ) THEN
        RAISE EXCEPTION USING ERRCODE='LS003', MESSAGE='A counter-entry must mirror every counted line';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER validate_stock_adjustment_reversal AFTER INSERT ON stock_adjustment_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_stock_adjustment_reversal();

-- Append-only documents: reuse the existing immutability guard, including TRUNCATE.
CREATE TRIGGER protect_stock_adjustments BEFORE UPDATE OR DELETE ON stock_adjustments
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_stock_adjustments_truncate BEFORE TRUNCATE ON stock_adjustments
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_stock_adjustment_lines BEFORE UPDATE OR DELETE ON stock_adjustment_lines
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_stock_adjustment_lines_truncate BEFORE TRUNCATE ON stock_adjustment_lines
EXECUTE FUNCTION protect_pending_request();
