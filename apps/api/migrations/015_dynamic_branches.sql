-- Usernames remain stable login identities; lifecycle edits do not rename them.
CREATE OR REPLACE FUNCTION guard_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.id = 1 THEN RAISE EXCEPTION 'warehouse administrator is protected'; END IF;
        RETURN OLD;
    END IF;
    IF NEW.id <> OLD.id THEN RAISE EXCEPTION 'account identity is immutable'; END IF;
    IF NEW.username IS DISTINCT FROM OLD.username THEN
        RAISE EXCEPTION 'account username is immutable';
    END IF;
    RETURN NEW;
END;
$$;

-- Participants remain existing locations, never personal account identities.
-- The existing participant foreign keys and distinct-direction check remain.
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_creator_location_id_check;
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_creator_location_id_check
    CHECK (creator_location_id > 0);
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_check1;
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_check1 CHECK (
    (kind='request_stock' AND creator_location_id>1 AND origin_location_id>0
     AND destination_location_id=creator_location_id AND approver_location_id=origin_location_id)
    OR (kind='send_to_warehouse' AND creator_location_id>1 AND origin_location_id=creator_location_id
        AND destination_location_id=1 AND approver_location_id=1)
    OR (kind='direct_shipment' AND creator_location_id=1 AND origin_location_id=1
        AND destination_location_id>1 AND approver_location_id=1)
);

-- Preserve all creation-history, transaction and authorization checks from 010.
CREATE OR REPLACE FUNCTION admit_transfer_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.dispatch_location_id IS NOT NULL OR NEW.dispatched_at IS NOT NULL
       OR NEW.receipt_location_id IS NOT NULL OR NEW.received_at IS NOT NULL
       OR NEW.cancellation_location_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Creation cannot include later lifecycle history';
    END IF;
    IF NEW.kind='direct_shipment' THEN
        IF NEW.status<>'approved' OR NEW.creator_location_id<>1 OR NEW.origin_location_id<>1
           OR NEW.approver_location_id<>1 OR NEW.destination_location_id<=1
           OR NEW.created_at IS DISTINCT FROM transaction_timestamp()
           OR NEW.creation_xid IS DISTINCT FROM pg_current_xact_id()
           OR (NEW.decision_location_id IS NOT NULL AND NEW.decision_location_id<>1)
           OR (NEW.decided_at IS NOT NULL AND NEW.decided_at IS DISTINCT FROM NEW.created_at) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Direct authorization must be derived at warehouse creation';
        END IF;
        NEW.decision_location_id:=1;
        NEW.decided_at:=NEW.created_at;
    ELSIF NEW.status<>'pending' OR NEW.decision_location_id IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Branch requests must be created Pending';
    END IF;
    RETURN NEW;
END;
$$;

ALTER TABLE realtime_revisions DROP CONSTRAINT realtime_revisions_scope_check;
ALTER TABLE realtime_revisions ADD CONSTRAINT realtime_revisions_scope_check
    CHECK (scope='inventory' OR scope ~ '^transfers:[1-9][0-9]{0,4}$');
-- Initial migration rows predate location seeding. Validate subsequent inserts
-- against actual locations while retaining the original monotonic DML guards.
CREATE FUNCTION admit_realtime_audience() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.scope='inventory' OR NOT EXISTS (
        SELECT 1 FROM locations WHERE 'transfers:' || id = NEW.scope
    ) THEN
        RAISE EXCEPTION 'Realtime audience must identify an existing location';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_realtime_audience BEFORE INSERT ON realtime_revisions
FOR EACH ROW EXECUTE FUNCTION admit_realtime_audience();
INSERT INTO realtime_revisions(scope)
SELECT 'transfers:' || id FROM locations
WHERE NOT EXISTS (SELECT 1 FROM realtime_revisions WHERE scope='transfers:' || locations.id);

-- Reuse T2's single branch initialization hook; stock and audience are atomic.
CREATE OR REPLACE FUNCTION initialize_branch_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO realtime_revisions(scope) VALUES ('transfers:' || NEW.id)
    ON CONFLICT (scope) DO NOTHING;
    IF EXISTS (SELECT 1 FROM initialization_metadata) THEN
        INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
        SELECT NEW.id,v.id,0,0 FROM catalog_variants v ORDER BY v.id;
    END IF;
    RETURN NEW;
END;
$$;
