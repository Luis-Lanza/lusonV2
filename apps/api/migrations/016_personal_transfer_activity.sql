-- Additive personal evidence; existing physical ledgers and retry identities
-- remain authoritative. There is deliberately no historical backfill.
CREATE TABLE transfer_personal_activity (
    request_id bigint NOT NULL REFERENCES transfer_requests(id),
    category text NOT NULL CHECK (category IN ('transfer','count','restitution','reconciliation')),
    operation_identity text NOT NULL,
    ordinal bigint NOT NULL CHECK (ordinal > 0),
    action text NOT NULL CHECK (action IN ('create','approve','reject','dispatch','receive','cancel','propose','accept')),
    account_id bigint NOT NULL CHECK (account_id > 0),
    username text NOT NULL CHECK (username <> ''),
    display_name text NOT NULL,
    location_id smallint NOT NULL REFERENCES locations(id),
    location_name text NOT NULL,
    recorded_at timestamptz NOT NULL,
    variant_id integer,
    PRIMARY KEY (request_id,category,operation_identity),
    UNIQUE (request_id,ordinal)
);
-- Account snapshots intentionally have no FK: retirement or future account
-- removal must not rewrite or remove the historical author.
CREATE TRIGGER protect_transfer_personal_activity BEFORE UPDATE OR DELETE ON transfer_personal_activity
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_transfer_personal_activity_truncate BEFORE TRUNCATE ON transfer_personal_activity
EXECUTE FUNCTION protect_pending_request();
CREATE FUNCTION admit_transfer_personal_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() <> 2 THEN
        RAISE EXCEPTION 'Personal evidence is operation owned';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_transfer_personal_activity BEFORE INSERT ON transfer_personal_activity
FOR EACH ROW EXECUTE FUNCTION admit_transfer_personal_activity();

-- The application sets only the authenticated account ID, transaction-locally.
-- No setting means SQL-owner/legacy fixture context, NOT a known person.
-- Plain MVCC account reads introduce no new row/advisory lock ordering.
CREATE FUNCTION record_transfer_personal_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    person text := nullif(current_setting('luson.transfer_account_id',true),'');
    rid bigint;
    cat text := TG_ARGV[0];
    op text;
    act text;
    physical smallint;
    stamp timestamptz;
    variant integer;
BEGIN
    IF person IS NULL THEN RETURN NEW; END IF;
    IF cat = 'transfer' THEN
        rid := NEW.id;
        IF TG_OP = 'INSERT' THEN
            act := 'create'; physical := NEW.creator_location_id; stamp := NEW.created_at;
        ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
            CASE NEW.status
            WHEN 'approved' THEN act := 'approve'; physical := NEW.decision_location_id; stamp := NEW.decided_at;
            WHEN 'rejected' THEN act := 'reject'; physical := NEW.decision_location_id; stamp := NEW.decided_at;
            WHEN 'in_transit' THEN act := 'dispatch'; physical := NEW.dispatch_location_id; stamp := NEW.dispatched_at;
            WHEN 'received' THEN act := 'receive'; physical := NEW.receipt_location_id; stamp := NEW.received_at;
            WHEN 'cancelled' THEN act := 'cancel'; physical := NEW.cancellation_location_id; stamp := NEW.cancelled_at;
            ELSE RETURN NEW;
            END CASE;
        ELSE RETURN NEW;
        END IF;
        op := act;
    ELSE
        rid := NEW.request_id; op := NEW.operation_key; act := NEW.action;
        physical := NEW.actor_location_id; stamp := NEW.recorded_at; variant := NEW.variant_id;
    END IF;
    -- Existing lifecycle/workflow integrity locks serialize writers for an
    -- existing request. Initial creation owns a new, uncommitted request ID.
    -- Allocate transactionally so equal/reordered action times cannot reorder
    -- the immutable prefix, and rollback consumes no activity counter.
    INSERT INTO transfer_personal_activity(request_id,category,operation_identity,ordinal,action,
        account_id,username,display_name,location_id,location_name,recorded_at,variant_id)
    SELECT rid,cat,op,coalesce((SELECT max(e.ordinal) FROM transfer_personal_activity e WHERE e.request_id=rid),0)+1,
        act,a.id,a.username,a.display_name,l.id,l.name,stamp,variant
    FROM auth_accounts a JOIN locations l ON l.id=a.location_id
    WHERE a.id=person::bigint AND a.location_id=physical;
    IF NOT FOUND THEN RAISE EXCEPTION 'Personal evidence requires assigned identity'; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER record_transfer_personal_activity AFTER INSERT OR UPDATE ON transfer_requests
FOR EACH ROW EXECUTE FUNCTION record_transfer_personal_activity('transfer');
CREATE TRIGGER record_count_personal_activity AFTER INSERT ON transfer_count_operations
FOR EACH ROW EXECUTE FUNCTION record_transfer_personal_activity('count');
CREATE TRIGGER record_restitution_personal_activity AFTER INSERT ON transfer_restitution_operations
FOR EACH ROW EXECUTE FUNCTION record_transfer_personal_activity('restitution');
CREATE TRIGGER record_dispatch_personal_activity AFTER INSERT ON transfer_dispatch_operations
FOR EACH ROW EXECUTE FUNCTION record_transfer_personal_activity('reconciliation');
