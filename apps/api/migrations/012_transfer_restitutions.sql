-- Physical location accounts attest retention; authentication of the supplied
-- location remains the application's boundary. Owners retain DDL authority.
CREATE TABLE transfer_restitution_operations (
    operation_key text PRIMARY KEY CHECK (length(operation_key) BETWEEN 1 AND 200),
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    actor_location_id smallint NOT NULL REFERENCES locations(id),
    action text NOT NULL CHECK (action IN ('propose','accept','reject')),
    expected_revision bigint NOT NULL CHECK (expected_revision>=0),
    retained_quantity bigint,
    retained_at_origin boolean,
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
    revision bigint NOT NULL CHECK (revision>0),
    source_existing_before bigint,
    source_existing_after bigint,
    recorded_at timestamptz NOT NULL,
    FOREIGN KEY (request_id,variant_id) REFERENCES transfer_receipt_lines,
    CHECK ((action='propose' AND retained_quantity>0 AND retained_at_origin IS TRUE
            AND retained_quantity IS NOT NULL)
        OR (action<>'propose' AND retained_quantity IS NULL AND retained_at_origin IS NULL)),
    CHECK ((action='accept' AND source_existing_before IS NOT NULL AND source_existing_after IS NOT NULL
            AND source_existing_after>source_existing_before)
        OR (action<>'accept' AND source_existing_before IS NULL AND source_existing_after IS NULL))
);
CREATE TABLE transfer_restitution_proposals (
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    revision bigint NOT NULL CHECK (revision>0),
    operation_key text NOT NULL UNIQUE REFERENCES transfer_restitution_operations DEFERRABLE INITIALLY DEFERRED,
    initiator_location_id smallint NOT NULL REFERENCES locations(id),
    retained_quantity bigint NOT NULL CHECK (retained_quantity>0),
    retained_at_origin boolean NOT NULL CHECK (retained_at_origin),
    base_revision bigint NOT NULL CHECK (base_revision>=0),
    count_generation bigint NOT NULL CHECK (count_generation>=0),
    count_applied_revision bigint NOT NULL CHECK (count_applied_revision>=0),
    base_credit bigint NOT NULL CHECK (base_credit>=0),
    base_restitution bigint NOT NULL CHECK (base_restitution>=0),
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (request_id,variant_id,revision),
    FOREIGN KEY (request_id,variant_id) REFERENCES transfer_receipt_lines
);
CREATE TABLE transfer_restitution_decisions (
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    revision bigint NOT NULL,
    operation_key text NOT NULL UNIQUE REFERENCES transfer_restitution_operations DEFERRABLE INITIALLY DEFERRED,
    actor_location_id smallint NOT NULL REFERENCES locations(id),
    accepted boolean NOT NULL,
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (request_id,variant_id,revision),
    FOREIGN KEY (request_id,variant_id,revision) REFERENCES transfer_restitution_proposals
);
CREATE TABLE transfer_restitution_applications (
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    revision bigint NOT NULL,
    operation_key text NOT NULL UNIQUE REFERENCES transfer_restitution_operations,
    origin_location_id smallint NOT NULL REFERENCES locations(id),
    quantity bigint NOT NULL CHECK (quantity>0),
    recorded_at timestamptz NOT NULL,
    -- Semantic uniqueness, including partial settlements and different keys.
    PRIMARY KEY (request_id,variant_id),
    FOREIGN KEY (request_id,variant_id,revision) REFERENCES transfer_restitution_decisions
);

