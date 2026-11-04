-- Branch price list (Catálogo de precios): the warehouse administers a minimum
-- and a suggested sale price per (branch, variant) and one warranty term per
-- variant. The warranty term is a product datum, not a value the seller types at
-- the counter, so it is stored once per variant beside the prices.
--
-- Money is numeric(12,2), never a binary float: the application reads it as the
-- canonical decimal text, so no rounding is invented between the database and the
-- client. The warehouse (location 1) never keeps a sale price and a retired branch
-- never receives one; both are database authority, not a caller promise. A pair is
-- replaced in place and never deleted, so what a branch could sell for is never
-- erased from the record.
--
-- No new realtime code is required here: catalog prices are re-read on navigation,
-- so the existing realtime_revisions scope set is untouched.
CREATE TABLE variant_warranties (
    variant_id integer PRIMARY KEY REFERENCES catalog_variants(id),
    warranty_months smallint NOT NULL CHECK (warranty_months BETWEEN 1 AND 120),
    updated_by_account_id integer NOT NULL REFERENCES auth_accounts(id),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branch_prices (
    branch_location_id smallint NOT NULL REFERENCES locations(id),
    variant_id integer NOT NULL REFERENCES catalog_variants(id),
    min_price numeric(12,2) NOT NULL CHECK (min_price > 0 AND min_price <> 'NaN'::numeric),
    suggested_price numeric(12,2) NOT NULL CHECK (suggested_price >= min_price AND suggested_price <> 'NaN'::numeric),
    updated_by_account_id integer NOT NULL REFERENCES auth_accounts(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (branch_location_id, variant_id)
);

-- The matrix is read by variant, so the reverse lookup of the primary key is
-- indexed as well.
CREATE INDEX branch_prices_variant ON branch_prices(variant_id);

-- The sale scope is enforced where the row is written: the warehouse never keeps a
-- branch price, and a retired branch never receives one. This runs on insert and on
-- replace, so a branch retired between two writes cannot keep receiving prices.
CREATE FUNCTION admit_branch_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active boolean;
BEGIN
    IF NEW.branch_location_id = 1 THEN
        RAISE EXCEPTION USING ERRCODE='LP00N', MESSAGE='The warehouse never keeps branch sale prices';
    END IF;
    SELECT deleted_at IS NULL INTO active FROM locations WHERE id=NEW.branch_location_id;
    IF NOT FOUND OR NOT active THEN
        RAISE EXCEPTION USING ERRCODE='LP00N', MESSAGE='Branch sale prices require an active branch';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_branch_price BEFORE INSERT OR UPDATE ON branch_prices
FOR EACH ROW EXECUTE FUNCTION admit_branch_price();

-- Prices and warranty terms are replaced, never deleted: the persisted pair is the
-- record of what the branch could sell for, and the term is the product's promise.
CREATE FUNCTION reject_branch_price_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE='LP00N', MESSAGE='Branch prices are replaced, never deleted';
END;
$$;
CREATE TRIGGER protect_branch_prices BEFORE DELETE ON branch_prices
FOR EACH ROW EXECUTE FUNCTION reject_branch_price_deletion();
CREATE TRIGGER protect_branch_prices_truncate BEFORE TRUNCATE ON branch_prices
EXECUTE FUNCTION reject_branch_price_deletion();

CREATE FUNCTION reject_warranty_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE='LP00N', MESSAGE='Warranty terms are replaced, never deleted';
END;
$$;
CREATE TRIGGER protect_variant_warranties BEFORE DELETE ON variant_warranties
FOR EACH ROW EXECUTE FUNCTION reject_warranty_deletion();
CREATE TRIGGER protect_variant_warranties_truncate BEFORE TRUNCATE ON variant_warranties
EXECUTE FUNCTION reject_warranty_deletion();
