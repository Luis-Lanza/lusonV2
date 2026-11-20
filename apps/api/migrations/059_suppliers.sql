-- Suppliers are the warehouse counterparty of a stock ingress document. A
-- supplier offers catalogue ENTRIES (a battery brand/model or a product name),
-- while an ingress document keeps naming variants: the offer list is what makes
-- the picker and the persisted document agree.
--
-- Additive only. The ingress authority installed by 021 is NOT redefined: a new
-- BEFORE INSERT trigger states the supplier rule next to it, the same way 055
-- added its own variant-kind trigger instead of replacing the historical guard.
CREATE TABLE suppliers (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL CHECK (
        btrim(name) = name
        AND char_length(name) BETWEEN 3 AND 64
        AND name !~ '[[:cntrl:]]'
    ),
    contact text NOT NULL DEFAULT '' CHECK (
        char_length(contact) <= 200 AND contact !~ '[[:cntrl:]]'
    ),
    -- Retirement is one-way and never deletes the row: documents that name this
    -- supplier keep reading it.
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- One active supplier per name, case-insensitively. A retired name may be used
-- again, and the retired row keeps its own history.
CREATE UNIQUE INDEX suppliers_active_name ON suppliers (lower(name))
WHERE deleted_at IS NULL;

-- The current offer list of a supplier: the set is replaced as a whole, so it
-- carries state and no history of its own.
CREATE TABLE supplier_offers (
    supplier_id bigint NOT NULL REFERENCES suppliers(id),
    catalog_entry_id bigint NOT NULL REFERENCES catalog_entries(id),
    PRIMARY KEY (supplier_id, catalog_entry_id)
);
CREATE INDEX supplier_offers_entry ON supplier_offers (catalog_entry_id);

-- A retired supplier cannot gain new offers, and a retired catalogue entry
-- cannot be offered again: both are operating facts, refused by the database.
CREATE FUNCTION admit_supplier_offer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE supplier_retired boolean;
DECLARE entry_retired boolean;
BEGIN
    SELECT deleted_at IS NOT NULL INTO supplier_retired FROM suppliers WHERE id=NEW.supplier_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LV001', MESSAGE='Supplier offers require a known supplier';
    END IF;
    IF supplier_retired THEN
        RAISE EXCEPTION USING ERRCODE='LV001', MESSAGE='A retired supplier cannot offer products';
    END IF;
    SELECT deleted_at IS NOT NULL INTO entry_retired FROM catalog_entries WHERE id=NEW.catalog_entry_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LV002', MESSAGE='Supplier offers require a known catalogue entry';
    END IF;
    IF entry_retired THEN
        RAISE EXCEPTION USING ERRCODE='LV002', MESSAGE='A retired catalogue entry cannot be offered';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_supplier_offer BEFORE INSERT ON supplier_offers
FOR EACH ROW EXECUTE FUNCTION admit_supplier_offer();

-- Retirement, never deletion: a supplier row is referenced by persisted ingress
-- documents and must stay readable forever.
CREATE FUNCTION protect_supplier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE='LV003', MESSAGE='A supplier is retired, never deleted';
END;
$$;
CREATE TRIGGER protect_supplier BEFORE DELETE ON suppliers
FOR EACH ROW EXECUTE FUNCTION protect_supplier();
CREATE TRIGGER protect_supplier_truncate BEFORE TRUNCATE ON suppliers
EXECUTE FUNCTION protect_supplier();

-- Every new ingress document names a supplier; a counter-entry inherits it.
-- Historical documents written before this migration keep a NULL supplier and
-- are neither rewritten nor re-validated: the trigger only sees INSERTs.
CREATE FUNCTION require_stock_entry_supplier() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target stock_entries%ROWTYPE;
DECLARE active boolean;
BEGIN
    IF NEW.reverses_entry_id IS NULL THEN
        IF NEW.supplier_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='LS009', MESSAGE='Stock ingress requires a supplier';
        END IF;
        SELECT deleted_at IS NULL INTO active FROM suppliers WHERE id=NEW.supplier_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LS010', MESSAGE='Stock ingress requires a known supplier';
        END IF;
        IF NOT active THEN
            RAISE EXCEPTION USING ERRCODE='LS010', MESSAGE='Stock ingress requires an active supplier';
        END IF;
    ELSE
        SELECT * INTO target FROM stock_entries WHERE id=NEW.reverses_entry_id;
        IF NOT FOUND OR target.supplier_id IS DISTINCT FROM NEW.supplier_id THEN
            RAISE EXCEPTION USING ERRCODE='LS012', MESSAGE='A counter-entry must mirror the supplier of its original';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

ALTER TABLE stock_entries ADD COLUMN supplier_id bigint REFERENCES suppliers(id);

CREATE TRIGGER require_stock_entry_supplier BEFORE INSERT ON stock_entries
FOR EACH ROW EXECUTE FUNCTION require_stock_entry_supplier();

-- The offer list is enforced on the document, not only in the screen: every line
-- of a new ingress must belong to an entry its supplier offers. A reversal
-- follows a persisted original instead of a selection, so it is exempt.
CREATE FUNCTION require_offered_stock_entry_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE header stock_entries%ROWTYPE;
BEGIN
    SELECT * INTO header FROM stock_entries WHERE id=NEW.entry_id;
    IF NOT FOUND OR header.reverses_entry_id IS NOT NULL OR header.supplier_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM catalog_variants variant
        JOIN supplier_offers offer
          ON offer.catalog_entry_id=variant.catalog_entry_id
         AND offer.supplier_id=header.supplier_id
        WHERE variant.id=NEW.variant_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE='LS011', MESSAGE='Ingress lines must be offered by the supplier';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER require_offered_stock_entry_line BEFORE INSERT ON stock_entry_lines
FOR EACH ROW EXECUTE FUNCTION require_offered_stock_entry_line();
