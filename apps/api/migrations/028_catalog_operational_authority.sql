-- The catalog becomes operational data. The embedded fixture remains the initial
-- seed; batteries created afterwards get allocated identities and a one-way
-- retirement. Append-only evidence, balances and prices are never rewritten.

ALTER TABLE catalog_entries ADD COLUMN deleted_at timestamptz;

-- Archived identities free their (brand, model) pair for a new active battery.
ALTER TABLE catalog_entries DROP CONSTRAINT catalog_entries_brand_model_key;
CREATE UNIQUE INDEX catalog_entries_active_brand_model
ON catalog_entries (brand, model) WHERE deleted_at IS NULL;

-- Identities after the fixture are allocated, never typed.
ALTER TABLE catalog_entries DROP CONSTRAINT catalog_entries_id_check;
ALTER TABLE catalog_variants DROP CONSTRAINT catalog_variants_id_check;
CREATE SEQUENCE catalog_entries_id_seq AS integer START WITH 96 OWNED BY catalog_entries.id;
CREATE SEQUENCE catalog_variants_id_seq AS integer START WITH 191 OWNED BY catalog_variants.id;
ALTER TABLE catalog_entries ALTER COLUMN id SET DEFAULT nextval('catalog_entries_id_seq');
ALTER TABLE catalog_variants ALTER COLUMN id SET DEFAULT nextval('catalog_variants_id_seq');

-- Call under the common integrity fence for an authoritative mutation decision.
-- VOLATILE (the default) obtains fresh READ COMMITTED snapshots after waiting.
CREATE FUNCTION catalog_entry_retirement_blocker(entry_id integer) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM inventory_balances b JOIN catalog_variants v ON v.id=b.variant_id
        WHERE v.catalog_entry_id=entry_id AND (b.existing<>0 OR b.reserved<>0)) THEN
        RETURN 'stock';
    END IF;
    IF EXISTS (
        SELECT 1 FROM transfer_requests h
        WHERE h.status IN ('pending','approved','in_transit')
        AND EXISTS (SELECT 1 FROM transfer_request_items i JOIN catalog_variants v ON v.id=i.variant_id
            WHERE i.request_id=h.id AND v.catalog_entry_id=entry_id)
    ) THEN RETURN 'operations'; END IF;
    IF EXISTS (
        SELECT 1 FROM transfer_requests h
        WHERE h.status='received' AND (
            EXISTS (SELECT 1 FROM transfer_count_proposals p JOIN catalog_variants v ON v.id=p.variant_id
                WHERE p.request_id=h.id AND v.catalog_entry_id=entry_id
                AND NOT EXISTS (SELECT 1 FROM transfer_count_proposals newer
                    WHERE (newer.request_id,newer.variant_id)=(p.request_id,p.variant_id) AND newer.revision>p.revision)
                AND NOT EXISTS (SELECT 1 FROM transfer_count_decisions d
                    WHERE (d.request_id,d.variant_id,d.revision)=(p.request_id,p.variant_id,p.revision)))
            OR EXISTS (SELECT 1 FROM transfer_restitution_proposals p JOIN catalog_variants v ON v.id=p.variant_id
                WHERE p.request_id=h.id AND v.catalog_entry_id=entry_id
                AND NOT EXISTS (SELECT 1 FROM transfer_restitution_proposals newer
                    WHERE (newer.request_id,newer.variant_id)=(p.request_id,p.variant_id) AND newer.revision>p.revision)
                AND NOT EXISTS (SELECT 1 FROM transfer_restitution_decisions d
                    WHERE (d.request_id,d.variant_id,d.revision)=(p.request_id,p.variant_id,p.revision)))
            OR EXISTS (SELECT 1 FROM transfer_dispatch_proposals p JOIN catalog_variants v ON v.id=p.variant_id
                WHERE p.request_id=h.id AND v.catalog_entry_id=entry_id
                AND NOT EXISTS (SELECT 1 FROM transfer_dispatch_proposals newer
                    WHERE (newer.request_id,newer.variant_id)=(p.request_id,p.variant_id) AND newer.revision>p.revision)
                AND NOT EXISTS (SELECT 1 FROM transfer_dispatch_decisions d
                    WHERE (d.request_id,d.variant_id,d.revision)=(p.request_id,p.variant_id,p.revision)))
        )
    ) THEN RETURN 'operations'; END IF;
    RETURN NULL;
END;
$$;

-- Fence before tuple/FK locks, never from inside a row trigger.
CREATE TRIGGER lock_catalog_retirement BEFORE UPDATE ON catalog_entries
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();

DROP TRIGGER protect_entries ON catalog_entries;
CREATE FUNCTION guard_catalog_entry_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE blocker text;
BEGIN
    IF TG_OP='INSERT' THEN
        RETURN NEW;
    ELSIF TG_OP='DELETE' THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_entry_deletion_forbidden',
            MESSAGE='catalog batteries are retired, never deleted';
    END IF;
    IF NEW.id<>OLD.id THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_entry_identity_immutable',
            MESSAGE='catalog battery identity is immutable';
    END IF;
    IF OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN
        IF OLD.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_entry_retired_immutable',
                MESSAGE='a retired catalog battery is immutable';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
       AND (to_jsonb(NEW)-'deleted_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'deleted_at') THEN
        blocker:=catalog_entry_retirement_blocker(OLD.id);
        IF blocker IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_retirement_blocked',
                MESSAGE='Battery retirement blocked: '||blocker;
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_entry_identity_immutable',
        MESSAGE='catalog battery identity is immutable';
END;
$$;
CREATE TRIGGER protect_entries BEFORE INSERT OR UPDATE OR DELETE ON catalog_entries
FOR EACH ROW EXECUTE FUNCTION guard_catalog_entry_identity();

-- Variants are created with their battery and are never edited or deleted: a
-- polarity keeps the identity that append-only evidence already references.
DROP TRIGGER protect_variants ON catalog_variants;
CREATE FUNCTION guard_catalog_variant_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_variant_immutable',
            MESSAGE='catalog variant identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER protect_variants BEFORE INSERT OR UPDATE OR DELETE ON catalog_variants
FOR EACH ROW EXECUTE FUNCTION guard_catalog_variant_identity();

-- Every active branch carries a balance row for every variant; operations
-- depend on that row existing. Seed inserts precede the metadata row, so the
-- seed keeps owning its own balances.
CREATE FUNCTION initialize_variant_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM initialization_metadata) THEN
        INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
        SELECT l.id,NEW.id,0,0 FROM locations l WHERE l.deleted_at IS NULL ORDER BY l.id
        ON CONFLICT (location_id,variant_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER initialize_variant_stock AFTER INSERT ON catalog_variants
FOR EACH ROW EXECUTE FUNCTION initialize_variant_inventory();
