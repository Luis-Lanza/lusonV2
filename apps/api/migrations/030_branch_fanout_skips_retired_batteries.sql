-- A branch created after a battery was retired must not inherit balance rows for
-- that battery's variants. The matrix is a required identity for the operating
-- catalog, not for retired identities: 021, 022 and 025 refuse to operate without
-- the row, and a retired battery can never be operated again.
-- 029 is applied and checksummed, so the narrowing is forward-only here, and the
-- initialization lock stays because the new branch still reads the catalog under
-- the same snapshot the concurrent battery creation holds.

CREATE OR REPLACE FUNCTION initialize_branch_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- 015 owns this realtime audience row. 029 replaced this function without it,
    -- so a branch created since then had no transfers scope; restoring it here is
    -- what makes the branch's transfers visible to the realtime audience again.
    INSERT INTO realtime_revisions(scope) VALUES ('transfers:' || NEW.id)
    ON CONFLICT (scope) DO NOTHING;
    IF EXISTS (SELECT 1 FROM initialization_metadata) THEN
        PERFORM pg_advisory_xact_lock(21485914531180593);
        INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
        SELECT NEW.id,v.id,0,0 FROM catalog_variants v
        JOIN catalog_entries e ON e.id=v.catalog_entry_id
        WHERE e.deleted_at IS NULL
        ORDER BY v.id;
    END IF;
    RETURN NEW;
END;
$$;

-- Branches created between 029 and this migration never got their transfers scope,
-- and a trigger only fires for future rows. Backfill every existing branch once, so
-- no subscriber stays blind to transfers of an already existing branch.
INSERT INTO realtime_revisions(scope)
SELECT 'transfers:' || l.id FROM locations l
ON CONFLICT (scope) DO NOTHING;
