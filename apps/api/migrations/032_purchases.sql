-- Purchases (Compras): the branch buys used batteries and scrap from whoever brings
-- them. This is the system's first money-out document, and it is a document of its
-- own: a sale is registered normally at full price and the purchase is registered
-- afterwards, here. One same document serves a purchase next to a sale and a customer
-- who only comes to sell.
--
-- A used battery is never resold, so it belongs to none of the existing structures:
-- not to the catalogue (which requires a brand, a capacity and a polarity), not to
-- the point of sale (which decrements stock) and not to inventory_balances (keyed by
-- variant). This migration therefore adds a document instead of widening one, and it
-- touches no existing table, column, function or trigger.
--
-- A document is immutable and is corrected only by one counter-document that mirrors
-- it exactly: the same lines with negated quantity and kg, the same prices, negated
-- total and paid amounts, and a stated reason. At most one counter-document exists per
-- original, both stay visible forever, and a counter-document is itself immutable and
-- is never reversed.
--
-- What was received is derived, never stored: every read is the sum of the persisted
-- lines, so a reversal nets out by construction and there is no second balance to
-- drift. This migration adds no balance row, no stored total and no realtime scope.
--
-- Money is numeric(12,2) and weight numeric(12,3), never a binary float. A used line
-- amount is quantity * unit_price, exact; a scrap line amount is kg * price_per_kg
-- rounded half up to the cent. numeric round() is half away from zero, so the amount
-- of a counter-document is exactly the negation of its original's.

-- Reference data: the four materials the branch buys by the kilogram, typed data and
-- never a client value. A scrap line names one of these rows.
CREATE TABLE materials (
    id smallint PRIMARY KEY CHECK (id > 0),
    name text NOT NULL UNIQUE CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
    -- Every material is bought by weight: there is no piece, litre or unit material.
    unit text NOT NULL DEFAULT 'kg' CHECK (unit = 'kg')
);
INSERT INTO materials(id,name,unit) VALUES (1,'Cobre','kg'),(2,'Aluminio','kg'),(3,'Plomo','kg'),(4,'Bronce','kg');

-- The document: the branch that bought, the note, the total, how it was paid, the
-- account that received it and the reversal binding. Nothing about the person who
-- brought the material is recorded: the document names the model or the material and
-- the price, and nothing else.
CREATE TABLE purchases (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    location_id smallint NOT NULL REFERENCES locations(id),
    note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
    -- Both amounts keep the document's sign: positive in an original purchase and
    -- negative in its counter-document. The sign rule and the settlement rule below
    -- are the database's, and they refuse with this domain's own SQLSTATEs.
    total numeric(12,2) NOT NULL CHECK (total <> 'NaN'::numeric),
    paid_cash numeric(12,2) NOT NULL DEFAULT 0 CHECK (paid_cash <> 'NaN'::numeric),
    paid_transfer numeric(12,2) NOT NULL DEFAULT 0 CHECK (paid_transfer <> 'NaN'::numeric),
    reverses_purchase_id bigint REFERENCES purchases(id),
    reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
    created_by_account_id integer NOT NULL REFERENCES auth_accounts(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- A document never reverses itself and a counter-document always states why.
    CHECK (reverses_purchase_id IS NULL OR reverses_purchase_id <> id),
    CHECK ((reverses_purchase_id IS NULL AND reason = '')
        OR (reverses_purchase_id IS NOT NULL AND btrim(reason) <> ''))
);

-- The branch history is read newest first.
CREATE INDEX purchases_branch_history ON purchases(location_id, id DESC);

-- At most one counter-document per original: both stay visible forever. The index is
-- the last authority; the admission trigger refuses the second one with LP004, because
-- a 23505 is not a refusal this contract publishes.
CREATE UNIQUE INDEX purchases_single_reversal ON purchases(reverses_purchase_id)
WHERE reverses_purchase_id IS NOT NULL;

-- A used battery is identified only by its model code: no brand, no polarity and no
-- condition. The code is trimmed and upper-cased by the caller and stored exactly as
-- the contract spells it. The sign of the quantity is the document's.
CREATE TABLE purchase_used_lines (
    purchase_id bigint NOT NULL REFERENCES purchases(id),
    model text NOT NULL CHECK (model ~ '^[A-Z0-9][A-Z0-9 ._/-]{0,39}$'),
    quantity bigint NOT NULL CHECK (quantity <> 0),
    unit_price numeric(12,2) NOT NULL CHECK (unit_price > 0 AND unit_price <> 'NaN'::numeric),
    -- Derived by the line trigger from the quantity and the price: never typed.
    amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount <> 'NaN'::numeric),
    PRIMARY KEY (purchase_id, model)
);

