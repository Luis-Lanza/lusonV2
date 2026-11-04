-- Branch point of sale: an immutable sale document with one or more lines that
-- decrements the stock of the branch that sold it. Only a branch sells (never the
-- warehouse, location 1) and only the branch's own account registers a sale there.
-- The database owns the price rules: the frozen branch minimum comes from
-- branch_prices, the charged price is never under it, and a variant without a pair in
-- the branch is not sellable. The warranty term is not a product datum: the seller
-- states it at the counter, it is required on every line and it is frozen there, so a
-- sale always congeals the term that was actually promised. Money stays numeric(12,2),
-- never a binary float, exactly like the price list.
--
-- No new realtime code is required here: migration 004 already installs
-- invalidate_balance_change on inventory_balances, so every line applied by these
-- triggers invalidates the 'inventory' scope inside the same transaction.
CREATE TABLE sales (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- A sale belongs to a branch and to the account of that branch.
    branch_location_id smallint NOT NULL REFERENCES locations(id),
    -- Both document numbers are allocated by admit_sale() from this branch's own
    -- history: the caller never chooses a correlative nor a warranty number.
    branch_sequence bigint NOT NULL DEFAULT 0 CHECK (branch_sequence BETWEEN 1 AND 999999999),
    warranty_number text NOT NULL DEFAULT '' CHECK (warranty_number ~ '^[1-9][0-9]{0,4}-[0-9]{6,12}$'),
    payment_method text NOT NULL CHECK (payment_method IN ('cash','card','transfer')),
    -- The client the sale is registered for. Bounds are the house text bounds: a
    -- mandatory name and two optional documents.
    customer_name text NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 1 AND 120),
    customer_phone text NOT NULL DEFAULT '' CHECK (char_length(customer_phone) <= 40),
    customer_document text NOT NULL DEFAULT '' CHECK (char_length(customer_document) <= 40),
    total numeric(12,2) NOT NULL CHECK (total > 0 AND total <> 'NaN'::numeric),
    created_by_account_id integer NOT NULL REFERENCES auth_accounts(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- A correlative and a warranty number are unique inside their branch, so two
    -- branches never share either numeration.
    UNIQUE (branch_location_id, branch_sequence),
    UNIQUE (branch_location_id, warranty_number)
);

-- The history of one branch is read newest-first, so the branch is the leading key.
CREATE INDEX sales_branch_history ON sales(branch_location_id, id);

-- The selling account and the branch are database authority, not a caller promise,
-- and the branch row stays locked for the rest of the transaction, so the
-- correlative of a branch is allocated by one writer at a time and a branch retired
-- concurrently cannot still receive a sale.
CREATE FUNCTION admit_sale() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    active boolean;
    owner_location smallint;
    owner_active boolean;
    next_sequence bigint;
BEGIN
    IF NEW.branch_location_id = 1 THEN
        RAISE EXCEPTION USING ERRCODE='LV001', MESSAGE='The warehouse never sells: a sale belongs to a branch';
    END IF;
    SELECT deleted_at IS NULL INTO active FROM locations WHERE id=NEW.branch_location_id FOR UPDATE;
    IF NOT FOUND OR NOT active THEN
        RAISE EXCEPTION USING ERRCODE='LV001', MESSAGE='A sale requires an active branch';
    END IF;
    SELECT location_id,deleted_at IS NULL INTO owner_location,owner_active
    FROM auth_accounts WHERE id=NEW.created_by_account_id;
    IF NOT FOUND OR NOT owner_active OR owner_location IS DISTINCT FROM NEW.branch_location_id THEN
        RAISE EXCEPTION USING ERRCODE='LV001', MESSAGE='A sale is registered only by the account of its own branch';
    END IF;
    SELECT coalesce(max(s.branch_sequence),0)+1 INTO next_sequence
    FROM sales s WHERE s.branch_location_id=NEW.branch_location_id;
    IF next_sequence > 999999999 THEN
        RAISE EXCEPTION USING ERRCODE='LV008', MESSAGE='Sale correlative exhausted for this branch';
    END IF;
    NEW.branch_sequence := next_sequence;
    -- One warranty per sale, numbered inside its branch: distinct branches never
    -- share numeration.
    NEW.warranty_number := NEW.branch_location_id::text || '-' || lpad(next_sequence::text,6,'0');
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_sale BEFORE INSERT ON sales
FOR EACH ROW EXECUTE FUNCTION admit_sale();

