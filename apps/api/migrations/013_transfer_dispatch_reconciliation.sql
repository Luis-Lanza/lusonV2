-- Received evidence remains immutable. This is a bilateral accounting correction,
-- not another shipment. Authentication of supplied location accounts remains the
-- caller's boundary; database owners retain administrative DDL authority.
CREATE TABLE transfer_dispatch_operations (
    operation_key text PRIMARY KEY CHECK (length(operation_key) BETWEEN 1 AND 200),
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    actor_location_id smallint NOT NULL REFERENCES locations,
    action text NOT NULL CHECK (action IN ('propose','accept','reject')),
    expected_revision bigint NOT NULL CHECK (expected_revision>=0),
    dispatch_quantity bigint,
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
    revision bigint NOT NULL CHECK (revision>0),
    source_existing_before bigint,
    source_existing_after bigint,
    destination_existing_before bigint,
    destination_existing_after bigint,
    recorded_at timestamptz NOT NULL,
    FOREIGN KEY (request_id,variant_id) REFERENCES transfer_receipt_lines,
    CHECK ((action='propose' AND dispatch_quantity IS NOT NULL AND dispatch_quantity>=0)
        OR (action<>'propose' AND dispatch_quantity IS NULL)),
    CHECK ((action='accept' AND source_existing_before IS NOT NULL AND source_existing_after IS NOT NULL
        AND destination_existing_before IS NOT NULL AND destination_existing_after IS NOT NULL)
        OR (action<>'accept' AND source_existing_before IS NULL AND source_existing_after IS NULL
        AND destination_existing_before IS NULL AND destination_existing_after IS NULL))
);
CREATE TABLE transfer_dispatch_proposals (
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    revision bigint NOT NULL CHECK (revision>0),
    operation_key text NOT NULL UNIQUE REFERENCES transfer_dispatch_operations DEFERRABLE INITIALLY DEFERRED,
    initiator_location_id smallint NOT NULL REFERENCES locations,
    dispatch_quantity bigint NOT NULL CHECK (dispatch_quantity>=0),
    base_dispatch bigint NOT NULL CHECK (base_dispatch>=0),
    base_actual bigint NOT NULL CHECK (base_actual>=0),
    base_credit bigint NOT NULL CHECK (base_credit>=0),
    count_generation bigint NOT NULL CHECK (count_generation>=0),
    restitution_generation bigint NOT NULL CHECK (restitution_generation>=0),
    reconciliation_generation bigint NOT NULL CHECK (reconciliation_generation>=0),
    reason text NOT NULL,
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (request_id,variant_id,revision),
    FOREIGN KEY (request_id,variant_id) REFERENCES transfer_receipt_lines
);
CREATE TABLE transfer_dispatch_decisions (
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    revision bigint NOT NULL,
    operation_key text NOT NULL UNIQUE REFERENCES transfer_dispatch_operations DEFERRABLE INITIALLY DEFERRED,
    actor_location_id smallint NOT NULL REFERENCES locations,
    accepted boolean NOT NULL,
    reason text NOT NULL,
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (request_id,variant_id,revision),
    FOREIGN KEY (request_id,variant_id,revision) REFERENCES transfer_dispatch_proposals
);
CREATE TABLE transfer_dispatch_applications (
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    revision bigint NOT NULL,
    operation_key text NOT NULL UNIQUE REFERENCES transfer_dispatch_operations,
    effective_dispatch bigint NOT NULL CHECK (effective_dispatch>=0),
    source_delta bigint NOT NULL,
    destination_delta bigint NOT NULL,
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (request_id,variant_id,revision),
    FOREIGN KEY (request_id,variant_id,revision) REFERENCES transfer_dispatch_decisions
);