-- Scrap is bought by the kilogram: one line per material, a weight and a price per
-- kilogram. The weight keeps the document's sign, so a counter-document negates it.
CREATE TABLE purchase_scrap_lines (
    purchase_id bigint NOT NULL REFERENCES purchases(id),
    material_id smallint NOT NULL REFERENCES materials(id),
    kg numeric(12,3) NOT NULL CHECK (kg <> 0 AND kg <> 'NaN'::numeric),
    price_per_kg numeric(12,2) NOT NULL CHECK (price_per_kg > 0 AND price_per_kg <> 'NaN'::numeric),
    amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount <> 'NaN'::numeric),
    PRIMARY KEY (purchase_id, material_id)
);

-- The last price paid for a model and for a material in one branch, and the received
-- totals of the month, are reads over these lines: one access path per kind, newest
-- line first inside the key.
CREATE INDEX purchase_used_lines_by_model ON purchase_used_lines(model, purchase_id DESC);
CREATE INDEX purchase_scrap_lines_by_material ON purchase_scrap_lines(material_id, purchase_id DESC);

-- The branch, the settlement, the sign and the reversal binding are database authority,
-- not a caller promise. The branch row stays locked for the rest of the transaction, so
-- a branch retired concurrently cannot still receive a purchase.
CREATE FUNCTION admit_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    active boolean;
    owner_location smallint;
    owner_active boolean;
    target purchases%ROWTYPE;
BEGIN
    -- Branch only: the warehouse (location 1) never buys.
    IF NEW.location_id <= 1 THEN
        RAISE EXCEPTION USING ERRCODE='LP001', MESSAGE='Purchases are registered only by a branch';
    END IF;
    SELECT deleted_at IS NULL INTO active FROM locations WHERE id=NEW.location_id FOR UPDATE;
    IF NOT FOUND OR NOT active THEN
        RAISE EXCEPTION USING ERRCODE='LP001', MESSAGE='A purchase requires an active branch';
    END IF;
    SELECT location_id,deleted_at IS NULL INTO owner_location,owner_active
    FROM auth_accounts WHERE id=NEW.created_by_account_id;
    IF NOT FOUND OR NOT owner_active OR owner_location IS DISTINCT FROM NEW.location_id THEN
        RAISE EXCEPTION USING ERRCODE='LP001', MESSAGE='A purchase is registered only by the account of its own branch';
    END IF;
    -- The settlement rule: the two paid amounts are the total, exactly.
    IF NEW.total IS DISTINCT FROM NEW.paid_cash + NEW.paid_transfer THEN
        RAISE EXCEPTION USING ERRCODE='LP002', MESSAGE='Purchase total must equal the cash plus the transfer paid';
    END IF;
    -- The sign rule: an original purchase spends money, its counter-document returns it.
    IF NEW.reverses_purchase_id IS NULL THEN
        IF NEW.total <= 0 OR NEW.paid_cash < 0 OR NEW.paid_transfer < 0 THEN
            RAISE EXCEPTION USING ERRCODE='LP005', MESSAGE='A purchase spends money: its total is positive';
        END IF;
    ELSE
        IF NEW.total >= 0 OR NEW.paid_cash > 0 OR NEW.paid_transfer > 0 THEN
            RAISE EXCEPTION USING ERRCODE='LP005', MESSAGE='A counter-document returns money: its total is negative';
        END IF;
        -- The target is locked before it is judged, so two concurrent reversals of the
        -- same document cannot both pass this check.
        SELECT * INTO target FROM purchases WHERE id=NEW.reverses_purchase_id FOR UPDATE;
        IF NOT FOUND OR target.location_id IS DISTINCT FROM NEW.location_id THEN
            RAISE EXCEPTION USING ERRCODE='LP003', MESSAGE='A counter-document must mirror an original purchase of the same branch';
        END IF;
        IF target.reverses_purchase_id IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='LP004', MESSAGE='A counter-document cannot be reversed';
        END IF;
        IF EXISTS (SELECT 1 FROM purchases counter WHERE counter.reverses_purchase_id=NEW.reverses_purchase_id) THEN
            RAISE EXCEPTION USING ERRCODE='LP004', MESSAGE='A purchase is reversed at most once';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_purchase BEFORE INSERT ON purchases
FOR EACH ROW EXECUTE FUNCTION admit_purchase();