CREATE FUNCTION admit_restitution_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth()<>2 THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution evidence is operation owned';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_restitution_proposal BEFORE INSERT ON transfer_restitution_proposals
FOR EACH ROW EXECUTE FUNCTION admit_restitution_evidence();
CREATE TRIGGER admit_restitution_decision BEFORE INSERT ON transfer_restitution_decisions
FOR EACH ROW EXECUTE FUNCTION admit_restitution_evidence();
CREATE TRIGGER protect_restitution_operations BEFORE UPDATE OR DELETE ON transfer_restitution_operations
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_restitution_operations_truncate BEFORE TRUNCATE ON transfer_restitution_operations
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_restitution_proposals BEFORE UPDATE OR DELETE ON transfer_restitution_proposals
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_restitution_proposals_truncate BEFORE TRUNCATE ON transfer_restitution_proposals
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_restitution_decisions BEFORE UPDATE OR DELETE ON transfer_restitution_decisions
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_restitution_decisions_truncate BEFORE TRUNCATE ON transfer_restitution_decisions
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_restitution_applications BEFORE UPDATE OR DELETE ON transfer_restitution_applications
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_restitution_applications_truncate BEFORE TRUNCATE ON transfer_restitution_applications
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER lock_restitution_operations BEFORE INSERT ON transfer_restitution_operations
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();

-- Additive seam: 011 may already have updated destination stock and inserted a
-- decision. Failure here rolls back the entire statement, also for zero deltas.
-- No clipping to D-R, no origin debit, no replacement of historical functions.
CREATE FUNCTION guard_count_restitution_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE debit bigint; restored bigint;
BEGIN
    PERFORM pg_advisory_xact_lock(714025,1);
    PERFORM id FROM transfer_requests WHERE id=NEW.request_id FOR UPDATE;
    SELECT expected_quantity INTO debit FROM transfer_receipt_lines
    WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id;
    SELECT COALESCE(sum(quantity),0) INTO restored FROM transfer_restitution_applications
    WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id;
    IF debit IS NULL OR restored>debit OR NEW.effective_credit>debit-restored THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Correction exceeds debit after restitution';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER guard_count_restitution BEFORE INSERT ON transfer_count_applications
FOR EACH ROW EXECUTE FUNCTION guard_count_restitution_conservation();

CREATE FUNCTION apply_restitution_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header transfer_requests%ROWTYPE;
    receipt transfer_receipt_lines%ROWTYPE;
    latest transfer_restitution_proposals%ROWTYPE;
    count_head transfer_count_proposals%ROWTYPE;
    counted transfer_count_applications%ROWTYPE;
    balance inventory_balances%ROWTYPE;
    generation bigint;
    credit bigint;
    restored bigint;
    applied_revision bigint;
    audience text;
