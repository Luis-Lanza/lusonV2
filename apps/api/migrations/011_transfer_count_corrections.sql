-- Location accounts are actors, not employee identities. This boundary checks
-- supplied account locations; the application must authenticate that location.
-- Owners can change DDL/triggers and remain administrative authority.
CREATE TABLE transfer_count_operations (
    operation_key text PRIMARY KEY CHECK (length(operation_key) BETWEEN 1 AND 200),
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    actor_location_id smallint NOT NULL REFERENCES locations(id),
    action text NOT NULL CHECK (action IN ('propose','accept','reject')),
    expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
    actual_quantity bigint,
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
    revision bigint NOT NULL CHECK (revision > 0),
    recorded_at timestamptz NOT NULL,
    FOREIGN KEY (request_id,variant_id) REFERENCES transfer_receipt_lines,
    CHECK ((action='propose' AND actual_quantity>=0) OR (action<>'propose' AND actual_quantity IS NULL)),
    CHECK (action<>'propose' OR actual_quantity IS NOT NULL)
);
CREATE TABLE transfer_count_proposals (
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    operation_key text NOT NULL UNIQUE REFERENCES transfer_count_operations DEFERRABLE INITIALLY DEFERRED,
    initiator_location_id smallint NOT NULL REFERENCES locations(id),
    actual_quantity bigint NOT NULL CHECK (actual_quantity>=0),
    base_revision bigint NOT NULL CHECK (base_revision>=0),
    base_credit bigint NOT NULL CHECK (base_credit>=0),
    reason text NOT NULL,
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (request_id,variant_id,revision),
    FOREIGN KEY (request_id,variant_id) REFERENCES transfer_receipt_lines
);
CREATE TABLE transfer_count_decisions (
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    revision bigint NOT NULL,
    operation_key text NOT NULL UNIQUE REFERENCES transfer_count_operations DEFERRABLE INITIALLY DEFERRED,
    actor_location_id smallint NOT NULL REFERENCES locations(id),
    accepted boolean NOT NULL,
    reason text NOT NULL,
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (request_id,variant_id,revision),
    FOREIGN KEY (request_id,variant_id,revision) REFERENCES transfer_count_proposals
);
CREATE TABLE transfer_count_applications (
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    revision bigint NOT NULL,
    effective_credit bigint NOT NULL CHECK (effective_credit>=0),
    delta bigint NOT NULL,
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (request_id,variant_id,revision),
    FOREIGN KEY (request_id,variant_id,revision) REFERENCES transfer_count_decisions
);

-- Only nested writes made by the operation trigger can create linked evidence.
-- No session GUC, caller-supplied credit, or mutable workflow head is trusted.
CREATE FUNCTION admit_transfer_count_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth()<>2 THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Correction evidence is operation owned';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_count_proposal BEFORE INSERT ON transfer_count_proposals
FOR EACH ROW EXECUTE FUNCTION admit_transfer_count_evidence();
CREATE TRIGGER admit_count_decision BEFORE INSERT ON transfer_count_decisions
FOR EACH ROW EXECUTE FUNCTION admit_transfer_count_evidence();
CREATE TRIGGER admit_count_application BEFORE INSERT ON transfer_count_applications
FOR EACH ROW EXECUTE FUNCTION admit_transfer_count_evidence();

CREATE TRIGGER protect_count_operations BEFORE UPDATE OR DELETE ON transfer_count_operations
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_count_operations_truncate BEFORE TRUNCATE ON transfer_count_operations
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_count_proposals BEFORE UPDATE OR DELETE ON transfer_count_proposals
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_count_proposals_truncate BEFORE TRUNCATE ON transfer_count_proposals
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_count_decisions BEFORE UPDATE OR DELETE ON transfer_count_decisions
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_count_decisions_truncate BEFORE TRUNCATE ON transfer_count_decisions
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_count_applications BEFORE UPDATE OR DELETE ON transfer_count_applications
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_count_applications_truncate BEFORE TRUNCATE ON transfer_count_applications
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER lock_count_operations BEFORE INSERT ON transfer_count_operations
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();

