-- Cancellation is creator-owned history, not a decision or stock consumption.
ALTER TABLE transfer_requests ADD COLUMN cancellation_location_id smallint REFERENCES locations(id);
ALTER TABLE transfer_requests ADD COLUMN cancelled_at timestamptz;
ALTER TABLE transfer_request_allocations ADD COLUMN released_at timestamptz;
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_status_check;
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_status_check
    CHECK (status IN ('pending','approved','rejected','in_transit','received','cancelled'));
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_decision_check;
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_decision_check CHECK (
    (status IN ('pending','cancelled') AND decision_location_id IS NULL AND decided_at IS NULL)
    OR (status IN ('approved','rejected','in_transit','received','cancelled')
        AND decision_location_id IS NOT NULL AND decision_location_id=approver_location_id
        AND decided_at IS NOT NULL AND decided_at>=created_at)
);
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_cancellation_check CHECK (
    (status<>'cancelled' AND cancellation_location_id IS NULL AND cancelled_at IS NULL)
    OR (status='cancelled' AND cancellation_location_id IS NOT NULL
        AND cancellation_location_id=creator_location_id AND cancelled_at IS NOT NULL
        AND cancelled_at>=created_at AND (decided_at IS NULL OR cancelled_at>=decided_at))
);
ALTER TABLE transfer_request_allocations ADD CONSTRAINT transfer_allocations_final_marker_check
    CHECK (consumed_at IS NULL OR released_at IS NULL);

CREATE OR REPLACE FUNCTION admit_transfer_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status<>'pending' OR NEW.decision_location_id IS NOT NULL OR NEW.decided_at IS NOT NULL
       OR NEW.dispatch_location_id IS NOT NULL OR NEW.dispatched_at IS NOT NULL
       OR NEW.receipt_location_id IS NOT NULL OR NEW.received_at IS NOT NULL
       OR NEW.cancellation_location_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Requests must be created Pending';
    END IF;
    RETURN NEW;
END;
$$;

-- Preserve all existing approval/dispatch/receipt effects. The header owns the
-- new release too: even direct SQL cannot commit a header-only cancellation.
CREATE OR REPLACE FUNCTION admit_transfer_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation record; receipt_line record;
BEGIN
    IF OLD.status IN ('pending','approved') AND NEW.status='cancelled' THEN
        IF (to_jsonb(NEW)-ARRAY['status','cancellation_location_id','cancelled_at'])
           IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','cancellation_location_id','cancelled_at'])
           OR (NEW.cancellation_location_id IS NOT NULL AND NEW.cancellation_location_id<>OLD.creator_location_id)
           OR (NEW.cancelled_at IS NOT NULL AND NEW.cancelled_at<>statement_timestamp()) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Cancellation metadata must be server derived';
        END IF;
        NEW.cancellation_location_id:=OLD.creator_location_id;
        NEW.cancelled_at:=statement_timestamp();
        IF OLD.status='approved' THEN
            IF EXISTS (
                SELECT 1 FROM transfer_request_items i LEFT JOIN transfer_request_allocations a USING(request_id,variant_id)
                WHERE i.request_id=OLD.id AND (a.request_id IS NULL OR a.quantity<>i.quantity
                    OR a.origin_location_id<>OLD.origin_location_id OR a.consumed_at IS NOT NULL OR a.released_at IS NOT NULL)
            ) THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Cancellation requires every active owned allocation';
            END IF;
            PERFORM b.variant_id FROM inventory_balances b JOIN transfer_request_allocations a ON a.variant_id=b.variant_id
            WHERE a.request_id=OLD.id AND b.location_id=OLD.origin_location_id ORDER BY b.variant_id FOR UPDATE OF b;
            FOR allocation IN SELECT * FROM transfer_request_allocations WHERE request_id=OLD.id ORDER BY variant_id LOOP
                UPDATE inventory_balances SET reserved=reserved-allocation.quantity
                WHERE location_id=OLD.origin_location_id AND variant_id=allocation.variant_id AND reserved>=allocation.quantity;
                IF NOT FOUND THEN
                    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Cancellation requires covered source reservations';
                END IF;
            END LOOP;
            UPDATE transfer_request_allocations SET released_at=NEW.cancelled_at WHERE request_id=OLD.id;
        END IF;
        RETURN NEW;
    END IF;
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
            OR a.origin_location_id<>OLD.origin_location_id OR a.consumed_at IS NOT NULL OR a.released_at IS NOT NULL)
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