BEGIN
    SELECT * INTO header FROM transfer_requests WHERE id=NEW.request_id FOR UPDATE;
    IF header.status IS DISTINCT FROM 'received' OR NEW.actor_location_id IS NULL
       OR NEW.actor_location_id NOT IN (header.origin_location_id,header.destination_location_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Restitution requires a physical endpoint of a received transfer';
    END IF;
    IF EXISTS (SELECT 1 FROM transfer_restitution_operations WHERE operation_key=NEW.operation_key) THEN
        RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Use restitution entrypoint for durable replay';
    END IF;
    SELECT * INTO receipt FROM transfer_receipt_lines
    WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id;
    IF NOT FOUND OR receipt.expected_quantity<=0 THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution requires an expected received line';
    END IF;
    SELECT * INTO latest FROM transfer_restitution_proposals
    WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id ORDER BY revision DESC LIMIT 1;
    IF NEW.expected_revision IS DISTINCT FROM COALESCE(latest.revision,0) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Stale restitution revision';
    END IF;
    SELECT * INTO count_head FROM transfer_count_proposals
    WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id ORDER BY revision DESC LIMIT 1;
    SELECT count(*) INTO generation FROM transfer_count_operations
    WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id;
    SELECT * INTO counted FROM transfer_count_applications
    WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id ORDER BY revision DESC LIMIT 1;
    credit:=COALESCE(counted.effective_credit,receipt.available_quantity);
    applied_revision:=COALESCE(counted.revision,0);
    SELECT COALESCE(sum(quantity),0) INTO restored FROM transfer_restitution_applications
    WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id;
    IF NEW.action IN ('propose','accept') AND count_head.revision IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM transfer_count_decisions WHERE request_id=NEW.request_id
        AND variant_id=NEW.variant_id AND revision=count_head.revision
    ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution blocked by pending count proposal';
    END IF;
    NEW.recorded_at:=statement_timestamp();
    NEW.source_existing_before:=NULL;
    NEW.source_existing_after:=NULL;
    IF NEW.action='propose' THEN
        IF NEW.actor_location_id<>header.origin_location_id THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only origin may attest retained stock';
        END IF;
        IF NEW.retained_quantity IS NULL OR NEW.retained_quantity<=0 OR NEW.retained_at_origin IS DISTINCT FROM true THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution requires explicit positive retention attestation';
        END IF;
        IF restored<>0 THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution already applied';
        END IF;
        IF credit>receipt.expected_quantity OR restored>receipt.expected_quantity-credit
           OR NEW.retained_quantity>receipt.expected_quantity-credit-restored THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution exceeds outstanding debit';
        END IF;
        NEW.revision:=COALESCE(latest.revision,0)+1;
        INSERT INTO transfer_restitution_proposals VALUES
            (NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,NEW.actor_location_id,
             NEW.retained_quantity,true,NEW.expected_revision,generation,applied_revision,credit,restored,
             NEW.reason,NEW.recorded_at);
    ELSIF NEW.action IN ('accept','reject') THEN
        IF NEW.actor_location_id<>header.destination_location_id OR latest.revision IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only exact destination may decide restitution';
        END IF;
        IF NEW.retained_quantity IS NOT NULL OR NEW.retained_at_origin IS NOT NULL OR EXISTS (
            SELECT 1 FROM transfer_restitution_decisions WHERE request_id=NEW.request_id
            AND variant_id=NEW.variant_id AND revision=latest.revision
        ) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution decision is terminal or payload invalid';
        END IF;
        NEW.revision:=latest.revision;
        IF NEW.action='accept' THEN
            IF (latest.base_revision,latest.count_generation,latest.count_applied_revision,latest.base_credit,latest.base_restitution)
               IS DISTINCT FROM (latest.revision-1,generation,applied_revision,credit,restored) THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution predecessor changed';
            END IF;
            IF restored<>0 THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution already applied';
            END IF;
            IF credit>receipt.expected_quantity OR restored>receipt.expected_quantity-credit
               OR latest.retained_quantity>receipt.expected_quantity-credit-restored THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution exceeds outstanding debit';
            END IF;
            SELECT * INTO balance FROM inventory_balances
            WHERE location_id=header.origin_location_id AND variant_id=NEW.variant_id ORDER BY variant_id FOR UPDATE;
            IF NOT FOUND OR balance.existing::numeric+latest.retained_quantity>9223372036854775807
               OR balance.existing::numeric+latest.retained_quantity<balance.reserved
               OR balance.reserved::numeric<(SELECT COALESCE(sum(quantity),0) FROM transfer_request_allocations
                   WHERE origin_location_id=header.origin_location_id AND variant_id=NEW.variant_id
                   AND consumed_at IS NULL AND released_at IS NULL) THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution requires covered nonoverflowing origin stock';
            END IF;
            NEW.source_existing_before:=balance.existing;
            NEW.source_existing_after:=balance.existing+latest.retained_quantity;
            UPDATE inventory_balances SET existing=NEW.source_existing_after
            WHERE location_id=header.origin_location_id AND variant_id=NEW.variant_id;
        END IF;
        INSERT INTO transfer_restitution_decisions VALUES
            (NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,NEW.actor_location_id,
             NEW.action='accept',NEW.reason,NEW.recorded_at);
    ELSE
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Invalid restitution action';
    END IF;
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
CREATE TRIGGER apply_restitution_operation BEFORE INSERT ON transfer_restitution_operations
FOR EACH ROW EXECUTE FUNCTION apply_restitution_operation();

-- Application is written AFTER the operation row exists. This independent
-- guard joins durable decision/proposal/operation and checks the trigger-derived
-- before/after stock effect under the held balance lock. Bare evidence, even
-- nested evidence from an unrelated trigger, cannot manufacture restored R.
CREATE FUNCTION guard_restitution_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth()<>2 OR NOT EXISTS (
        SELECT 1 FROM transfer_restitution_operations o
        JOIN transfer_restitution_decisions d ON d.operation_key=o.operation_key
        JOIN transfer_restitution_proposals p ON (p.request_id,p.variant_id,p.revision)=(d.request_id,d.variant_id,d.revision)
        JOIN transfer_requests h ON h.id=o.request_id
        JOIN inventory_balances b ON b.location_id=h.origin_location_id AND b.variant_id=o.variant_id
        WHERE o.operation_key=NEW.operation_key AND o.action='accept' AND d.accepted
        AND (o.request_id,o.variant_id,o.revision)=(NEW.request_id,NEW.variant_id,NEW.revision)
        AND (d.request_id,d.variant_id,d.revision)=(NEW.request_id,NEW.variant_id,NEW.revision)
        AND p.retained_at_origin AND p.initiator_location_id=h.origin_location_id
        AND o.actor_location_id=h.destination_location_id AND d.actor_location_id=h.destination_location_id
        AND NEW.origin_location_id=h.origin_location_id AND NEW.quantity=p.retained_quantity
        AND NEW.recorded_at=o.recorded_at AND d.recorded_at=o.recorded_at
        AND o.source_existing_after::numeric-o.source_existing_before=NEW.quantity
        AND b.existing=o.source_existing_after
    ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution application requires operation credit and accepted attestation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER guard_restitution_application BEFORE INSERT ON transfer_restitution_applications
FOR EACH ROW EXECUTE FUNCTION guard_restitution_application();
CREATE FUNCTION record_restitution_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.action='accept' THEN
        INSERT INTO transfer_restitution_applications
        SELECT NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,h.origin_location_id,
               p.retained_quantity,NEW.recorded_at
        FROM transfer_requests h JOIN transfer_restitution_proposals p ON p.request_id=h.id
        WHERE h.id=NEW.request_id AND p.variant_id=NEW.variant_id AND p.revision=NEW.revision;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER record_restitution_application AFTER INSERT ON transfer_restitution_operations
FOR EACH ROW EXECUTE FUNCTION record_restitution_application();

-- Exact authorized retry returns the original result before freshness checks.
-- Payload equality includes the explicit attestation, never inferred balances.
CREATE FUNCTION transfer_restitute(
    request_key bigint, item_key integer, actor_key smallint, retry_key text,
    operation_action text, revision_key bigint, retained bigint, attested boolean, operation_reason text
) RETURNS transfer_restitution_operations LANGUAGE plpgsql AS $$
DECLARE header transfer_requests%ROWTYPE; result transfer_restitution_operations%ROWTYPE;
BEGIN
    IF current_setting('transaction_isolation')<>'read committed' THEN
        RAISE EXCEPTION USING ERRCODE='25000', MESSAGE='Restitutions require READ COMMITTED';
    END IF;
    PERFORM pg_advisory_xact_lock(714025,1);
    SELECT * INTO header FROM transfer_requests WHERE id=request_key FOR UPDATE;
    IF header.status IS DISTINCT FROM 'received' OR actor_key IS NULL
       OR actor_key NOT IN (header.origin_location_id,header.destination_location_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Restitution endpoint unauthorized';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM transfer_receipt_lines
        WHERE request_id=request_key AND variant_id=item_key AND expected_quantity>0) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution requires an expected received line';
    END IF;
    SELECT * INTO result FROM transfer_restitution_operations WHERE operation_key=retry_key;
    IF FOUND THEN
        IF (result.request_id,result.variant_id,result.actor_location_id,result.action,
            result.expected_revision,result.retained_quantity,result.retained_at_origin,result.reason) IS DISTINCT FROM
            (request_key,item_key,actor_key,operation_action,revision_key,retained,attested,operation_reason) THEN
            RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Restitution operation identity conflicts';
        END IF;
        RETURN result;
    END IF;
    INSERT INTO transfer_restitution_operations(operation_key,request_id,variant_id,actor_location_id,
        action,expected_revision,retained_quantity,retained_at_origin,reason)
    VALUES(retry_key,request_key,item_key,actor_key,operation_action,revision_key,retained,attested,operation_reason)
    RETURNING * INTO result;
    RETURN result;
END;
$$;
