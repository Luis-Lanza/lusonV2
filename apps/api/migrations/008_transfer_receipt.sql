-- A receipt is one immutable destination finalization. Exception units are
-- recorded, not inventory: only expected min(actual,sent) is credited.
ALTER TABLE transfer_requests ADD COLUMN receipt_location_id smallint REFERENCES locations(id);
ALTER TABLE transfer_requests ADD COLUMN received_at timestamptz;
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_status_check;
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_status_check
    CHECK (status IN ('pending','approved','rejected','in_transit','received'));
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_decision_check;
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_decision_check CHECK (
    (status = 'pending' AND decision_location_id IS NULL AND decided_at IS NULL)
    OR (status IN ('approved','rejected','in_transit','received') AND decision_location_id IS NOT NULL
        AND decision_location_id = approver_location_id AND decided_at IS NOT NULL AND decided_at >= created_at)
);
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_dispatch_check;
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_dispatch_check CHECK (
    (status NOT IN ('in_transit','received') AND dispatch_location_id IS NULL AND dispatched_at IS NULL)
    OR (status IN ('in_transit','received') AND dispatch_location_id IS NOT NULL
        AND dispatch_location_id = origin_location_id AND dispatched_at IS NOT NULL AND dispatched_at >= decided_at)
);
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_receipt_check CHECK (
    (status <> 'received' AND receipt_location_id IS NULL AND received_at IS NULL)
    OR (status = 'received' AND receipt_location_id IS NOT NULL
        AND receipt_location_id = destination_location_id AND received_at IS NOT NULL AND received_at >= dispatched_at)
);

CREATE TABLE transfer_receipt_lines (
    request_id bigint NOT NULL REFERENCES transfer_requests(id),
    variant_id integer NOT NULL REFERENCES catalog_variants(id),
    expected_quantity bigint NOT NULL CHECK (expected_quantity >= 0),
    actual_quantity bigint NOT NULL CHECK (actual_quantity >= 0),
    available_quantity bigint NOT NULL CHECK (available_quantity = LEAST(expected_quantity,actual_quantity)),
    creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
    PRIMARY KEY (request_id,variant_id),
    CHECK (expected_quantity > 0 OR actual_quantity > 0)
);
CREATE TABLE transfer_receipt_exceptions (
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    kind text NOT NULL CHECK (kind IN ('shortage','excess','unexpected')),
    quantity bigint NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (request_id,variant_id,kind),
    FOREIGN KEY (request_id,variant_id) REFERENCES transfer_receipt_lines(request_id,variant_id)
);
CREATE TRIGGER lock_transfer_receipt_lines BEFORE INSERT ON transfer_receipt_lines
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();
CREATE FUNCTION admit_transfer_receipt_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE outcome text; sent bigint;
BEGIN
    SELECT status INTO outcome FROM transfer_requests WHERE id=NEW.request_id FOR UPDATE;
    SELECT quantity INTO sent FROM transfer_request_items WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id;
    IF outcome IS DISTINCT FROM 'in_transit' OR NEW.expected_quantity IS DISTINCT FROM COALESCE(sent,0)
       OR NEW.creation_xid IS DISTINCT FROM pg_current_xact_id() THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Receipt lines require the immutable in-transit payload';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_transfer_receipt_line BEFORE INSERT ON transfer_receipt_lines
FOR EACH ROW EXECUTE FUNCTION admit_transfer_receipt_line();
CREATE FUNCTION admit_transfer_receipt_exception() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() <> 2 THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Only finalization may record exceptions';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_transfer_receipt_exception BEFORE INSERT ON transfer_receipt_exceptions
FOR EACH ROW EXECUTE FUNCTION admit_transfer_receipt_exception();
CREATE TRIGGER protect_transfer_receipt_lines BEFORE UPDATE OR DELETE ON transfer_receipt_lines
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_transfer_receipt_lines_truncate BEFORE TRUNCATE ON transfer_receipt_lines
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_transfer_receipt_exceptions BEFORE UPDATE OR DELETE ON transfer_receipt_exceptions
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_transfer_receipt_exceptions_truncate BEFORE TRUNCATE ON transfer_receipt_exceptions
EXECUTE FUNCTION protect_pending_request();