CREATE FUNCTION apply_transfer_count_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header transfer_requests%ROWTYPE;
    receipt transfer_receipt_lines%ROWTYPE;
    latest transfer_count_proposals%ROWTYPE;
    applied transfer_count_applications%ROWTYPE;
    prior_credit bigint;
    prior_revision bigint;
    credit bigint;
    difference bigint;
    balance inventory_balances%ROWTYPE;
    audience text;
BEGIN
    -- Statement trigger has taken the shared advisory lock before row locks.
    SELECT * INTO header FROM transfer_requests WHERE id=NEW.request_id FOR UPDATE;
    IF header.status IS DISTINCT FROM 'received'
       OR NEW.actor_location_id IS NULL
       OR NEW.actor_location_id NOT IN (header.origin_location_id,header.destination_location_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Correction requires a physical endpoint of a received transfer';
    END IF;
    -- BEFORE triggers run even with ON CONFLICT DO NOTHING. Refuse an existing
    -- identity before effects so conflict suppression cannot orphan linked audit.
    IF EXISTS (SELECT 1 FROM transfer_count_operations WHERE operation_key=NEW.operation_key) THEN
        RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Use correction entrypoint for durable replay';
    END IF;
    SELECT * INTO receipt FROM transfer_receipt_lines
    WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Correction requires persisted receipt membership';
    END IF;
    SELECT * INTO latest FROM transfer_count_proposals
    WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id ORDER BY revision DESC LIMIT 1;
    IF NEW.expected_revision IS DISTINCT FROM COALESCE(latest.revision,0) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Stale correction revision';
    END IF;
    SELECT * INTO applied FROM transfer_count_applications
    WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id ORDER BY revision DESC LIMIT 1;
    prior_credit:=COALESCE(applied.effective_credit,receipt.available_quantity);
    prior_revision:=COALESCE(applied.revision,0);
    NEW.recorded_at:=statement_timestamp();
    IF NEW.action='propose' THEN
        IF NEW.actual_quantity IS NULL OR NEW.actual_quantity<0 THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Corrected count must be nonnegative';
        END IF;
        IF latest.revision IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM transfer_count_decisions WHERE request_id=NEW.request_id
            AND variant_id=NEW.variant_id AND revision=latest.revision
        ) AND latest.initiator_location_id<>NEW.actor_location_id THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only initiator may replace a pending proposal';
        END IF;
        NEW.revision:=COALESCE(latest.revision,0)+1;
        INSERT INTO transfer_count_proposals VALUES
            (NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,NEW.actor_location_id,
             NEW.actual_quantity,prior_revision,prior_credit,NEW.reason,NEW.recorded_at);
    ELSIF NEW.action IN ('accept','reject') THEN
        IF latest.revision IS NULL OR latest.initiator_location_id=NEW.actor_location_id THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only exact counterparty may decide';
        END IF;
        IF NEW.actual_quantity IS NOT NULL OR EXISTS (
            SELECT 1 FROM transfer_count_decisions WHERE request_id=NEW.request_id
            AND variant_id=NEW.variant_id AND revision=latest.revision
        ) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Decision revision is terminal or payload invalid';
        END IF;
        NEW.revision:=latest.revision;
        INSERT INTO transfer_count_decisions VALUES
            (NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,NEW.actor_location_id,
             NEW.action='accept',NEW.reason,NEW.recorded_at);
        IF NEW.action='accept' THEN
            IF (latest.base_revision,latest.base_credit) IS DISTINCT FROM (prior_revision,prior_credit) THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Correction predecessor changed';
            END IF;
            credit:=LEAST(receipt.expected_quantity,latest.actual_quantity);
            difference:=credit-prior_credit;
            -- One-line workflow: only one variant balance lock, hence sorted.
            IF difference<>0 THEN
                SELECT * INTO balance FROM inventory_balances WHERE location_id=header.destination_location_id
                AND variant_id=NEW.variant_id ORDER BY variant_id FOR UPDATE;
                IF NOT FOUND OR balance.existing::numeric+difference>9223372036854775807
                   OR balance.existing::numeric+difference<balance.reserved
                   OR balance.reserved::numeric<(SELECT COALESCE(sum(quantity),0) FROM transfer_request_allocations
                       WHERE origin_location_id=header.destination_location_id AND variant_id=NEW.variant_id
                       AND consumed_at IS NULL AND released_at IS NULL) THEN
                    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Correction requires covered nonoverflowing destination stock';
                END IF;
                UPDATE inventory_balances SET existing=existing+difference
                WHERE location_id=header.destination_location_id AND variant_id=NEW.variant_id;
            END IF;
            INSERT INTO transfer_count_applications VALUES
                (NEW.request_id,NEW.variant_id,NEW.revision,credit,difference,NEW.recorded_at);
        END IF;
    ELSE
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Invalid correction action';
    END IF;
    -- Received header stays sealed; correction evidence independently invalidates
    -- just the physical participants, including pending/rejected/zero deltas.
    PERFORM scope FROM realtime_revisions WHERE scope IN
        ('transfers:'||header.origin_location_id,'transfers:'||header.destination_location_id)
        ORDER BY scope FOR UPDATE;
    FOR audience IN SELECT scope FROM realtime_revisions WHERE scope IN
        ('transfers:'||header.origin_location_id,'transfers:'||header.destination_location_id) ORDER BY scope LOOP
        UPDATE realtime_revisions SET revision=revision+1 WHERE scope=audience;
        PERFORM pg_notify('luson_realtime',audience);
    END LOOP;
    RETURN NEW;
