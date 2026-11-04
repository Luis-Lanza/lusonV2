-- The price belongs to the battery, not to the polarity: "el precio se aplica el
-- mismo tanto a las baterias con polaridad L y R del mismo medelo/marca". A battery
-- is a catalogue entry (brand + model + capacity), so the branch price key moves from
-- (branch, variant) to (branch, battery) and the two polarities of one battery can
-- never hold different prices, because there is only one row to hold them.
--
-- The sale line does not change: a sale sells a polarity, so sale_lines keeps its
-- variant_id, its own frozen prices and the warranty term the seller stated. What
-- changes is where the pair is resolved from: the sold variant's battery.
--
-- 024 and 025 stay untouched (they are already applied), the sale tables are not
-- altered, the unused variant_warranties table is kept, and money stays numeric(12,2)
-- with the same checks. Additive in the sense that matters here: no table is dropped,
-- no sale row is rewritten and the row guards of 024 stay installed and enabled.
--
-- No new realtime code is required: catalog prices are re-read on navigation, so the
-- existing realtime_revisions scope set is untouched.

-- 1. The battery of a price, added nullable so an existing row can be backfilled.
ALTER TABLE branch_prices ADD COLUMN catalog_entry_id integer REFERENCES catalog_entries(id);

-- 2. Backfill every variant-keyed row with the battery of the variant it was keyed by.
UPDATE branch_prices p
SET catalog_entry_id = v.catalog_entry_id
FROM catalog_variants v
WHERE v.id = p.variant_id;

ALTER TABLE branch_prices ALTER COLUMN catalog_entry_id SET NOT NULL;

-- 3. Two polarity rows of one battery collapse into one. The duplicate is resolved
-- deterministically: the most recently updated row wins, and an exact tie is broken by
-- the larger variant id, so the same data always collapses to the same surviving pair.
-- This is the only moment a price row is deleted; the replace-not-delete guard is
-- disabled for exactly these statements and enabled again right after them.
ALTER TABLE branch_prices DISABLE TRIGGER protect_branch_prices;
DELETE FROM branch_prices p
USING branch_prices newer
WHERE newer.branch_location_id = p.branch_location_id
  AND newer.catalog_entry_id = p.catalog_entry_id
  AND (newer.updated_at,newer.variant_id) > (p.updated_at,p.variant_id);
ALTER TABLE branch_prices ENABLE TRIGGER protect_branch_prices;

-- 4. The key becomes the battery: the reverse index of the old key goes away with the
-- column, and the new pair is unique by primary key, so a second price for the same
-- battery of the same branch can never be written.
ALTER TABLE branch_prices DROP CONSTRAINT branch_prices_pkey;
DROP INDEX branch_prices_variant;
ALTER TABLE branch_prices DROP COLUMN variant_id;
ALTER TABLE branch_prices ADD CONSTRAINT branch_prices_pkey PRIMARY KEY (branch_location_id, catalog_entry_id);

-- The matrix is read by battery, so the reverse lookup of the primary key is indexed
-- as well, exactly like the old shape indexed its variant.
CREATE INDEX branch_prices_entry ON branch_prices(catalog_entry_id);

-- 5. The line trigger of 025 resolved the pair by the sold variant. It resolves it
-- through the sold variant's battery instead; every other rule of 025 (the deferred
-- document, the balance lock, existing never below reserved, reserved never written and
-- the seller's own warranty term) is kept exactly as it was.
CREATE OR REPLACE FUNCTION apply_sale_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header sales%ROWTYPE;
    entry_id integer;
    branch_min numeric(12,2);
    balance inventory_balances%ROWTYPE;
    total numeric;
BEGIN
    SELECT * INTO header FROM sales WHERE id=NEW.sale_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LV002', MESSAGE='Sale line requires a persisted sale';
    END IF;
    -- The price is the battery's, so both polarities of one battery resolve the same
    -- pair and no line can pick a price the other polarity does not have.
    SELECT catalog_entry_id INTO entry_id FROM catalog_variants WHERE id=NEW.variant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LV003', MESSAGE='Variant has no price in this branch: it is not sellable',
            DETAIL=NEW.variant_id::text;
    END IF;
    -- A battery without a sale price in this branch is not sellable, and the floor is
    -- the branch's own stored minimum, never the caller's value.
    SELECT min_price INTO branch_min FROM branch_prices
    WHERE branch_location_id=header.branch_location_id AND catalog_entry_id=entry_id;
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
