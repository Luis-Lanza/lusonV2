-- One immutable outcome is the admitted lifecycle history. Original creation
-- identity, fingerprint, participants, timestamp, xid and items remain sealed.
ALTER TABLE transfer_requests ADD COLUMN decision_location_id smallint REFERENCES locations(id);
ALTER TABLE transfer_requests ADD COLUMN decided_at timestamptz;
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_status_check;
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_status_check
    CHECK (status IN ('pending', 'approved', 'rejected'));
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_decision_check CHECK (
    (status = 'pending' AND decision_location_id IS NULL AND decided_at IS NULL)
    OR (status IN ('approved', 'rejected') AND decision_location_id IS NOT NULL
        AND decision_location_id = approver_location_id AND decided_at IS NOT NULL
        AND decided_at >= created_at)
);

CREATE TABLE transfer_request_allocations (
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    origin_location_id smallint NOT NULL REFERENCES locations(id),
    quantity bigint NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (request_id, variant_id),
    FOREIGN KEY (request_id, variant_id) REFERENCES transfer_request_items(request_id, variant_id)
);
CREATE INDEX transfer_request_allocations_source
    ON transfer_request_allocations(origin_location_id, variant_id);

-- Serialize all reservation-integrity writers BEFORE they acquire row locks.
-- A fresh READ COMMITTED snapshot after waiting is essential: accepting a stale
-- repeatable-read snapshot could allow two individually valid writes to commit
-- an invalid aggregate. Readers are not restricted. Future approval code must
-- acquire this same lock before explicitly locking requests or balances.
CREATE FUNCTION lock_transfer_reservation_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION USING ERRCODE = '25000', MESSAGE = 'Reservation writes require READ COMMITTED';
    END IF;
    PERFORM pg_advisory_xact_lock(714025, 1);
    RETURN NULL;
END;
$$;
CREATE TRIGGER lock_transfer_decisions BEFORE UPDATE ON transfer_requests
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();
CREATE TRIGGER lock_transfer_allocations BEFORE INSERT ON transfer_request_allocations
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();
CREATE TRIGGER lock_transfer_balances BEFORE UPDATE OR DELETE ON inventory_balances
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();

CREATE FUNCTION admit_transfer_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Retain the old direct malformed Approved INSERT SQLSTATE contract.
    IF NEW.status <> 'pending' OR NEW.decision_location_id IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Requests must be created Pending';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_transfer_creation BEFORE INSERT ON transfer_requests
FOR EACH ROW EXECUTE FUNCTION admit_transfer_creation();

