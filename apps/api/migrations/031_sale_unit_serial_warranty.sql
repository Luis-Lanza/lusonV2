-- Point of sale, second slice: the sold unit becomes a document of its own.
--
-- 025 kept one row per variant (PRIMARY KEY (sale_id, variant_id)) and a mandatory
-- warranty term per line, so a line of three batteries carried three units and a
-- single term. That is not what the counter registers: the seller reads the serial
-- number of each physical battery and states a term for it, and a multiple sale can
-- give each one a different term or none at all.
--
-- So the line stays the commercial line (variant, quantity, price, subtotal) and a
-- new sale_units table holds one row per physical battery. The term moves with the
-- unit, where it is optional: NULL means the client took that battery without
-- warranty, which is sold data and never an absent value. There is no zero months.
--
-- The serial number is written down, never looked up: it identifies the battery the
-- client left with, it is not a stock identity and it has no counterpart in
-- inventory_balances. It is unique in the whole installation after trimming and
-- case folding, because one physical battery cannot be sold twice and a typo is
-- cheaper to catch at the counter than a year later.
--
-- No new realtime code is required: 025 already invalidates the branch stock through
-- apply_sale_line, and these units never touch a balance.

-- The client's address or neighbourhood, free text exactly like the phone and the
-- document beside it: optional and bounded, never structured into parts.
ALTER TABLE sales ADD COLUMN customer_address text NOT NULL DEFAULT ''
    CHECK (char_length(customer_address) <= 200);

-- One row per physical battery sold. The term belongs here now, so it leaves the
-- line: two authorities for one promise is how the two drift apart.
CREATE TABLE sale_units (
    sale_id bigint NOT NULL,
    variant_id integer NOT NULL,
    -- 1..n inside its own line, so three batteries of one variant are rows 1, 2, 3.
    unit_ordinal integer NOT NULL CHECK (unit_ordinal BETWEEN 1 AND 1000000),
    serial_number text NOT NULL
        CHECK (char_length(btrim(serial_number)) BETWEEN 1 AND 64),
    -- NULL is a decision that was recorded, not missing data: no warranty.
    warranty_months smallint CHECK (warranty_months BETWEEN 1 AND 120),
    PRIMARY KEY (sale_id, variant_id, unit_ordinal),
    -- A unit always belongs to a persisted line of the same sale and variant.
    FOREIGN KEY (sale_id, variant_id) REFERENCES sale_lines(sale_id, variant_id)
);

-- One physical battery, one sale. Case folding and trimming are the comparison the
-- counter actually makes: "abc123 " and "ABC123" are the same battery.
CREATE UNIQUE INDEX sale_units_serial_number ON sale_units (upper(btrim(serial_number)));

ALTER TABLE sale_lines DROP COLUMN warranty_months;

-- The ordinal is bounded by the line it belongs to, and the line must exist: a unit
-- is never an orphan claim about stock that was not sold.
CREATE FUNCTION admit_sale_unit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    line sale_lines%ROWTYPE;
BEGIN
    SELECT * INTO line FROM sale_lines
    WHERE sale_id=NEW.sale_id AND variant_id=NEW.variant_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LV010', MESSAGE='Sale unit requires a persisted sale line';
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
CREATE TRIGGER admit_sale_unit BEFORE INSERT ON sale_units
FOR EACH ROW EXECUTE FUNCTION admit_sale_unit();

-- The document is judged at commit, on the header, exactly like require_sale_total:
-- every line carries exactly one unit per sold piece, so a line of three can never
-- be stored with two serials and a sale can never be stored with none. The check
-- hangs on the sale, not on the unit, because a deferred trigger on sale_units would
-- never run for a sale that inserted no unit at all. A sale is all-or-nothing, and
-- the total number of units stays reachable by the documented body limit.
CREATE FUNCTION require_sale_units() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    mismatched integer;
    units_total bigint;
BEGIN
    SELECT count(*) INTO mismatched
    FROM sale_lines line
    WHERE line.sale_id=NEW.id
      AND line.quantity <> (
          SELECT count(*) FROM sale_units unit
          WHERE unit.sale_id=line.sale_id AND unit.variant_id=line.variant_id
      );
    IF mismatched > 0 THEN
        RAISE EXCEPTION USING ERRCODE='LV012', MESSAGE='Every sale line requires one unit per sold piece';
    END IF;
    SELECT coalesce(sum(quantity),0) INTO units_total
    FROM sale_lines WHERE sale_id=NEW.id;
    IF units_total > 1000 THEN
        RAISE EXCEPTION USING ERRCODE='LV013', MESSAGE='Sale exceeds one thousand units';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_sale_units AFTER INSERT ON sales
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_sale_units();

-- Sold units are immutable like the rest of the document, including TRUNCATE.
CREATE TRIGGER protect_sale_units BEFORE UPDATE OR DELETE ON sale_units
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_sale_units_truncate BEFORE TRUNCATE ON sale_units
EXECUTE FUNCTION protect_pending_request();
