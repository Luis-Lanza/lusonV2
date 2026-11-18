-- A sold piece and its serial are a battery's story. A product is counted, not
-- identified: the counter sells three bottles of water, not three serial numbers, and
-- the seller cannot type a serial that does not exist. So the unit rules become rules
-- of the catalogue kind of the line, without touching a single column: a battery line
-- still carries exactly one unit per sold piece, and a product line carries none.
--
-- Both triggers are restated here because the rule is one rule and a half-applied
-- version of it would admit a product unit or refuse a battery one. Nothing else of
-- the sale changes: the header, the prices, the stock deduction and the immutability
-- of a sold document stay exactly as they are.

-- A unit never belongs to a product line. The check rides on the existing admission of
-- the unit, which already locks and reads the line it belongs to.
CREATE OR REPLACE FUNCTION admit_sale_unit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    line sale_lines%ROWTYPE;
    parent_kind text;
BEGIN
    SELECT * INTO line FROM sale_lines
    WHERE sale_id=NEW.sale_id AND variant_id=NEW.variant_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LV010', MESSAGE='Sale unit requires a persisted sale line';
    END IF;
    SELECT entry.kind INTO parent_kind
    FROM catalog_variants variant
    JOIN catalog_entries entry ON entry.id=variant.catalog_entry_id
    WHERE variant.id=NEW.variant_id;
    IF parent_kind = 'other' THEN
        RAISE EXCEPTION USING ERRCODE='LV014',
            MESSAGE='A product line carries no sold units',
            DETAIL=NEW.serial_number;
    END IF;
    IF NEW.unit_ordinal > line.quantity THEN
        RAISE EXCEPTION USING ERRCODE='LV011', MESSAGE='Sale unit ordinal exceeds the quantity of its line';
    END IF;
    -- The duplicate check must not be a bare read: two sellers charging the same
    -- battery would both pass it and then collide on the unique index below, whose
    -- 23505 is not this domain's refusal. The serial's own lock serializes them, so
    -- the second writer waits here, its next statement sees the committed row, and it
    -- is refused with LV009 as documented. Relying on an unrelated lock to serialize
    -- this would be an accident, not a rule. The unique index stays the last authority.
    PERFORM pg_advisory_xact_lock(hashtext('sale_units:' || upper(btrim(NEW.serial_number))));
    IF EXISTS (
        SELECT 1 FROM sale_units
        WHERE upper(btrim(serial_number))=upper(btrim(NEW.serial_number))
    ) THEN
        RAISE EXCEPTION USING ERRCODE='LV009', MESSAGE='Serial number was already sold',
            DETAIL=NEW.serial_number;
    END IF;
    RETURN NEW;
END;
$$;

-- The document is judged at commit, on the header, exactly like require_sale_total:
-- a battery line carries exactly one unit per sold piece, so a line of three can never
-- be stored with two serials, and a product line carries none, so a bottle never needs
-- a serial. The check hangs on the sale, not on the unit, because a deferred trigger on
-- sale_units would never run for a sale that inserted no unit at all. A sale is
-- all-or-nothing, and the total number of units stays reachable by the documented body
-- limit.
CREATE OR REPLACE FUNCTION require_sale_units() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    mismatched integer;
    with_units integer;
    units_total bigint;
BEGIN
    SELECT count(*) INTO mismatched
    FROM sale_lines line
    JOIN catalog_variants variant ON variant.id=line.variant_id
    JOIN catalog_entries entry ON entry.id=variant.catalog_entry_id
    WHERE line.sale_id=NEW.id
      AND entry.kind = 'battery'
      AND line.quantity <> (
          SELECT count(*) FROM sale_units unit
          WHERE unit.sale_id=line.sale_id AND unit.variant_id=line.variant_id
      );
    IF mismatched > 0 THEN
        RAISE EXCEPTION USING ERRCODE='LV012', MESSAGE='Every battery line requires one unit per sold piece';
    END IF;
    SELECT count(*) INTO with_units
    FROM sale_lines line
    JOIN catalog_variants variant ON variant.id=line.variant_id
    JOIN catalog_entries entry ON entry.id=variant.catalog_entry_id
    WHERE line.sale_id=NEW.id
      AND entry.kind = 'other'
      AND EXISTS (
          SELECT 1 FROM sale_units unit
          WHERE unit.sale_id=line.sale_id AND unit.variant_id=line.variant_id
      );
    IF with_units > 0 THEN
        RAISE EXCEPTION USING ERRCODE='LV014', MESSAGE='A product line carries no sold units';
    END IF;
    SELECT coalesce(sum(quantity),0) INTO units_total
    FROM sale_lines WHERE sale_id=NEW.id;
    IF units_total > 1000 THEN
        RAISE EXCEPTION USING ERRCODE='LV013', MESSAGE='Sale exceeds one thousand units';
    END IF;
    RETURN NULL;
END;
$$;
