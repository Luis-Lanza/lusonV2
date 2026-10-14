-- A direct shipment is authorized and reserved at creation, not approved later.
-- Keep all branch flows, immutable payload guards and deferred owned coverage.
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_creator_location_id_check;
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_creator_location_id_check
    CHECK (creator_location_id IN (1,2,3));
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_kind_check;
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_kind_check
    CHECK (kind IN ('request_stock','send_to_warehouse','direct_shipment'));
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_check1;
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_check1 CHECK (
    (kind='request_stock' AND creator_location_id IN (2,3) AND origin_location_id IN (1,2,3)
     AND destination_location_id=creator_location_id AND approver_location_id=origin_location_id)
    OR (kind='send_to_warehouse' AND creator_location_id IN (2,3) AND origin_location_id=creator_location_id
        AND destination_location_id=1 AND approver_location_id=1)
    OR (kind='direct_shipment' AND creator_location_id=1 AND origin_location_id=1
        AND destination_location_id IN (2,3) AND approver_location_id=1)
);
ALTER TABLE transfer_requests ADD CONSTRAINT transfer_requests_direct_authorization_check CHECK (
    kind<>'direct_shipment' OR (
        status IN ('approved','in_transit','received','cancelled')
        AND decision_location_id IS NOT NULL AND decision_location_id=1
        AND decided_at IS NOT NULL AND decided_at=created_at
    )
);

CREATE OR REPLACE FUNCTION admit_transfer_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.dispatch_location_id IS NOT NULL OR NEW.dispatched_at IS NOT NULL
       OR NEW.receipt_location_id IS NOT NULL OR NEW.received_at IS NOT NULL
       OR NEW.cancellation_location_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Creation cannot include later lifecycle history';
    END IF;
    IF NEW.kind='direct_shipment' THEN
        -- The caller must request the authorized initial state explicitly.
        -- Never silently repair forged participants, history or timestamps.
        IF NEW.status<>'approved' OR NEW.creator_location_id<>1 OR NEW.origin_location_id<>1
           OR NEW.approver_location_id<>1 OR NEW.destination_location_id NOT IN (2,3)
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
-- No lifecycle trigger is replaced: immutable approved history already permits
-- only source dispatch or creator cancellation, with exact consume/release.
-- Existing final-header/item/allocation/balance triggers require complete active
-- ownership at commit, and existing transactional revision triggers emit both
-- participant transfer hints and inventory hints only after a successful commit.