END;
$$;
CREATE TRIGGER apply_count_operation BEFORE INSERT ON transfer_count_operations
FOR EACH ROW EXECUTE FUNCTION apply_transfer_count_operation();

-- C2b calls this with the authenticated account location. expected_revision is
-- the current per-line workflow revision (0 before first proposal). Returns the
-- persisted operation, including server revision/time; replay returns that row.
CREATE FUNCTION transfer_count_correct(
    request_key bigint, item_key integer, actor_key smallint, retry_key text,
    operation_action text, revision_key bigint, corrected_actual bigint, operation_reason text
) RETURNS transfer_count_operations LANGUAGE plpgsql AS $$
DECLARE header transfer_requests%ROWTYPE; result transfer_count_operations%ROWTYPE;
BEGIN
    IF current_setting('transaction_isolation')<>'read committed' THEN
        RAISE EXCEPTION USING ERRCODE='25000', MESSAGE='Corrections require READ COMMITTED';
    END IF;
    PERFORM pg_advisory_xact_lock(714025,1);
    SELECT * INTO header FROM transfer_requests WHERE id=request_key FOR UPDATE;
    -- Authorization precedes any durable operation lookup, including retries.
    IF header.status IS DISTINCT FROM 'received' OR actor_key IS NULL
       OR actor_key NOT IN (header.origin_location_id,header.destination_location_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Correction endpoint unauthorized';
    END IF;
    SELECT * INTO result FROM transfer_count_operations WHERE operation_key=retry_key;
    IF FOUND THEN
        IF (result.request_id,result.variant_id,result.actor_location_id,result.action,
            result.expected_revision,result.actual_quantity,result.reason) IS DISTINCT FROM
            (request_key,item_key,actor_key,operation_action,revision_key,corrected_actual,operation_reason) THEN
            RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Correction operation identity conflicts';
        END IF;
        RETURN result;
    END IF;
    INSERT INTO transfer_count_operations(operation_key,request_id,variant_id,actor_location_id,
        action,expected_revision,actual_quantity,reason)
    VALUES(retry_key,request_key,item_key,actor_key,operation_action,revision_key,corrected_actual,operation_reason)
    RETURNING * INTO result;
    RETURN result;
END;
$$;