-- The amount of a used line is exact, and its sign follows the document's: an original
-- purchase buys batteries, its counter-document returns them.
CREATE FUNCTION apply_purchase_used_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header purchases%ROWTYPE;
    amount numeric;
BEGIN
    SELECT * INTO header FROM purchases WHERE id=NEW.purchase_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LP005', MESSAGE='Purchase line requires a persisted document';
    END IF;
    IF header.reverses_purchase_id IS NULL THEN
        IF NEW.quantity < 1 THEN
            RAISE EXCEPTION USING ERRCODE='LP005', MESSAGE='Purchase lines must be positive';
        END IF;
    ELSE
        IF NEW.quantity > -1 THEN
            RAISE EXCEPTION USING ERRCODE='LP005', MESSAGE='Counter-document lines must be negative';
        END IF;
    END IF;
    -- numeric arithmetic keeps the product exact and the bound check before any cast.
    amount := NEW.quantity::numeric * NEW.unit_price;
    IF amount > 9999999999.99 OR amount < -9999999999.99 THEN
        RAISE EXCEPTION USING ERRCODE='LP005', MESSAGE='Purchase line amount exceeds the admitted money range';
    END IF;
    NEW.amount := amount;
    RETURN NEW;
END;
$$;
CREATE TRIGGER apply_purchase_used_line BEFORE INSERT ON purchase_used_lines
FOR EACH ROW EXECUTE FUNCTION apply_purchase_used_line();

-- The amount of a scrap line is kg * price_per_kg rounded half up to the cent, and its
-- sign follows the document's. Half away from zero keeps the counter-document's amount
-- the exact negation of its original's, so a reversed purchase nets out to zero.
CREATE FUNCTION apply_purchase_scrap_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header purchases%ROWTYPE;
    amount numeric;
BEGIN
    SELECT * INTO header FROM purchases WHERE id=NEW.purchase_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LP005', MESSAGE='Purchase line requires a persisted document';
    END IF;
    IF header.reverses_purchase_id IS NULL THEN
        IF NEW.kg <= 0 THEN
            RAISE EXCEPTION USING ERRCODE='LP005', MESSAGE='Purchase lines must be positive';
        END IF;
    ELSE
        IF NEW.kg >= 0 THEN
            RAISE EXCEPTION USING ERRCODE='LP005', MESSAGE='Counter-document lines must be negative';
        END IF;
    END IF;
    -- The bound check runs on the product before the cast and before the rounding, so
    -- an impossible weight never reaches numeric(12,2).
    IF NEW.kg * NEW.price_per_kg > 9999999999.99 OR NEW.kg * NEW.price_per_kg < -9999999999.99 THEN
        RAISE EXCEPTION USING ERRCODE='LP005', MESSAGE='Purchase line amount exceeds the admitted money range';
    END IF;
    amount := round(NEW.kg * NEW.price_per_kg, 2);
    NEW.amount := amount;
    RETURN NEW;
END;
$$;
CREATE TRIGGER apply_purchase_scrap_line BEFORE INSERT ON purchase_scrap_lines
FOR EACH ROW EXECUTE FUNCTION apply_purchase_scrap_line();

-- The document is judged at commit, after both line kinds were inserted or not: it
-- carries at least one line, its total is exactly the sum of its line amounts, and a
-- counter-document mirrors its original line by line and amount by amount.
CREATE FUNCTION require_purchase_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    used_count integer;
    scrap_count integer;
    lines_total numeric(12,2);
    target purchases%ROWTYPE;
