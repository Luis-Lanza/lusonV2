-- Dispatch is a whole-request transition. Keep allocation history; only active
-- allocations contribute to reservation coverage. No destination credit here.
ALTER TABLE transfer_requests ADD COLUMN dispatch_location_id smallint REFERENCES locations(id);
ALTER TABLE transfer_requests ADD COLUMN dispatched_at timestamptz;
ALTER TABLE transfer_request_allocations ADD COLUMN consumed_at timestamptz;
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_status_check;
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_status_check
    CHECK (status IN ('pending','approved','rejected','in_transit'));
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_decision_check;
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_decision_check CHECK (
    (status = 'pending' AND decision_location_id IS NULL AND decided_at IS NULL)
    OR (status IN ('approved','rejected','in_transit') AND decision_location_id IS NOT NULL
        AND decision_location_id = approver_location_id AND decided_at IS NOT NULL
        AND decided_at >= created_at)
);
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_dispatch_check CHECK (
    (status <> 'in_transit' AND dispatch_location_id IS NULL AND dispatched_at IS NULL)
    OR (status = 'in_transit' AND dispatch_location_id IS NOT NULL
        AND dispatch_location_id = origin_location_id AND dispatched_at IS NOT NULL
        AND dispatched_at >= decided_at)
);

CREATE OR REPLACE FUNCTION admit_transfer_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'pending' OR NEW.decision_location_id IS NOT NULL OR NEW.decided_at IS NOT NULL
       OR NEW.dispatch_location_id IS NOT NULL OR NEW.dispatched_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Requests must be created Pending';
    END IF;
    RETURN NEW;
END;
$$;

-- The existing statement lock runs before request row locks. This trigger locks
-- source balances in ascending order, then makes both balance and ownership
-- changes itself. Direct SQL gets the same atomic effects as the API.
CREATE OR REPLACE FUNCTION admit_transfer_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation record;
BEGIN
    IF OLD.status = 'pending' AND NEW.status IN ('approved','rejected') THEN
        IF (to_jsonb(NEW) - ARRAY['status','decision_location_id','decided_at'])
           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','decision_location_id','decided_at'])
           OR (NEW.decision_location_id IS NOT NULL AND NEW.decision_location_id <> OLD.approver_location_id)
           OR (NEW.decided_at IS NOT NULL AND NEW.decided_at <> statement_timestamp()) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Decision metadata must be server derived';
        END IF;
        NEW.decision_location_id := OLD.approver_location_id;
        NEW.decided_at := statement_timestamp();
        RETURN NEW;
    END IF;
    IF OLD.status <> 'approved' OR NEW.status <> 'in_transit'
       OR (to_jsonb(NEW) - ARRAY['status','dispatch_location_id','dispatched_at'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','dispatch_location_id','dispatched_at'])
       OR (NEW.dispatch_location_id IS NOT NULL AND NEW.dispatch_location_id <> OLD.origin_location_id)
       OR (NEW.dispatched_at IS NOT NULL AND NEW.dispatched_at <> statement_timestamp()) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only an immutable Approved dispatch is admitted';
    END IF;
    IF EXISTS (
        SELECT 1 FROM transfer_request_items i
        LEFT JOIN transfer_request_allocations a USING (request_id,variant_id)
        WHERE i.request_id = OLD.id AND (a.request_id IS NULL OR a.quantity <> i.quantity
            OR a.origin_location_id <> OLD.origin_location_id OR a.consumed_at IS NOT NULL)
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Dispatch requires every active owned allocation';
    END IF;
    PERFORM b.variant_id FROM inventory_balances b
    JOIN transfer_request_allocations a ON a.variant_id = b.variant_id
    WHERE a.request_id = OLD.id AND b.location_id = OLD.origin_location_id
    ORDER BY b.variant_id FOR UPDATE OF b;
    NEW.dispatch_location_id := OLD.origin_location_id;
    NEW.dispatched_at := statement_timestamp();
    FOR allocation IN SELECT * FROM transfer_request_allocations WHERE request_id = OLD.id ORDER BY variant_id LOOP
        UPDATE inventory_balances SET existing = existing - allocation.quantity,
            reserved = reserved - allocation.quantity
        WHERE location_id = OLD.origin_location_id AND variant_id = allocation.variant_id
            AND existing >= allocation.quantity AND reserved >= allocation.quantity;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Dispatch requires covered source stock';
        END IF;
    END LOOP;
    UPDATE transfer_request_allocations SET consumed_at = NEW.dispatched_at WHERE request_id = OLD.id;
    RETURN NEW;
END;
$$;

DROP TRIGGER protect_transfer_allocations ON transfer_request_allocations;
CREATE FUNCTION admit_transfer_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Consumption is private to the header transition, never a standalone SQL
    -- release. INSERTs still use the immutable item/source guard from 005.
    IF TG_OP <> 'UPDATE' OR pg_trigger_depth() <> 2 OR OLD.consumed_at IS NOT NULL
       OR NEW.consumed_at IS DISTINCT FROM statement_timestamp()
       OR (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only dispatch may consume immutable allocations';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER protect_transfer_allocations BEFORE UPDATE OR DELETE ON transfer_request_allocations
FOR EACH ROW EXECUTE FUNCTION admit_transfer_consumption();
CREATE TRIGGER lock_transfer_consumption BEFORE UPDATE OR DELETE ON transfer_request_allocations
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();

CREATE OR REPLACE FUNCTION check_transfer_owned_balance(source_id smallint, item_id integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE owned numeric; held bigint;
BEGIN
    SELECT COALESCE(sum(quantity),0) INTO owned FROM transfer_request_allocations
    WHERE origin_location_id = source_id AND variant_id = item_id AND consumed_at IS NULL;
    IF owned > 0 THEN
        SELECT reserved INTO held FROM inventory_balances WHERE location_id = source_id AND variant_id = item_id;
        IF NOT FOUND OR held::numeric < owned THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Source reserved balance must cover active owned allocations';
        END IF;
    END IF;
END;
$$;
CREATE OR REPLACE FUNCTION check_transfer_final_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_key bigint; outcome text; source_id smallint; item_id integer; dispatch_time timestamptz;
BEGIN
    IF TG_TABLE_NAME = 'transfer_requests' THEN request_key := NEW.id;
    ELSE request_key := NEW.request_id;
    END IF;
    SELECT status,origin_location_id,dispatched_at INTO outcome,source_id,dispatch_time
    FROM transfer_requests WHERE id = request_key;
    IF outcome IN ('approved','in_transit') THEN
        IF EXISTS (
            SELECT 1 FROM transfer_request_items i
            LEFT JOIN transfer_request_allocations a USING (request_id,variant_id)
            WHERE i.request_id = request_key AND (a.request_id IS NULL OR a.quantity <> i.quantity
                OR a.origin_location_id <> source_id OR a.consumed_at IS DISTINCT FROM dispatch_time)
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Lifecycle allocation ownership must match every item';
        END IF;
    ELSIF EXISTS (SELECT 1 FROM transfer_request_allocations WHERE request_id = request_key) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only approved lifecycle requests may own allocations';
    END IF;
    FOR item_id IN SELECT variant_id FROM transfer_request_allocations WHERE request_id = request_key LOOP
        PERFORM check_transfer_owned_balance(source_id,item_id);
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_transfer_final_consumption AFTER UPDATE ON transfer_request_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transfer_final_request();
