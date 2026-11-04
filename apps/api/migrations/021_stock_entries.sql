-- Warehouse stock ingress: immutable documents applied atomically to
-- inventory_balances. Only the warehouse (location 1) registers ingress, and a
-- confirmed document is corrected only by a counter-entry (reversal).
--
-- No new realtime code is required here: migration 004 already installs
-- invalidate_balance_change on inventory_balances, so every line applied by
-- these triggers invalidates the 'inventory' scope inside the same transaction.
CREATE TABLE stock_entries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    location_id smallint NOT NULL REFERENCES locations(id),
    note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
    reverses_entry_id bigint REFERENCES stock_entries(id),
    reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
    created_by_account_id integer NOT NULL REFERENCES auth_accounts(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- A document never reverses itself and a reversal always states why.
    CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id),
    CHECK ((reverses_entry_id IS NULL AND reason = '')
        OR (reverses_entry_id IS NOT NULL AND btrim(reason) <> ''))
);

-- At most one counter-entry per original document: both stay visible forever.
CREATE UNIQUE INDEX stock_entries_single_reversal ON stock_entries(reverses_entry_id)
WHERE reverses_entry_id IS NOT NULL;

CREATE TABLE stock_entry_lines (
    entry_id bigint NOT NULL REFERENCES stock_entries(id),
    variant_id integer NOT NULL REFERENCES catalog_variants(id),
    quantity bigint NOT NULL CHECK (quantity <> 0),
    PRIMARY KEY (entry_id, variant_id)
);

-- Location and reversal target are database authority, not a caller promise.
CREATE FUNCTION admit_stock_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target stock_entries%ROWTYPE;
BEGIN
    IF NEW.location_id <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='LS005', MESSAGE='Stock ingress is registered only by the warehouse';
    END IF;
    IF NEW.reverses_entry_id IS NOT NULL THEN
        SELECT * INTO target FROM stock_entries WHERE id=NEW.reverses_entry_id;
        IF NOT FOUND OR target.location_id IS DISTINCT FROM NEW.location_id
           OR target.reverses_entry_id IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='LS006', MESSAGE='Reversal target must be an original entry of the same location';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_stock_entry_header BEFORE INSERT ON stock_entries
FOR EACH ROW EXECUTE FUNCTION admit_stock_entry();

-- Each line is applied immediately, in the caller's ascending variant order, so
-- rows are locked (location_id, variant_id) ascending. Sign, reversal mirror,
-- overflow and covered-existing invariants are all enforced here; reserved is
-- never modified by ingress.
CREATE FUNCTION apply_stock_entry_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header stock_entries%ROWTYPE;
    original bigint;
    balance inventory_balances%ROWTYPE;
    total numeric;
BEGIN
    SELECT * INTO header FROM stock_entries WHERE id=NEW.entry_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LS004', MESSAGE='Stock entry line requires a persisted document';
    END IF;
    IF header.reverses_entry_id IS NULL THEN
        IF NEW.quantity < 1 THEN
            RAISE EXCEPTION USING ERRCODE='LS002', MESSAGE='Ingress lines must be positive';
        END IF;
    ELSE
        IF NEW.quantity > -1 THEN
            RAISE EXCEPTION USING ERRCODE='LS002', MESSAGE='Reversal lines must be negative';
        END IF;
        SELECT quantity INTO original FROM stock_entry_lines
        WHERE entry_id=header.reverses_entry_id AND variant_id=NEW.variant_id;
        IF NOT FOUND OR original IS DISTINCT FROM -NEW.quantity THEN
            RAISE EXCEPTION USING ERRCODE='LS002', MESSAGE='Reversal lines must mirror an original line';
        END IF;
    END IF;
    SELECT * INTO balance FROM inventory_balances
    WHERE location_id=header.location_id AND variant_id=NEW.variant_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LS004', MESSAGE='Stock ingress requires an existing balance row';
    END IF;
    -- numeric arithmetic keeps the bound check exact before any bigint cast.
    total:=balance.existing::numeric+NEW.quantity;
    IF total>9223372036854775807 THEN
        RAISE EXCEPTION USING ERRCODE='LS007', MESSAGE='Stock ingress exceeds bigint inventory';
    END IF;
    IF total<balance.reserved THEN
        RAISE EXCEPTION USING ERRCODE='LS001', MESSAGE='Stock ingress requires covered existing stock';
    END IF;
    UPDATE inventory_balances SET existing=total::bigint
    WHERE location_id=header.location_id AND variant_id=NEW.variant_id;
    RETURN NEW;
END;
$$;
CREATE TRIGGER apply_stock_entry_line BEFORE INSERT ON stock_entry_lines
FOR EACH ROW EXECUTE FUNCTION apply_stock_entry_line();

-- A reversal is all-or-nothing: at commit every original line must be mirrored
-- exactly. A partial counter-entry never reaches the ledger.
CREATE FUNCTION validate_stock_entry_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target bigint;
BEGIN
    SELECT reverses_entry_id INTO target FROM stock_entries WHERE id=NEW.entry_id;
    IF target IS NULL THEN
        RETURN NULL;
    END IF;
    IF EXISTS (
        SELECT 1 FROM stock_entry_lines original
        WHERE original.entry_id=target
        AND NOT EXISTS (
            SELECT 1 FROM stock_entry_lines reversal
            WHERE reversal.entry_id=NEW.entry_id
            AND reversal.variant_id=original.variant_id
            AND reversal.quantity=-original.quantity
        )
    ) THEN
        RAISE EXCEPTION USING ERRCODE='LS003', MESSAGE='A reversal must mirror every original line';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER validate_stock_entry_reversal AFTER INSERT ON stock_entry_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_stock_entry_reversal();

-- Append-only documents: reuse the existing immutability guard, including TRUNCATE.
CREATE TRIGGER protect_stock_entries BEFORE UPDATE OR DELETE ON stock_entries
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_stock_entries_truncate BEFORE TRUNCATE ON stock_entries
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_stock_entry_lines BEFORE UPDATE OR DELETE ON stock_entry_lines
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_stock_entry_lines_truncate BEFORE TRUNCATE ON stock_entry_lines
EXECUTE FUNCTION protect_pending_request();