-- C is a sum across independent workflows, never the last timestamp or the
-- largest revision across unrelated sequences. Numeric intermediates avoid
-- overflow even when a long sequence of positive/negative deltas cancels out.
CREATE FUNCTION transfer_effective_line(request_key bigint, item_key integer)
RETURNS TABLE(dispatch bigint, actual bigint, credit bigint, restored bigint,
    count_revision bigint, count_generation bigint, restitution_generation bigint,
    reconciliation_generation bigint, reconciliation_revision bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE receipt transfer_receipt_lines%ROWTYPE; total numeric;
BEGIN
    SELECT * INTO receipt FROM transfer_receipt_lines
    WHERE request_id=request_key AND variant_id=item_key;
    IF NOT FOUND THEN RETURN; END IF;
    SELECT COALESCE(max(a.revision),0) INTO reconciliation_revision
    FROM transfer_dispatch_applications a WHERE a.request_id=request_key AND a.variant_id=item_key;
    SELECT COALESCE((SELECT a.effective_dispatch FROM transfer_dispatch_applications a
        WHERE a.request_id=request_key AND a.variant_id=item_key AND a.revision=reconciliation_revision),receipt.expected_quantity)
    INTO dispatch;
    SELECT COALESCE(max(a.revision),0) INTO count_revision
    FROM transfer_count_applications a WHERE a.request_id=request_key AND a.variant_id=item_key;
    SELECT COALESCE((SELECT p.actual_quantity FROM transfer_count_proposals p
        WHERE p.request_id=request_key AND p.variant_id=item_key AND p.revision=count_revision),receipt.actual_quantity)
    INTO actual;
    SELECT receipt.available_quantity::numeric
        + COALESCE((SELECT sum(a.delta::numeric) FROM transfer_count_applications a
            WHERE a.request_id=request_key AND a.variant_id=item_key),0)
        + COALESCE((SELECT sum(a.destination_delta::numeric) FROM transfer_dispatch_applications a
            WHERE a.request_id=request_key AND a.variant_id=item_key),0) INTO total;
    IF total<0 OR total>9223372036854775807 THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Effective transfer credit outside bigint bounds';
    END IF;
    credit:=total::bigint;
    SELECT COALESCE(sum(a.quantity::numeric),0)::bigint INTO restored
    FROM transfer_restitution_applications a WHERE a.request_id=request_key AND a.variant_id=item_key;
    SELECT count(*) INTO count_generation FROM transfer_count_operations o WHERE o.request_id=request_key AND o.variant_id=item_key;
    SELECT count(*) INTO restitution_generation FROM transfer_restitution_operations o WHERE o.request_id=request_key AND o.variant_id=item_key;
    SELECT count(*) INTO reconciliation_generation FROM transfer_dispatch_operations o WHERE o.request_id=request_key AND o.variant_id=item_key;
    RETURN NEXT;
END;
$$;

-- Companion pins preserve existing immutable proposal shapes. Absence means an
-- original pre-013 proposal: reconciliation generation zero and original D.
CREATE TABLE transfer_count_reconciliation_pins (
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    revision bigint NOT NULL,
    reconciliation_generation bigint NOT NULL CHECK (reconciliation_generation>=0),
    restitution_generation bigint NOT NULL CHECK (restitution_generation>=0),
    effective_dispatch bigint NOT NULL CHECK (effective_dispatch>=0),
    PRIMARY KEY (request_id,variant_id,revision),
    FOREIGN KEY (request_id,variant_id,revision) REFERENCES transfer_count_proposals
);
CREATE TABLE transfer_restitution_reconciliation_pins (
    request_id bigint NOT NULL,
    variant_id integer NOT NULL,
    revision bigint NOT NULL,
    reconciliation_generation bigint NOT NULL CHECK (reconciliation_generation>=0),
    effective_dispatch bigint NOT NULL CHECK (effective_dispatch>=0),
    PRIMARY KEY (request_id,variant_id,revision),
    FOREIGN KEY (request_id,variant_id,revision) REFERENCES transfer_restitution_proposals
);
CREATE FUNCTION record_transfer_reconciliation_pin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state record;
BEGIN
    SELECT * INTO STRICT state FROM transfer_effective_line(NEW.request_id,NEW.variant_id);
    IF TG_TABLE_NAME='transfer_count_proposals' THEN
        INSERT INTO transfer_count_reconciliation_pins VALUES
            (NEW.request_id,NEW.variant_id,NEW.revision,state.reconciliation_generation,state.restitution_generation,state.dispatch);
    ELSE
        INSERT INTO transfer_restitution_reconciliation_pins VALUES
            (NEW.request_id,NEW.variant_id,NEW.revision,state.reconciliation_generation,state.dispatch);
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER record_count_reconciliation_pin AFTER INSERT ON transfer_count_proposals
FOR EACH ROW EXECUTE FUNCTION record_transfer_reconciliation_pin();
CREATE TRIGGER record_restitution_reconciliation_pin AFTER INSERT ON transfer_restitution_proposals
FOR EACH ROW EXECUTE FUNCTION record_transfer_reconciliation_pin();
CREATE FUNCTION admit_transfer_reconciliation_pin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state record; creating boolean;
BEGIN
    IF pg_trigger_depth()<>3 THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reconciliation pins are proposal owned';
    END IF;
    SELECT * INTO STRICT state FROM transfer_effective_line(NEW.request_id,NEW.variant_id);
    -- Legitimate proposal evidence is inserted by the operation's BEFORE
    -- trigger, before its operation row is durable. An old proposal cannot be
    -- refreshed by an unrelated trigger merely reproducing the nesting depth.
    IF TG_TABLE_NAME='transfer_count_reconciliation_pins' THEN
        SELECT EXISTS (SELECT 1 FROM transfer_count_proposals p
            WHERE (p.request_id,p.variant_id,p.revision)=(NEW.request_id,NEW.variant_id,NEW.revision)
            AND NOT EXISTS (SELECT 1 FROM transfer_count_operations o WHERE o.operation_key=p.operation_key))
            AND NEW.restitution_generation=state.restitution_generation INTO creating;
    ELSE
        SELECT EXISTS (SELECT 1 FROM transfer_restitution_proposals p
            WHERE (p.request_id,p.variant_id,p.revision)=(NEW.request_id,NEW.variant_id,NEW.revision)
            AND NOT EXISTS (SELECT 1 FROM transfer_restitution_operations o WHERE o.operation_key=p.operation_key)) INTO creating;
    END IF;
    IF NOT creating OR NEW.reconciliation_generation<>state.reconciliation_generation OR NEW.effective_dispatch<>state.dispatch THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reconciliation pins require the creating proposal operation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_count_reconciliation_pin BEFORE INSERT ON transfer_count_reconciliation_pins
FOR EACH ROW EXECUTE FUNCTION admit_transfer_reconciliation_pin();
CREATE TRIGGER admit_restitution_reconciliation_pin BEFORE INSERT ON transfer_restitution_reconciliation_pins
FOR EACH ROW EXECUTE FUNCTION admit_transfer_reconciliation_pin();
CREATE TRIGGER protect_count_reconciliation_pins BEFORE UPDATE OR DELETE ON transfer_count_reconciliation_pins
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_count_reconciliation_pins_truncate BEFORE TRUNCATE ON transfer_count_reconciliation_pins
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_restitution_reconciliation_pins BEFORE UPDATE OR DELETE ON transfer_restitution_reconciliation_pins
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_restitution_reconciliation_pins_truncate BEFORE TRUNCATE ON transfer_restitution_reconciliation_pins
EXECUTE FUNCTION protect_pending_request();

CREATE TRIGGER admit_dispatch_proposal BEFORE INSERT ON transfer_dispatch_proposals
FOR EACH ROW EXECUTE FUNCTION admit_transfer_count_evidence();
CREATE TRIGGER admit_dispatch_decision BEFORE INSERT ON transfer_dispatch_decisions
FOR EACH ROW EXECUTE FUNCTION admit_transfer_count_evidence();
CREATE TRIGGER protect_dispatch_operations BEFORE UPDATE OR DELETE ON transfer_dispatch_operations
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_dispatch_operations_truncate BEFORE TRUNCATE ON transfer_dispatch_operations
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_dispatch_proposals BEFORE UPDATE OR DELETE ON transfer_dispatch_proposals
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_dispatch_proposals_truncate BEFORE TRUNCATE ON transfer_dispatch_proposals
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_dispatch_decisions BEFORE UPDATE OR DELETE ON transfer_dispatch_decisions
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_dispatch_decisions_truncate BEFORE TRUNCATE ON transfer_dispatch_decisions
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_dispatch_applications BEFORE UPDATE OR DELETE ON transfer_dispatch_applications
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_dispatch_applications_truncate BEFORE TRUNCATE ON transfer_dispatch_applications
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER lock_dispatch_operations BEFORE INSERT ON transfer_dispatch_operations
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();

-- Nesting depth admits the operation writer, but is not by itself a durable
-- consent proof. Deferred validation sees the owning operation after its BEFORE
-- trigger completes and refuses fabricated evidence from unrelated triggers.
CREATE FUNCTION validate_transfer_dispatch_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid boolean;
BEGIN
    IF TG_TABLE_NAME='transfer_dispatch_proposals' THEN
        SELECT EXISTS (SELECT 1 FROM transfer_dispatch_operations o WHERE o.operation_key=NEW.operation_key
            AND o.action='propose' AND (o.request_id,o.variant_id,o.revision)=(NEW.request_id,NEW.variant_id,NEW.revision)
            AND o.expected_revision=NEW.revision-1 AND o.actor_location_id=NEW.initiator_location_id
            AND o.dispatch_quantity=NEW.dispatch_quantity AND o.reason=NEW.reason AND o.recorded_at=NEW.recorded_at) INTO valid;
    ELSE
        SELECT EXISTS (SELECT 1 FROM transfer_dispatch_operations o WHERE o.operation_key=NEW.operation_key
            AND o.action=CASE WHEN NEW.accepted THEN 'accept' ELSE 'reject' END
            AND (o.request_id,o.variant_id,o.revision)=(NEW.request_id,NEW.variant_id,NEW.revision)
            AND o.expected_revision=NEW.revision AND o.actor_location_id=NEW.actor_location_id
            AND o.reason=NEW.reason AND o.recorded_at=NEW.recorded_at) INTO valid;
    END IF;
    IF NOT valid THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reconciliation evidence requires matching durable consent';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER validate_dispatch_proposal AFTER INSERT ON transfer_dispatch_proposals
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_transfer_dispatch_evidence();
CREATE CONSTRAINT TRIGGER validate_dispatch_decision AFTER INSERT ON transfer_dispatch_decisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_transfer_dispatch_evidence();

CREATE FUNCTION apply_transfer_dispatch_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header transfer_requests%ROWTYPE;
    receipt transfer_receipt_lines%ROWTYPE;
    latest transfer_dispatch_proposals%ROWTYPE;
    state record;
    balance inventory_balances%ROWTYPE;
    difference bigint;
    source_delta bigint;
    destination_delta bigint;
    locked integer:=0;
    audience text;
BEGIN
    SELECT * INTO header FROM transfer_requests WHERE id=NEW.request_id FOR UPDATE;
    IF header.status IS DISTINCT FROM 'received' OR NEW.actor_location_id IS NULL
       OR NEW.actor_location_id NOT IN (header.origin_location_id,header.destination_location_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Reconciliation requires a physical endpoint of a received transfer';
    END IF;
    IF EXISTS (SELECT 1 FROM transfer_dispatch_operations WHERE operation_key=NEW.operation_key) THEN
        RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Use reconciliation entrypoint for durable replay';
    END IF;
    SELECT * INTO receipt FROM transfer_receipt_lines WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id;
    IF NOT FOUND OR receipt.expected_quantity<=0 THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reconciliation requires an originally expected variant';
    END IF;
    SELECT * INTO STRICT state FROM transfer_effective_line(NEW.request_id,NEW.variant_id);
    SELECT * INTO latest FROM transfer_dispatch_proposals WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id
    ORDER BY revision DESC LIMIT 1;
    IF NEW.expected_revision IS DISTINCT FROM COALESCE(latest.revision,0) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Stale reconciliation revision';
    END IF;
    NEW.recorded_at:=statement_timestamp();
    NEW.source_existing_before:=NULL;
    NEW.source_existing_after:=NULL;
    NEW.destination_existing_before:=NULL;
    NEW.destination_existing_after:=NULL;
    IF NEW.action='propose' THEN
        IF state.restored<>0 THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reconciliation excluded after restitution';
        END IF;
        IF NEW.dispatch_quantity IS NULL OR NEW.dispatch_quantity<0 OR NEW.dispatch_quantity<>state.actual
           OR NEW.dispatch_quantity=state.dispatch THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reconciled dispatch must equal effective received count and change dispatch';
        END IF;
        IF latest.revision IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transfer_dispatch_decisions
            WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id AND revision=latest.revision)
            AND latest.initiator_location_id<>NEW.actor_location_id THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only initiator may replace a pending reconciliation';
        END IF;
        NEW.revision:=COALESCE(latest.revision,0)+1;
        INSERT INTO transfer_dispatch_proposals VALUES
            (NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,NEW.actor_location_id,NEW.dispatch_quantity,
             state.dispatch,state.actual,state.credit,state.count_generation,state.restitution_generation,
             state.reconciliation_generation,NEW.reason,NEW.recorded_at);
    ELSIF NEW.action IN ('accept','reject') THEN
        IF latest.revision IS NULL OR latest.initiator_location_id=NEW.actor_location_id THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only exact reconciliation counterparty may decide';
        END IF;
        IF NEW.dispatch_quantity IS NOT NULL OR EXISTS (SELECT 1 FROM transfer_dispatch_decisions
            WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id AND revision=latest.revision) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reconciliation decision is terminal or payload invalid';
        END IF;
        NEW.revision:=latest.revision;
        IF NEW.action='accept' THEN
            IF state.restored<>0 THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reconciliation excluded after restitution';
            END IF;
            IF (latest.base_dispatch,latest.base_actual,latest.base_credit,latest.count_generation,
                latest.restitution_generation,latest.reconciliation_generation+1)
                IS DISTINCT FROM (state.dispatch,state.actual,state.credit,state.count_generation,
                state.restitution_generation,state.reconciliation_generation) THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reconciliation predecessor changed';
            END IF;
            source_delta:=state.dispatch-latest.dispatch_quantity;
            destination_delta:=latest.dispatch_quantity-state.credit;
            -- Joint locks are acquired in physical location order, including
            -- zero-effect rows. Validate BOTH before either update.
            FOR balance IN SELECT * FROM inventory_balances
                WHERE variant_id=NEW.variant_id AND location_id IN (header.origin_location_id,header.destination_location_id)
                ORDER BY location_id,variant_id FOR UPDATE LOOP
                locked:=locked+1;
                difference:=CASE WHEN balance.location_id=header.origin_location_id THEN source_delta ELSE destination_delta END;
                IF balance.existing<balance.reserved OR balance.existing::numeric+difference<balance.reserved
                   OR balance.existing::numeric+difference>9223372036854775807
                   OR balance.reserved::numeric<(SELECT COALESCE(sum(quantity::numeric),0) FROM transfer_request_allocations
                       WHERE origin_location_id=balance.location_id AND variant_id=NEW.variant_id
                       AND consumed_at IS NULL AND released_at IS NULL) THEN
                    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reconciliation requires covered nonoverflowing endpoint stock';
                END IF;
                IF balance.location_id=header.origin_location_id THEN
                    NEW.source_existing_before:=balance.existing;
                    NEW.source_existing_after:=balance.existing+source_delta;
                ELSE
                    NEW.destination_existing_before:=balance.existing;
                    NEW.destination_existing_after:=balance.existing+destination_delta;
                END IF;
            END LOOP;
            IF locked<>2 THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reconciliation requires both endpoint balances';
            END IF;
            IF source_delta<>0 THEN
                UPDATE inventory_balances SET existing=NEW.source_existing_after
                WHERE location_id=header.origin_location_id AND variant_id=NEW.variant_id;
            END IF;
            IF destination_delta<>0 THEN
                UPDATE inventory_balances SET existing=NEW.destination_existing_after
                WHERE location_id=header.destination_location_id AND variant_id=NEW.variant_id;
            END IF;
        END IF;
        INSERT INTO transfer_dispatch_decisions VALUES
            (NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,NEW.actor_location_id,NEW.action='accept',NEW.reason,NEW.recorded_at);
    ELSE
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Invalid reconciliation action';
    END IF;
    PERFORM scope FROM realtime_revisions WHERE scope IN
        ('transfers:'||header.origin_location_id,'transfers:'||header.destination_location_id) ORDER BY scope FOR UPDATE;
    FOR audience IN SELECT scope FROM realtime_revisions WHERE scope IN
        ('transfers:'||header.origin_location_id,'transfers:'||header.destination_location_id) ORDER BY scope LOOP
        UPDATE realtime_revisions SET revision=revision+1 WHERE scope=audience;
        PERFORM pg_notify('luson_realtime',audience);
    END LOOP;
    RETURN NEW;
END;
$$;
CREATE TRIGGER apply_dispatch_operation BEFORE INSERT ON transfer_dispatch_operations
FOR EACH ROW EXECUTE FUNCTION apply_transfer_dispatch_operation();

CREATE FUNCTION guard_transfer_dispatch_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth()<>2 OR NOT EXISTS (
        SELECT 1 FROM transfer_dispatch_operations o
        JOIN transfer_dispatch_decisions d ON d.operation_key=o.operation_key
        JOIN transfer_dispatch_proposals p ON (p.request_id,p.variant_id,p.revision)=(o.request_id,o.variant_id,o.revision)
        JOIN transfer_requests h ON h.id=o.request_id
        JOIN inventory_balances src ON src.location_id=h.origin_location_id AND src.variant_id=o.variant_id
        JOIN inventory_balances dst ON dst.location_id=h.destination_location_id AND dst.variant_id=o.variant_id
        WHERE o.operation_key=NEW.operation_key AND o.action='accept' AND d.accepted
        AND (o.request_id,o.variant_id,o.revision)=(NEW.request_id,NEW.variant_id,NEW.revision)
        AND (d.request_id,d.variant_id,d.revision)=(NEW.request_id,NEW.variant_id,NEW.revision)
        AND p.initiator_location_id IN (h.origin_location_id,h.destination_location_id)
        AND o.actor_location_id IN (h.origin_location_id,h.destination_location_id)
        AND o.actor_location_id<>p.initiator_location_id AND d.actor_location_id=o.actor_location_id
        AND NEW.effective_dispatch=p.dispatch_quantity AND p.dispatch_quantity=p.base_actual
        AND NEW.source_delta::numeric=p.base_dispatch::numeric-p.dispatch_quantity
        AND NEW.destination_delta::numeric=p.dispatch_quantity::numeric-p.base_credit
        AND o.source_existing_after::numeric-o.source_existing_before=NEW.source_delta
        AND o.destination_existing_after::numeric-o.destination_existing_before=NEW.destination_delta
        AND src.existing=o.source_existing_after AND dst.existing=o.destination_existing_after
        AND NEW.recorded_at=o.recorded_at AND d.recorded_at=o.recorded_at
    ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reconciliation application requires durable bilateral operation effects';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER guard_dispatch_application BEFORE INSERT ON transfer_dispatch_applications
FOR EACH ROW EXECUTE FUNCTION guard_transfer_dispatch_application();
CREATE FUNCTION record_transfer_dispatch_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.action='accept' THEN
        INSERT INTO transfer_dispatch_applications
        SELECT NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,p.dispatch_quantity,
            p.base_dispatch-p.dispatch_quantity,p.dispatch_quantity-p.base_credit,NEW.recorded_at
        FROM transfer_dispatch_proposals p WHERE p.request_id=NEW.request_id AND p.variant_id=NEW.variant_id AND p.revision=NEW.revision;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER record_dispatch_application AFTER INSERT ON transfer_dispatch_operations
FOR EACH ROW EXECUTE FUNCTION record_transfer_dispatch_application();
CREATE FUNCTION transfer_dispatch_reconcile(request_key bigint,item_key integer,actor_key smallint,retry_key text,
    operation_action text,revision_key bigint,quantity bigint,operation_reason text)
RETURNS transfer_dispatch_operations LANGUAGE plpgsql AS $$
DECLARE header transfer_requests%ROWTYPE; result transfer_dispatch_operations%ROWTYPE;
BEGIN
    IF current_setting('transaction_isolation')<>'read committed' THEN
        RAISE EXCEPTION USING ERRCODE='25000', MESSAGE='Reconciliations require READ COMMITTED';
    END IF;
    PERFORM pg_advisory_xact_lock(714025,1);
    SELECT * INTO header FROM transfer_requests WHERE id=request_key FOR UPDATE;
    IF header.status IS DISTINCT FROM 'received' OR actor_key IS NULL
       OR actor_key NOT IN (header.origin_location_id,header.destination_location_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Reconciliation endpoint unauthorized';
    END IF;
    SELECT * INTO result FROM transfer_dispatch_operations WHERE operation_key=retry_key;
    IF FOUND THEN
        IF (result.request_id,result.variant_id,result.actor_location_id,result.action,result.expected_revision,result.dispatch_quantity,result.reason)
            IS DISTINCT FROM (request_key,item_key,actor_key,operation_action,revision_key,quantity,operation_reason) THEN
            RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Reconciliation operation identity conflicts';
        END IF;
        RETURN result;
    END IF;
    INSERT INTO transfer_dispatch_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,dispatch_quantity,reason)
    VALUES(retry_key,request_key,item_key,actor_key,operation_action,revision_key,quantity,operation_reason) RETURNING * INTO result;
    RETURN result;
END;
$$;

-- Replace the implementation, not historical migrations or receipt evidence.
-- Existing entrypoints, immutable operation identities and error mappings remain.
CREATE OR REPLACE FUNCTION apply_transfer_count_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header transfer_requests%ROWTYPE;
    receipt transfer_receipt_lines%ROWTYPE;
    latest transfer_count_proposals%ROWTYPE;
    pin transfer_count_reconciliation_pins%ROWTYPE;
    state record;
    credit bigint;
    difference bigint;
    balance inventory_balances%ROWTYPE;
    audience text;
BEGIN
    SELECT * INTO header FROM transfer_requests WHERE id=NEW.request_id FOR UPDATE;
    IF header.status IS DISTINCT FROM 'received' OR NEW.actor_location_id IS NULL
       OR NEW.actor_location_id NOT IN (header.origin_location_id,header.destination_location_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Correction requires a physical endpoint of a received transfer';
    END IF;
    IF EXISTS (SELECT 1 FROM transfer_count_operations WHERE operation_key=NEW.operation_key) THEN
        RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Use correction entrypoint for durable replay';
    END IF;
    SELECT * INTO receipt FROM transfer_receipt_lines WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Correction requires persisted receipt membership';
    END IF;
    SELECT * INTO latest FROM transfer_count_proposals WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id ORDER BY revision DESC LIMIT 1;
    IF NEW.expected_revision IS DISTINCT FROM COALESCE(latest.revision,0) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Stale correction revision';
    END IF;
    SELECT * INTO STRICT state FROM transfer_effective_line(NEW.request_id,NEW.variant_id);
    NEW.recorded_at:=statement_timestamp();
    IF NEW.action='propose' THEN
        IF NEW.actual_quantity IS NULL OR NEW.actual_quantity<0 THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Corrected count must be nonnegative';
        END IF;
        IF latest.revision IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transfer_count_decisions
            WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id AND revision=latest.revision)
            AND latest.initiator_location_id<>NEW.actor_location_id THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only initiator may replace a pending proposal';
        END IF;
        NEW.revision:=COALESCE(latest.revision,0)+1;
        INSERT INTO transfer_count_proposals VALUES
            (NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,NEW.actor_location_id,
             NEW.actual_quantity,state.count_revision,state.credit,NEW.reason,NEW.recorded_at);
    ELSIF NEW.action IN ('accept','reject') THEN
        IF latest.revision IS NULL OR latest.initiator_location_id=NEW.actor_location_id THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only exact counterparty may decide';
        END IF;
        IF NEW.actual_quantity IS NOT NULL OR EXISTS (SELECT 1 FROM transfer_count_decisions
            WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id AND revision=latest.revision) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Decision revision is terminal or payload invalid';
        END IF;
        NEW.revision:=latest.revision;
        INSERT INTO transfer_count_decisions VALUES
            (NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,NEW.actor_location_id,NEW.action='accept',NEW.reason,NEW.recorded_at);
        IF NEW.action='accept' THEN
            SELECT * INTO pin FROM transfer_count_reconciliation_pins
            WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id AND revision=latest.revision;
            IF (latest.base_revision,latest.base_credit,COALESCE(pin.reconciliation_generation,0),
                COALESCE(pin.effective_dispatch,receipt.expected_quantity))
                IS DISTINCT FROM (state.count_revision,state.credit,state.reconciliation_generation,state.dispatch)
                OR (pin.revision IS NOT NULL AND pin.restitution_generation<>state.restitution_generation) THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Correction predecessor changed';
            END IF;
            credit:=LEAST(state.dispatch,latest.actual_quantity);
            difference:=credit-state.credit;
            IF difference<>0 THEN
                SELECT * INTO balance FROM inventory_balances WHERE location_id=header.destination_location_id
                AND variant_id=NEW.variant_id ORDER BY variant_id FOR UPDATE;
                IF NOT FOUND OR balance.existing<balance.reserved OR balance.existing::numeric+difference>9223372036854775807
                   OR balance.existing::numeric+difference<balance.reserved
                   OR balance.reserved::numeric<(SELECT COALESCE(sum(quantity),0) FROM transfer_request_allocations
                       WHERE origin_location_id=header.destination_location_id AND variant_id=NEW.variant_id
                       AND consumed_at IS NULL AND released_at IS NULL) THEN
                    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Correction requires covered nonoverflowing destination stock';
                END IF;
                UPDATE inventory_balances SET existing=existing+difference WHERE location_id=header.destination_location_id AND variant_id=NEW.variant_id;
            END IF;
            INSERT INTO transfer_count_applications VALUES (NEW.request_id,NEW.variant_id,NEW.revision,credit,difference,NEW.recorded_at);
        END IF;
    ELSE
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Invalid correction action';
    END IF;
    PERFORM scope FROM realtime_revisions WHERE scope IN
        ('transfers:'||header.origin_location_id,'transfers:'||header.destination_location_id) ORDER BY scope FOR UPDATE;
    FOR audience IN SELECT scope FROM realtime_revisions WHERE scope IN
        ('transfers:'||header.origin_location_id,'transfers:'||header.destination_location_id) ORDER BY scope LOOP
        UPDATE realtime_revisions SET revision=revision+1 WHERE scope=audience;
        PERFORM pg_notify('luson_realtime',audience);
    END LOOP;
    RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION guard_count_restitution_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state record;
BEGIN
    PERFORM pg_advisory_xact_lock(714025,1);
    PERFORM id FROM transfer_requests WHERE id=NEW.request_id FOR UPDATE;
    SELECT * INTO state FROM transfer_effective_line(NEW.request_id,NEW.variant_id);
    IF state.dispatch IS NULL OR state.restored>state.dispatch OR NEW.effective_credit>state.dispatch-state.restored THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Correction exceeds debit after restitution';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION apply_restitution_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header transfer_requests%ROWTYPE;
    receipt transfer_receipt_lines%ROWTYPE;
    latest transfer_restitution_proposals%ROWTYPE;
    count_head transfer_count_proposals%ROWTYPE;
    pin transfer_restitution_reconciliation_pins%ROWTYPE;
    state record;
    balance inventory_balances%ROWTYPE;
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
    SELECT * INTO receipt FROM transfer_receipt_lines WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id;
    IF NOT FOUND OR receipt.expected_quantity<=0 THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution requires an expected received line';
    END IF;
    SELECT * INTO latest FROM transfer_restitution_proposals WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id ORDER BY revision DESC LIMIT 1;
    IF NEW.expected_revision IS DISTINCT FROM COALESCE(latest.revision,0) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Stale restitution revision';
    END IF;
    SELECT * INTO count_head FROM transfer_count_proposals WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id ORDER BY revision DESC LIMIT 1;
    SELECT * INTO STRICT state FROM transfer_effective_line(NEW.request_id,NEW.variant_id);
    IF NEW.action IN ('propose','accept') AND count_head.revision IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM transfer_count_decisions WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id AND revision=count_head.revision) THEN
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
        IF state.restored<>0 THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution already applied';
        END IF;
        IF state.credit>state.dispatch OR state.restored>state.dispatch-state.credit
           OR NEW.retained_quantity>state.dispatch-state.credit-state.restored THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution exceeds outstanding debit';
        END IF;
        NEW.revision:=COALESCE(latest.revision,0)+1;
        INSERT INTO transfer_restitution_proposals VALUES
            (NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,NEW.actor_location_id,
             NEW.retained_quantity,true,NEW.expected_revision,state.count_generation,state.count_revision,state.credit,state.restored,NEW.reason,NEW.recorded_at);
    ELSIF NEW.action IN ('accept','reject') THEN
        IF NEW.actor_location_id<>header.destination_location_id OR latest.revision IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only exact destination may decide restitution';
        END IF;
        IF NEW.retained_quantity IS NOT NULL OR NEW.retained_at_origin IS NOT NULL OR EXISTS (
            SELECT 1 FROM transfer_restitution_decisions WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id AND revision=latest.revision) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution decision is terminal or payload invalid';
        END IF;
        NEW.revision:=latest.revision;
        IF NEW.action='accept' THEN
            SELECT * INTO pin FROM transfer_restitution_reconciliation_pins WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id AND revision=latest.revision;
            IF (latest.base_revision,latest.count_generation,latest.count_applied_revision,latest.base_credit,latest.base_restitution,
                COALESCE(pin.reconciliation_generation,0),COALESCE(pin.effective_dispatch,receipt.expected_quantity))
               IS DISTINCT FROM (latest.revision-1,state.count_generation,state.count_revision,state.credit,state.restored,state.reconciliation_generation,state.dispatch) THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution predecessor changed';
            END IF;
            IF state.restored<>0 THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution already applied';
            END IF;
            IF state.credit>state.dispatch OR state.restored>state.dispatch-state.credit
               OR latest.retained_quantity>state.dispatch-state.credit-state.restored THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution exceeds outstanding debit';
            END IF;
            SELECT * INTO balance FROM inventory_balances WHERE location_id=header.origin_location_id AND variant_id=NEW.variant_id ORDER BY variant_id FOR UPDATE;
            IF NOT FOUND OR balance.existing<balance.reserved OR balance.existing::numeric+latest.retained_quantity>9223372036854775807
               OR balance.existing::numeric+latest.retained_quantity<balance.reserved
               OR balance.reserved::numeric<(SELECT COALESCE(sum(quantity),0) FROM transfer_request_allocations
                   WHERE origin_location_id=header.origin_location_id AND variant_id=NEW.variant_id
                   AND consumed_at IS NULL AND released_at IS NULL) THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Restitution requires covered nonoverflowing origin stock';
            END IF;
            NEW.source_existing_before:=balance.existing;
            NEW.source_existing_after:=balance.existing+latest.retained_quantity;
            UPDATE inventory_balances SET existing=NEW.source_existing_after WHERE location_id=header.origin_location_id AND variant_id=NEW.variant_id;
        END IF;
        INSERT INTO transfer_restitution_decisions VALUES
            (NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,NEW.actor_location_id,NEW.action='accept',NEW.reason,NEW.recorded_at);
    ELSE
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Invalid restitution action';
    END IF;
    PERFORM scope FROM realtime_revisions WHERE scope IN
        ('transfers:'||header.origin_location_id,'transfers:'||header.destination_location_id) ORDER BY scope FOR UPDATE;
    FOR audience IN SELECT scope FROM realtime_revisions WHERE scope IN
        ('transfers:'||header.origin_location_id,'transfers:'||header.destination_location_id) ORDER BY scope LOOP
        UPDATE realtime_revisions SET revision=revision+1 WHERE scope=audience;
        PERFORM pg_notify('luson_realtime',audience);
    END LOOP;
    RETURN NEW;
END;
$$;