-- Called before ANY credit and again at deferred commit. No aggregate bigint
-- sum: existence of a positive actual permits even cross-variant totals > int64.
CREATE FUNCTION check_transfer_receipt_payload(request_key bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM transfer_receipt_lines WHERE request_id=request_key AND actual_quantity>0)
       OR EXISTS (
        SELECT 1 FROM transfer_request_items i LEFT JOIN transfer_receipt_lines l USING(request_id,variant_id)
        WHERE i.request_id=request_key AND (l.request_id IS NULL OR l.expected_quantity<>i.quantity)
       ) OR EXISTS (
        SELECT 1 FROM transfer_receipt_lines l LEFT JOIN transfer_request_items i USING(request_id,variant_id)
        WHERE l.request_id=request_key AND (l.expected_quantity<>COALESCE(i.quantity,0)
            OR l.available_quantity<>LEAST(l.actual_quantity,l.expected_quantity)
            OR (i.request_id IS NULL AND l.actual_quantity=0))
       ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Receipt requires every expected line and positive actual units';
    END IF;
END;
$$;
CREATE FUNCTION check_transfer_final_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_key bigint; outcome text;
BEGIN
    IF TG_TABLE_NAME='transfer_requests' THEN request_key:=NEW.id; ELSE request_key:=NEW.request_id; END IF;
    SELECT status INTO outcome FROM transfer_requests WHERE id=request_key;
    IF outcome='received' THEN
        PERFORM check_transfer_receipt_payload(request_key);
        IF EXISTS (
            (SELECT variant_id,kind,quantity FROM transfer_receipt_exceptions WHERE request_id=request_key
             EXCEPT SELECT variant_id,CASE WHEN expected_quantity=0 THEN 'unexpected'
                WHEN actual_quantity<expected_quantity THEN 'shortage' ELSE 'excess' END,
                CASE WHEN expected_quantity=0 THEN actual_quantity ELSE abs(actual_quantity-expected_quantity) END
             FROM transfer_receipt_lines WHERE request_id=request_key AND actual_quantity<>expected_quantity)
            UNION ALL
            (SELECT variant_id,CASE WHEN expected_quantity=0 THEN 'unexpected'
                WHEN actual_quantity<expected_quantity THEN 'shortage' ELSE 'excess' END,
                CASE WHEN expected_quantity=0 THEN actual_quantity ELSE abs(actual_quantity-expected_quantity) END
             FROM transfer_receipt_lines WHERE request_id=request_key AND actual_quantity<>expected_quantity
             EXCEPT SELECT variant_id,kind,quantity FROM transfer_receipt_exceptions WHERE request_id=request_key)
        ) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Receipt exception arithmetic must be exact';
        END IF;
    ELSIF EXISTS (SELECT 1 FROM transfer_receipt_lines WHERE request_id=request_key) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Receipt lines cannot persist without finalization';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_transfer_receipt_header AFTER INSERT OR UPDATE ON transfer_requests
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transfer_final_receipt();
CREATE CONSTRAINT TRIGGER check_transfer_receipt_lines AFTER INSERT ON transfer_receipt_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transfer_final_receipt();
CREATE CONSTRAINT TRIGGER check_transfer_receipt_exceptions AFTER INSERT ON transfer_receipt_exceptions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transfer_final_receipt();

CREATE OR REPLACE FUNCTION admit_transfer_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'pending' OR NEW.decision_location_id IS NOT NULL OR NEW.decided_at IS NOT NULL
       OR NEW.dispatch_location_id IS NOT NULL OR NEW.dispatched_at IS NOT NULL
       OR NEW.receipt_location_id IS NOT NULL OR NEW.received_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Requests must be created Pending';
    END IF;
    RETURN NEW;
END;
$$;

-- Extend the existing header-owned SQL effects, rather than trusting API stock
-- writes. Statement advisory locking is unchanged; balances lock sorted first.
CREATE OR REPLACE FUNCTION admit_transfer_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation record; receipt_line record;
BEGIN
    IF OLD.status='pending' AND NEW.status IN ('approved','rejected') THEN
        IF (to_jsonb(NEW)-ARRAY['status','decision_location_id','decided_at'])
           IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','decision_location_id','decided_at'])
           OR (NEW.decision_location_id IS NOT NULL AND NEW.decision_location_id<>OLD.approver_location_id)
           OR (NEW.decided_at IS NOT NULL AND NEW.decided_at<>statement_timestamp()) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Decision metadata must be server derived';
        END IF;
        NEW.decision_location_id:=OLD.approver_location_id;
        NEW.decided_at:=statement_timestamp();
        RETURN NEW;
    END IF;
    IF OLD.status='in_transit' AND NEW.status='received' THEN
        IF (to_jsonb(NEW)-ARRAY['status','receipt_location_id','received_at'])
           IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','receipt_location_id','received_at'])
           OR (NEW.receipt_location_id IS NOT NULL AND NEW.receipt_location_id<>OLD.destination_location_id)
           OR (NEW.received_at IS NOT NULL AND NEW.received_at<>statement_timestamp()) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Receipt metadata must be server derived';
        END IF;
        PERFORM check_transfer_receipt_payload(OLD.id);
        PERFORM b.variant_id FROM inventory_balances b JOIN transfer_receipt_lines l ON l.variant_id=b.variant_id
        WHERE l.request_id=OLD.id AND l.expected_quantity>0 AND b.location_id=OLD.destination_location_id
        ORDER BY b.variant_id FOR UPDATE OF b;
        IF EXISTS (
            SELECT 1 FROM transfer_receipt_lines l LEFT JOIN inventory_balances b
            ON b.variant_id=l.variant_id AND b.location_id=OLD.destination_location_id
            WHERE l.request_id=OLD.id AND l.expected_quantity>0
            AND (b.variant_id IS NULL OR b.existing>9223372036854775807-l.available_quantity)
        ) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Receipt destination balance would overflow';
        END IF;
        NEW.receipt_location_id:=OLD.destination_location_id;
        NEW.received_at:=statement_timestamp();
        FOR receipt_line IN SELECT * FROM transfer_receipt_lines WHERE request_id=OLD.id ORDER BY variant_id LOOP
            -- Never fabricate inventory changes for shortages/unexpected-only.
            IF receipt_line.available_quantity>0 THEN
                UPDATE inventory_balances SET existing=existing+receipt_line.available_quantity
                WHERE location_id=OLD.destination_location_id AND variant_id=receipt_line.variant_id;
            END IF;
            IF receipt_line.actual_quantity<>receipt_line.expected_quantity THEN
                INSERT INTO transfer_receipt_exceptions(request_id,variant_id,kind,quantity)
                VALUES(OLD.id,receipt_line.variant_id,
                    CASE WHEN receipt_line.expected_quantity=0 THEN 'unexpected'
                    WHEN receipt_line.actual_quantity<receipt_line.expected_quantity THEN 'shortage' ELSE 'excess' END,
                    CASE WHEN receipt_line.expected_quantity=0 THEN receipt_line.actual_quantity
                    ELSE abs(receipt_line.actual_quantity-receipt_line.expected_quantity) END);
            END IF;
        END LOOP;
        RETURN NEW;
    END IF;
    IF OLD.status<>'approved' OR NEW.status<>'in_transit'
       OR (to_jsonb(NEW)-ARRAY['status','dispatch_location_id','dispatched_at'])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','dispatch_location_id','dispatched_at'])
       OR (NEW.dispatch_location_id IS NOT NULL AND NEW.dispatch_location_id<>OLD.origin_location_id)
       OR (NEW.dispatched_at IS NOT NULL AND NEW.dispatched_at<>statement_timestamp()) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Only immutable lifecycle transitions are admitted';
    END IF;
    IF EXISTS (
        SELECT 1 FROM transfer_request_items i LEFT JOIN transfer_request_allocations a USING(request_id,variant_id)
        WHERE i.request_id=OLD.id AND (a.request_id IS NULL OR a.quantity<>i.quantity
            OR a.origin_location_id<>OLD.origin_location_id OR a.consumed_at IS NOT NULL)
    ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Dispatch requires every active owned allocation';
    END IF;
    PERFORM b.variant_id FROM inventory_balances b JOIN transfer_request_allocations a ON a.variant_id=b.variant_id
    WHERE a.request_id=OLD.id AND b.location_id=OLD.origin_location_id ORDER BY b.variant_id FOR UPDATE OF b;
    NEW.dispatch_location_id:=OLD.origin_location_id;
    NEW.dispatched_at:=statement_timestamp();
    FOR allocation IN SELECT * FROM transfer_request_allocations WHERE request_id=OLD.id ORDER BY variant_id LOOP
        UPDATE inventory_balances SET existing=existing-allocation.quantity,reserved=reserved-allocation.quantity
        WHERE location_id=OLD.origin_location_id AND variant_id=allocation.variant_id
            AND existing>=allocation.quantity AND reserved>=allocation.quantity;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Dispatch requires covered source stock';
        END IF;
    END LOOP;
    UPDATE transfer_request_allocations SET consumed_at=NEW.dispatched_at WHERE request_id=OLD.id;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION check_transfer_final_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_key bigint; outcome text; source_id smallint; item_id integer; dispatch_time timestamptz;
BEGIN
    IF TG_TABLE_NAME='transfer_requests' THEN request_key:=NEW.id; ELSE request_key:=NEW.request_id; END IF;
    SELECT status,origin_location_id,dispatched_at INTO outcome,source_id,dispatch_time
    FROM transfer_requests WHERE id=request_key;
    IF outcome IN ('approved','in_transit','received') THEN
        IF EXISTS (
            SELECT 1 FROM transfer_request_items i LEFT JOIN transfer_request_allocations a USING(request_id,variant_id)
            WHERE i.request_id=request_key AND (a.request_id IS NULL OR a.quantity<>i.quantity
                OR a.origin_location_id<>source_id OR a.consumed_at IS DISTINCT FROM dispatch_time)
        ) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Lifecycle allocation ownership must match every item';
        END IF;
    ELSIF EXISTS (SELECT 1 FROM transfer_request_allocations WHERE request_id=request_key) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Only approved lifecycle requests may own allocations';
    END IF;
    FOR item_id IN SELECT variant_id FROM transfer_request_allocations WHERE request_id=request_key LOOP
        PERFORM check_transfer_owned_balance(source_id,item_id);
    END LOOP;
    RETURN NULL;
END;
$$;