BEGIN
    SELECT count(*) INTO used_count FROM purchase_used_lines WHERE purchase_id=NEW.id;
    SELECT count(*) INTO scrap_count FROM purchase_scrap_lines WHERE purchase_id=NEW.id;
    IF used_count + scrap_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='LP005', MESSAGE='A purchase requires at least one line';
    END IF;
    IF used_count > 190 OR scrap_count > 190 THEN
        RAISE EXCEPTION USING ERRCODE='LP005', MESSAGE='A purchase admits at most one hundred ninety lines per kind';
    END IF;
    IF NEW.reverses_purchase_id IS NOT NULL THEN
        SELECT * INTO target FROM purchases WHERE id=NEW.reverses_purchase_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LP003', MESSAGE='A counter-document requires a persisted original purchase';
        END IF;
        -- Every original line, of either kind, is mirrored exactly: same identity, same
        -- price, negated quantity or weight.
        IF EXISTS (
            SELECT 1 FROM purchase_used_lines original
            WHERE original.purchase_id=NEW.reverses_purchase_id
            AND NOT EXISTS (
                SELECT 1 FROM purchase_used_lines counter
                WHERE counter.purchase_id=NEW.id AND counter.model=original.model
                AND counter.quantity=-original.quantity
                AND counter.unit_price=original.unit_price
            )
        ) OR EXISTS (
            SELECT 1 FROM purchase_used_lines counter
            WHERE counter.purchase_id=NEW.id
            AND NOT EXISTS (
                SELECT 1 FROM purchase_used_lines original
                WHERE original.purchase_id=NEW.reverses_purchase_id AND original.model=counter.model
            )
        ) OR EXISTS (
            SELECT 1 FROM purchase_scrap_lines original
            WHERE original.purchase_id=NEW.reverses_purchase_id
            AND NOT EXISTS (
                SELECT 1 FROM purchase_scrap_lines counter
                WHERE counter.purchase_id=NEW.id AND counter.material_id=original.material_id
                AND counter.kg=-original.kg
                AND counter.price_per_kg=original.price_per_kg
            )
        ) OR EXISTS (
            SELECT 1 FROM purchase_scrap_lines counter
            WHERE counter.purchase_id=NEW.id
            AND NOT EXISTS (
                SELECT 1 FROM purchase_scrap_lines original
                WHERE original.purchase_id=NEW.reverses_purchase_id AND original.material_id=counter.material_id
            )
        ) THEN
            RAISE EXCEPTION USING ERRCODE='LP003', MESSAGE='A counter-document must mirror every line of its original';
        END IF;
        -- The header is mirrored too: same note shape and negated amounts, so a reversal
        -- always returns exactly what it took.
        IF NEW.total IS DISTINCT FROM -target.total
           OR NEW.paid_cash IS DISTINCT FROM -target.paid_cash
           OR NEW.paid_transfer IS DISTINCT FROM -target.paid_transfer THEN
            RAISE EXCEPTION USING ERRCODE='LP003', MESSAGE='A counter-document must negate the amounts of its original';
        END IF;
    END IF;
    SELECT coalesce((SELECT sum(amount) FROM purchase_used_lines WHERE purchase_id=NEW.id),0)
         + coalesce((SELECT sum(amount) FROM purchase_scrap_lines WHERE purchase_id=NEW.id),0)
    INTO lines_total;
    IF lines_total IS DISTINCT FROM NEW.total THEN
        RAISE EXCEPTION USING ERRCODE='LP002', MESSAGE='Purchase total must equal the sum of its lines';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_purchase_document AFTER INSERT ON purchases
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_purchase_document();

-- A line belongs to a document that already accounts for it: a line appended after the
-- document committed would leave the header total stale and break the reversal mirror,
-- so every line insert re-checks the whole document at commit. The header keeps its own
-- deferred check; this one closes INSERT, the only mutation the immutability guards leave
-- open on the line tables.
CREATE FUNCTION guard_purchase_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header purchases%ROWTYPE;
    lines_total numeric;
BEGIN
    SELECT * INTO header FROM purchases WHERE id=NEW.purchase_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LP005', MESSAGE='A purchase line requires a persisted document';
    END IF;
    SELECT coalesce((SELECT sum(amount) FROM purchase_used_lines WHERE purchase_id=NEW.purchase_id),0)
         + coalesce((SELECT sum(amount) FROM purchase_scrap_lines WHERE purchase_id=NEW.purchase_id),0)
    INTO lines_total;
    IF lines_total IS DISTINCT FROM header.total THEN
        RAISE EXCEPTION USING ERRCODE='LP002', MESSAGE='Purchase total must equal the sum of its lines';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER guard_purchase_used_line AFTER INSERT ON purchase_used_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_purchase_line();
CREATE CONSTRAINT TRIGGER guard_purchase_scrap_line AFTER INSERT ON purchase_scrap_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_purchase_line();

-- Immutable documents and immutable reference data: reuse the existing immutability
-- guard, including TRUNCATE.
CREATE TRIGGER protect_purchases BEFORE UPDATE OR DELETE ON purchases
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_purchases_truncate BEFORE TRUNCATE ON purchases
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_purchase_used_lines BEFORE UPDATE OR DELETE ON purchase_used_lines
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_purchase_used_lines_truncate BEFORE TRUNCATE ON purchase_used_lines
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_purchase_scrap_lines BEFORE UPDATE OR DELETE ON purchase_scrap_lines
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_purchase_scrap_lines_truncate BEFORE TRUNCATE ON purchase_scrap_lines
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_materials BEFORE UPDATE OR DELETE ON materials
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_materials_truncate BEFORE TRUNCATE ON materials
EXECUTE FUNCTION protect_pending_request();