DROP TRIGGER protect_transfer_requests ON transfer_requests;
CREATE FUNCTION admit_transfer_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected')
       OR (to_jsonb(NEW) - ARRAY['status','decision_location_id','decided_at'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','decision_location_id','decided_at']) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only an immutable Pending decision is admitted';
    END IF;
    -- Metadata is derived from the persisted flow and this server statement.
    -- This is consistency, not authentication of the SQL caller; API location
    -- authorization is a separate prerequisite for a public decision endpoint.
    IF (NEW.decision_location_id IS NOT NULL AND NEW.decision_location_id <> OLD.approver_location_id)
       OR (NEW.decided_at IS NOT NULL AND NEW.decided_at <> statement_timestamp()) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Decision metadata must be server derived';
    END IF;
    NEW.decision_location_id := OLD.approver_location_id;
    NEW.decided_at := statement_timestamp();
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_transfer_decision BEFORE UPDATE ON transfer_requests
FOR EACH ROW EXECUTE FUNCTION admit_transfer_decision();
CREATE TRIGGER protect_transfer_requests_delete BEFORE DELETE ON transfer_requests
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
-- Existing request/item DELETE, UPDATE and TRUNCATE protections remain in force.
CREATE TRIGGER protect_transfer_allocations BEFORE UPDATE OR DELETE ON transfer_request_allocations
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_transfer_allocations_truncate BEFORE TRUNCATE ON transfer_request_allocations
EXECUTE FUNCTION protect_pending_request();
-- TRUNCATE has no row events; prohibit it rather than losing allocated balances
-- through a bypass of the deferred DELETE guard (including TRUNCATE CASCADE).
CREATE TRIGGER protect_transfer_balances_truncate BEFORE TRUNCATE ON inventory_balances
EXECUTE FUNCTION protect_pending_request();

CREATE FUNCTION admit_transfer_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id smallint; item_quantity bigint;
BEGIN
    SELECT r.origin_location_id, i.quantity INTO source_id, item_quantity
    FROM transfer_requests r JOIN transfer_request_items i ON i.request_id = r.id
    WHERE r.id = NEW.request_id AND i.variant_id = NEW.variant_id;
    IF NOT FOUND OR NEW.quantity IS DISTINCT FROM item_quantity
       OR (NEW.origin_location_id IS NOT NULL AND NEW.origin_location_id <> source_id) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Allocation must match its immutable item and source';
    END IF;
    NEW.origin_location_id := source_id;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_transfer_allocation BEFORE INSERT ON transfer_request_allocations
FOR EACH ROW EXECUTE FUNCTION admit_transfer_allocation();

-- SUM(bigint) is numeric. Never narrow it to bigint: multiple valid int64 items
-- can exceed int64 in aggregate, and must fail the coverage check cleanly.
CREATE FUNCTION check_transfer_owned_balance(source_id smallint, item_id integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE owned numeric; held bigint;
BEGIN
    SELECT COALESCE(sum(quantity), 0) INTO owned FROM transfer_request_allocations
    WHERE origin_location_id = source_id AND variant_id = item_id;
    IF owned > 0 THEN
        SELECT reserved INTO held FROM inventory_balances
        WHERE location_id = source_id AND variant_id = item_id;
        IF NOT FOUND OR held::numeric < owned THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Source reserved balance must cover owned allocations';
        END IF;
    END IF;
END;
$$;

CREATE FUNCTION check_transfer_final_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_key bigint; outcome text; source_id smallint; item_id integer;
BEGIN
    IF TG_TABLE_NAME = 'transfer_requests' THEN
        request_key := NEW.id;
    ELSE
        request_key := NEW.request_id;
    END IF;
    -- Query current final rows, not the historical NEW image of a queued event.
    SELECT status, origin_location_id INTO outcome, source_id FROM transfer_requests WHERE id = request_key;
    IF outcome = 'approved' THEN
        IF EXISTS (
            SELECT 1 FROM transfer_request_items i
            LEFT JOIN transfer_request_allocations a USING (request_id, variant_id)
            WHERE i.request_id = request_key
              AND (a.request_id IS NULL OR a.quantity <> i.quantity OR a.origin_location_id <> source_id)
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Approved requests must own every item exactly once';
        END IF;
    ELSIF EXISTS (SELECT 1 FROM transfer_request_allocations WHERE request_id = request_key) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only Approved requests may own allocations';
    END IF;
    FOR item_id IN SELECT variant_id FROM transfer_request_allocations WHERE request_id = request_key LOOP
        PERFORM check_transfer_owned_balance(source_id, item_id);
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_transfer_final_header AFTER INSERT OR UPDATE ON transfer_requests
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transfer_final_request();
CREATE CONSTRAINT TRIGGER check_transfer_final_allocation AFTER INSERT ON transfer_request_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transfer_final_request();
CREATE CONSTRAINT TRIGGER check_transfer_final_item AFTER INSERT ON transfer_request_items
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transfer_final_request();

CREATE FUNCTION check_transfer_final_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Both old and new keys matter when a balance is relocated. DELETE must
    -- query the final table too, so delete-and-reinsert may restore coverage.
    PERFORM check_transfer_owned_balance(OLD.location_id, OLD.variant_id);
    IF TG_OP = 'UPDATE' AND (NEW.location_id, NEW.variant_id) IS DISTINCT FROM (OLD.location_id, OLD.variant_id) THEN
        PERFORM check_transfer_owned_balance(NEW.location_id, NEW.variant_id);
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_transfer_final_balance AFTER UPDATE OR DELETE ON inventory_balances
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transfer_final_balance();
