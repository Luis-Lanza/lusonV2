-- Both inventory fan-outs read the other side's rows to fill the balance matrix.
-- Reading under a snapshot without coordination lets a branch and a variant
-- created concurrently each miss the other, and the missing row is permanent:
-- later stock, adjustment, sale and transfer paths require that exact row.
-- Every fan-out now takes the initialization serialization lock the branch
-- creator already holds, so each one observes the other's committed work.

CREATE OR REPLACE FUNCTION initialize_branch_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM initialization_metadata) THEN
        PERFORM pg_advisory_xact_lock(21485914531180593);
        INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
        SELECT NEW.id,v.id,0,0 FROM catalog_variants v ORDER BY v.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION initialize_variant_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM initialization_metadata) THEN
        PERFORM pg_advisory_xact_lock(21485914531180593);
        INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
        SELECT l.id,NEW.id,0,0 FROM locations l WHERE l.deleted_at IS NULL ORDER BY l.id
        ON CONFLICT (location_id,variant_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

-- A variant is created together with its battery, never after that battery was
-- retired: a retired battery must not acquire new identities or balance rows.
CREATE OR REPLACE FUNCTION guard_catalog_variant_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_variant_immutable',
            MESSAGE='catalog variant identity is immutable';
    END IF;
    IF EXISTS (SELECT 1 FROM catalog_entries e
        WHERE e.id=NEW.catalog_entry_id AND e.deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_variant_retired_battery',
            MESSAGE='a retired catalog battery cannot gain a variant';
    END IF;
    RETURN NEW;
END;
$$;
