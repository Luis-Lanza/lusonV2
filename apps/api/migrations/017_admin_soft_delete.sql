-- Retirement retains identities, inventory matrices and immutable evidence.
ALTER TABLE auth_accounts ADD COLUMN deleted_at timestamptz;
ALTER TABLE locations ADD COLUMN deleted_at timestamptz;
ALTER TABLE auth_accounts ADD CONSTRAINT auth_accounts_retirement_check
    CHECK (deleted_at IS NULL OR (id<>1 AND NOT enabled));
ALTER TABLE locations ADD CONSTRAINT locations_retirement_check
    CHECK (id<>1 OR deleted_at IS NULL);

-- Call under the common integrity fence for an authoritative mutation decision.
-- VOLATILE (the default) obtains fresh READ COMMITTED snapshots after waiting.
CREATE FUNCTION branch_retirement_blocker(branch_id smallint) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM inventory_balances WHERE location_id=branch_id
        AND (existing<>0 OR reserved<>0)) THEN RETURN 'stock'; END IF;
    IF EXISTS (SELECT 1 FROM auth_accounts WHERE location_id=branch_id
        AND deleted_at IS NULL) THEN RETURN 'users'; END IF;
    IF EXISTS (
        SELECT 1 FROM transfer_requests h
        WHERE branch_id IN (h.origin_location_id,h.destination_location_id)
        AND (h.status IN ('pending','approved','in_transit') OR (h.status='received' AND (
            EXISTS (SELECT 1 FROM transfer_count_proposals p WHERE p.request_id=h.id
                AND NOT EXISTS (SELECT 1 FROM transfer_count_proposals newer
                    WHERE (newer.request_id,newer.variant_id)=(p.request_id,p.variant_id) AND newer.revision>p.revision)
                AND NOT EXISTS (SELECT 1 FROM transfer_count_decisions d
                    WHERE (d.request_id,d.variant_id,d.revision)=(p.request_id,p.variant_id,p.revision)))
            OR EXISTS (SELECT 1 FROM transfer_restitution_proposals p WHERE p.request_id=h.id
                AND NOT EXISTS (SELECT 1 FROM transfer_restitution_proposals newer
                    WHERE (newer.request_id,newer.variant_id)=(p.request_id,p.variant_id) AND newer.revision>p.revision)
                AND NOT EXISTS (SELECT 1 FROM transfer_restitution_decisions d
                    WHERE (d.request_id,d.variant_id,d.revision)=(p.request_id,p.variant_id,p.revision)))
            OR EXISTS (SELECT 1 FROM transfer_dispatch_proposals p WHERE p.request_id=h.id
                AND NOT EXISTS (SELECT 1 FROM transfer_dispatch_proposals newer
                    WHERE (newer.request_id,newer.variant_id)=(p.request_id,p.variant_id) AND newer.revision>p.revision)
                AND NOT EXISTS (SELECT 1 FROM transfer_dispatch_decisions d
                    WHERE (d.request_id,d.variant_id,d.revision)=(p.request_id,p.variant_id,p.revision)))
        )))
    ) THEN RETURN 'operations'; END IF;
    RETURN NULL;
END;
$$;

-- Fence before location tuple/FK locks, never from inside a row trigger.
CREATE TRIGGER lock_location_retirement BEFORE UPDATE ON locations
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();
CREATE OR REPLACE FUNCTION guard_location_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE blocker text;
BEGIN
    IF TG_OP='INSERT' THEN
        IF NEW.deleted_at IS NULL THEN RETURN NEW; END IF;
    ELSIF TG_OP='UPDATE' THEN
        IF OLD.id<>1 AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
           AND (to_jsonb(NEW)-'deleted_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'deleted_at') THEN
            blocker:=branch_retirement_blocker(OLD.id);
            IF blocker IS NOT NULL THEN
                RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='branch_retirement_blocked',
                    MESSAGE='Branch retirement blocked: '||blocker;
            END IF;
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='locations_identity_immutable',
        MESSAGE='location identity is immutable';
END;
$$;

CREATE FUNCTION guard_account_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' AND OLD.deleted_at IS NOT NULL
       AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='account_retirement_immutable',
            MESSAGE='Account retirement is immutable';
    END IF;
    IF NEW.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM locations WHERE id=NEW.location_id AND deleted_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='active_location_required',
            MESSAGE='New work requires active locations';
    END IF;
    RETURN NEW;
END;
$$;
-- Admin service locks ordered accounts/sessions BEFORE this global fence.
-- No transfer path takes account row locks while holding the global fence.
CREATE TRIGGER lock_account_retirement BEFORE INSERT OR UPDATE ON auth_accounts
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();
CREATE TRIGGER guard_account_retirement BEFORE INSERT OR UPDATE ON auth_accounts
FOR EACH ROW EXECUTE FUNCTION guard_account_retirement();

-- Existing creation admission and operation-owned evidence writers stay intact.
-- Alphabetical BEFORE-row ordering puts this guard before apply_* side effects.
CREATE FUNCTION admit_active_transfer_participants() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id smallint; destination_id smallint;
BEGIN
    IF TG_TABLE_NAME='transfer_requests' THEN
        source_id:=NEW.origin_location_id;
        destination_id:=NEW.destination_location_id;
    ELSE
        SELECT origin_location_id,destination_location_id INTO source_id,destination_id
        FROM transfer_requests WHERE id=NEW.request_id;
    END IF;
    IF EXISTS (SELECT 1 FROM locations WHERE id IN (source_id,destination_id) AND deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='active_location_required',
            MESSAGE='New work requires active locations';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER lock_transfer_creation BEFORE INSERT ON transfer_requests
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();
CREATE TRIGGER admit_active_participants BEFORE INSERT ON transfer_requests
FOR EACH ROW EXECUTE FUNCTION admit_active_transfer_participants();
CREATE TRIGGER admit_active_participants BEFORE INSERT ON transfer_count_operations
FOR EACH ROW EXECUTE FUNCTION admit_active_transfer_participants();
CREATE TRIGGER admit_active_participants BEFORE INSERT ON transfer_restitution_operations
FOR EACH ROW EXECUTE FUNCTION admit_active_transfer_participants();
CREATE TRIGGER admit_active_participants BEFORE INSERT ON transfer_dispatch_operations
FOR EACH ROW EXECUTE FUNCTION admit_active_transfer_participants();
-- Stored entrypoint replay returns before INSERT and remains readable.

CREATE FUNCTION guard_retired_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM locations WHERE id=NEW.location_id AND deleted_at IS NOT NULL)
       OR (TG_OP='UPDATE' AND EXISTS (
           SELECT 1 FROM locations WHERE id=OLD.location_id AND deleted_at IS NOT NULL)) THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='active_location_required',
            MESSAGE='New work requires active locations';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER lock_inventory_insertion BEFORE INSERT ON inventory_balances
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();
CREATE TRIGGER guard_retired_inventory BEFORE INSERT OR UPDATE ON inventory_balances
FOR EACH ROW EXECUTE FUNCTION guard_retired_inventory();