CREATE OR REPLACE FUNCTION admit_transfer_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id smallint; item_quantity bigint;
BEGIN
    SELECT r.origin_location_id,i.quantity INTO source_id,item_quantity
    FROM transfer_requests r JOIN transfer_request_items i ON i.request_id=r.id
    WHERE r.id=NEW.request_id AND i.variant_id=NEW.variant_id;
    IF NOT FOUND OR NEW.quantity IS DISTINCT FROM item_quantity
       OR (NEW.origin_location_id IS NOT NULL AND NEW.origin_location_id<>source_id)
       OR NEW.consumed_at IS NOT NULL OR NEW.released_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Allocation must match its immutable item and source and start active';
    END IF;
    NEW.origin_location_id:=source_id;
    RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION admit_transfer_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP<>'UPDATE' OR pg_trigger_depth()<>2 OR OLD.consumed_at IS NOT NULL OR OLD.released_at IS NOT NULL
       OR (to_jsonb(NEW)-ARRAY['consumed_at','released_at'])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumed_at','released_at'])
       OR NOT ((NEW.consumed_at IS NOT DISTINCT FROM statement_timestamp() AND NEW.released_at IS NULL)
           OR (NEW.released_at IS NOT DISTINCT FROM statement_timestamp() AND NEW.consumed_at IS NULL)) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Only a header transition may consume or release immutable allocations';
    END IF;
    RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION check_transfer_owned_balance(source_id smallint, item_id integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE owned numeric; held bigint;
BEGIN
    SELECT COALESCE(sum(quantity),0) INTO owned FROM transfer_request_allocations
    WHERE origin_location_id=source_id AND variant_id=item_id AND consumed_at IS NULL AND released_at IS NULL;
    IF owned>0 THEN
        SELECT reserved INTO held FROM inventory_balances WHERE location_id=source_id AND variant_id=item_id;
        IF NOT FOUND OR held::numeric<owned THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source reserved balance must cover active owned allocations';
        END IF;
    END IF;
END;
$$;
CREATE OR REPLACE FUNCTION check_transfer_final_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_key bigint; outcome text; source_id smallint; item_id integer;
        dispatch_time timestamptz; release_time timestamptz; decision_time timestamptz;
BEGIN
    IF TG_TABLE_NAME='transfer_requests' THEN request_key:=NEW.id; ELSE request_key:=NEW.request_id; END IF;
    SELECT status,origin_location_id,dispatched_at,cancelled_at,decided_at
    INTO outcome,source_id,dispatch_time,release_time,decision_time FROM transfer_requests WHERE id=request_key;
    IF outcome IN ('approved','in_transit','received') OR (outcome='cancelled' AND decision_time IS NOT NULL) THEN
        IF EXISTS (
            SELECT 1 FROM transfer_request_items i LEFT JOIN transfer_request_allocations a USING(request_id,variant_id)
            WHERE i.request_id=request_key AND (a.request_id IS NULL OR a.quantity<>i.quantity
                OR a.origin_location_id<>source_id OR a.consumed_at IS DISTINCT FROM dispatch_time
                OR a.released_at IS DISTINCT FROM CASE WHEN outcome='cancelled' THEN release_time ELSE NULL END)
        ) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Lifecycle allocation history must match every item';
        END IF;
    ELSIF EXISTS (SELECT 1 FROM transfer_request_allocations WHERE request_id=request_key) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Requests without approval cannot own allocation history';
    END IF;
    FOR item_id IN SELECT variant_id FROM transfer_request_allocations WHERE request_id=request_key LOOP
        PERFORM check_transfer_owned_balance(source_id,item_id);
    END LOOP;
    RETURN NULL;
END;
$$;