-- One line per variant of one sale. The seller states the warranty term, so
-- warranty_months is an input of the line and is frozen here unchanged; the frozen
-- minimum and the subtotal are written by this migration's trigger, never by the
-- caller, so those NOT NULL columns carry a placeholder default that is always
-- overwritten before the checks run.
CREATE TABLE sale_lines (
    sale_id bigint NOT NULL REFERENCES sales(id),
    variant_id integer NOT NULL REFERENCES catalog_variants(id),
    quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
    unit_price numeric(12,2) NOT NULL CHECK (unit_price > 0 AND unit_price <> 'NaN'::numeric),
    min_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (min_price > 0 AND min_price <> 'NaN'::numeric),
    warranty_months smallint NOT NULL CHECK (warranty_months BETWEEN 1 AND 120),
    subtotal numeric(12,2) NOT NULL DEFAULT 0 CHECK (subtotal > 0 AND subtotal <> 'NaN'::numeric),
    PRIMARY KEY (sale_id, variant_id),
    -- The charged price is never under the frozen floor it was admitted against.
    CHECK (unit_price >= min_price)
);

-- Each line is applied immediately, in the caller's ascending variant order, so rows
-- are locked (branch, variant) ascending. The frozen minimum comes from the branch's
-- stored pair, a variant without one there is not sellable, the subtotal is derived
-- here, and existing stock is decremented under the balance row lock: never below zero
-- and never below reserved, and reserved is never modified. The warranty term is the
-- seller's own and is left exactly as the line states it.
CREATE FUNCTION apply_sale_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header sales%ROWTYPE;
    branch_min numeric(12,2);
    balance inventory_balances%ROWTYPE;
    total numeric;
BEGIN
    SELECT * INTO header FROM sales WHERE id=NEW.sale_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LV002', MESSAGE='Sale line requires a persisted sale';
    END IF;
    -- A variant without a sale price in this branch is not sellable, and the floor is
    -- the branch's own stored minimum, never the caller's value.
    SELECT min_price INTO branch_min FROM branch_prices
    WHERE branch_location_id=header.branch_location_id AND variant_id=NEW.variant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LV003', MESSAGE='Variant has no price in this branch: it is not sellable',
            DETAIL=NEW.variant_id::text;
    END IF;
    IF NEW.unit_price < branch_min THEN
        RAISE EXCEPTION USING ERRCODE='LV004', MESSAGE='Sale price is below the minimum of this branch',
            DETAIL=NEW.variant_id::text;
    END IF;
    NEW.min_price := branch_min;
    NEW.subtotal := NEW.unit_price * NEW.quantity;
    SELECT * INTO balance FROM inventory_balances
    WHERE location_id=header.branch_location_id AND variant_id=NEW.variant_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LV005', MESSAGE='A sale requires an existing balance row',
            DETAIL=NEW.variant_id::text;
    END IF;
    -- numeric arithmetic keeps the bound check exact before any bigint cast.
    total := balance.existing::numeric - NEW.quantity::numeric;
    IF total < 0 THEN
        RAISE EXCEPTION USING ERRCODE='LV005', MESSAGE='Sale exceeds the stock of this branch',
            DETAIL=NEW.variant_id::text;
    END IF;
    IF total < balance.reserved THEN
        RAISE EXCEPTION USING ERRCODE='LV005', MESSAGE='Sale requires covered existing stock',
            DETAIL=NEW.variant_id::text;
    END IF;
    UPDATE inventory_balances SET existing=total::bigint
    WHERE location_id=header.branch_location_id AND variant_id=NEW.variant_id;
    RETURN NEW;
END;
$$;
CREATE TRIGGER apply_sale_line BEFORE INSERT ON sale_lines
FOR EACH ROW EXECUTE FUNCTION apply_sale_line();

-- The document is judged at commit, after every line of it was inserted or not: a
-- sale carries at least one line and its total is exactly the sum of its subtotals.
-- The header is immutable, so a total can never be corrected afterwards.
CREATE FUNCTION require_sale_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    line_count integer;
    lines_total numeric(12,2);
BEGIN
    SELECT count(*),coalesce(sum(subtotal),0) INTO line_count,lines_total
    FROM sale_lines WHERE sale_id=NEW.id;
    IF line_count < 1 THEN
        RAISE EXCEPTION USING ERRCODE='LV006', MESSAGE='Sale requires at least one line';
    END IF;
    IF lines_total IS DISTINCT FROM NEW.total THEN
        RAISE EXCEPTION USING ERRCODE='LV007', MESSAGE='Sale total must equal the sum of its lines';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_sale_total AFTER INSERT ON sales
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_sale_total();

-- Immutable documents: reuse the existing immutability guard, including TRUNCATE.
CREATE TRIGGER protect_sales BEFORE UPDATE OR DELETE ON sales
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_sales_truncate BEFORE TRUNCATE ON sales
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_sale_lines BEFORE UPDATE OR DELETE ON sale_lines
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_sale_lines_truncate BEFORE TRUNCATE ON sale_lines
EXECUTE FUNCTION protect_pending_request();
