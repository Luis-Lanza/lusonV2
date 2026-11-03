-- Expected variants only. Original receipt and all legacy consent remain immutable.
CREATE TABLE transfer_unified_operations (
 operation_key text PRIMARY KEY CHECK (operation_key ~ '^[A-Za-z0-9_-]{16,128}$'),
 request_id bigint NOT NULL,
 variant_id integer NOT NULL,
 actor_location_id smallint NOT NULL REFERENCES locations,
 action text NOT NULL CHECK (action IN ('propose','accept','reject')),
 expected_revision bigint NOT NULL CHECK (expected_revision>=0),
 dispatch_quantity bigint,
 arrival_quantity bigint,
 retained_quantity bigint,
 retained_at_origin boolean NOT NULL,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 revision bigint NOT NULL CHECK (revision>0),
 source_existing_before bigint,
 source_existing_after bigint,
 destination_existing_before bigint,
 destination_existing_after bigint,
 recorded_at timestamptz NOT NULL,
 FOREIGN KEY(request_id,variant_id) REFERENCES transfer_receipt_lines,
 CHECK ((action='propose' AND dispatch_quantity>=0 AND dispatch_quantity IS NOT NULL
   AND arrival_quantity>=0 AND arrival_quantity IS NOT NULL AND retained_quantity>=0 AND retained_quantity IS NOT NULL)
   OR (action<>'propose' AND dispatch_quantity IS NULL AND arrival_quantity IS NULL AND retained_quantity IS NULL)),
 CHECK ((action='accept' AND source_existing_before IS NOT NULL AND source_existing_after IS NOT NULL
   AND destination_existing_before IS NOT NULL AND destination_existing_after IS NOT NULL)
   OR (action<>'accept' AND source_existing_before IS NULL AND source_existing_after IS NULL
   AND destination_existing_before IS NULL AND destination_existing_after IS NULL))
);
CREATE TABLE transfer_unified_proposals (
 request_id bigint NOT NULL,
 variant_id integer NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),
 operation_key text NOT NULL UNIQUE REFERENCES transfer_unified_operations DEFERRABLE INITIALLY DEFERRED,
 initiator_location_id smallint NOT NULL REFERENCES locations,
 dispatch_quantity bigint NOT NULL CHECK(dispatch_quantity>=0),
 arrival_quantity bigint NOT NULL CHECK(arrival_quantity>=0),
 retained_quantity bigint NOT NULL CHECK(retained_quantity>=0),
 retained_at_origin boolean NOT NULL,
 base_source_debit bigint NOT NULL CHECK(base_source_debit>=0),
 base_destination_credit bigint NOT NULL CHECK(base_destination_credit>=0),
 count_generation bigint NOT NULL,
 restitution_generation bigint NOT NULL,
 reconciliation_generation bigint NOT NULL,
 unified_generation bigint NOT NULL,
 reason text NOT NULL,
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(request_id,variant_id,revision),
 FOREIGN KEY(request_id,variant_id) REFERENCES transfer_receipt_lines
);
CREATE TABLE transfer_unified_decisions (
 request_id bigint NOT NULL,
 variant_id integer NOT NULL,
 revision bigint NOT NULL,
 operation_key text NOT NULL UNIQUE REFERENCES transfer_unified_operations DEFERRABLE INITIALLY DEFERRED,
 actor_location_id smallint NOT NULL REFERENCES locations,
 accepted boolean NOT NULL,
 retained_at_origin boolean NOT NULL,
 reason text NOT NULL,
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(request_id,variant_id,revision),
 FOREIGN KEY(request_id,variant_id,revision) REFERENCES transfer_unified_proposals
);
CREATE TABLE transfer_unified_applications (
 request_id bigint NOT NULL,
 variant_id integer NOT NULL,
 revision bigint NOT NULL,
 operation_key text NOT NULL UNIQUE REFERENCES transfer_unified_operations,
 source_delta bigint NOT NULL,
 destination_delta bigint NOT NULL,
 PRIMARY KEY(request_id,variant_id,revision),
 FOREIGN KEY(request_id,variant_id,revision) REFERENCES transfer_unified_decisions
);

CREATE FUNCTION transfer_unified_owned(request_key bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM transfer_unified_proposals WHERE request_id=request_key)
$$;

-- transfer_effective_line retains its legacy meaning. Unified accounting has
-- a separate reader; historical evidence is never presented as live state.
CREATE FUNCTION transfer_unified_accounting(e bigint,d bigint,a bigint,r bigint,s bigint,c bigint)
RETURNS TABLE(target_source_debit bigint,target_destination_credit bigint,source_delta bigint,
 destination_delta bigint,origin_unknown bigint,transit_unknown bigint,excess bigint)
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF e<0 OR d<0 OR a<0 OR r<0 OR s<0 OR c<0 OR r>greatest(e-d,0)
    OR e IS NULL OR d IS NULL OR a IS NULL OR r IS NULL OR s IS NULL OR c IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Invalid unified quantities';
 END IF;
 -- Exact counterpart of CalculateUnifiedAccounting; no addition or float cast.
 target_source_debit:=greatest(e,d)-r;
 target_destination_credit:=least(d,a);
 source_delta:=s-target_source_debit;
 destination_delta:=target_destination_credit-c;
 origin_unknown:=greatest(e-d,0)-r;
 transit_unknown:=greatest(d-a,0);
 excess:=greatest(a-d,0);
 RETURN NEXT;
END;
$$;

CREATE FUNCTION transfer_unified_line(request_key bigint,item_key integer)
RETURNS TABLE(dispatch bigint,actual bigint,credit bigint,source_debit bigint,
 retained bigint,origin_unknown bigint,transit_unknown bigint,excess bigint,
 applied_revision bigint,unified_generation bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE receipt transfer_receipt_lines%ROWTYPE; legacy record; proposal transfer_unified_proposals%ROWTYPE;
 total numeric;
BEGIN
 SELECT * INTO receipt FROM transfer_receipt_lines WHERE request_id=request_key AND variant_id=item_key;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO STRICT legacy FROM transfer_effective_line(request_key,item_key);
 SELECT receipt.expected_quantity::numeric
  - COALESCE((SELECT sum(quantity::numeric) FROM transfer_restitution_applications WHERE request_id=request_key AND variant_id=item_key),0)
  - COALESCE((SELECT sum(source_delta::numeric) FROM transfer_dispatch_applications WHERE request_id=request_key AND variant_id=item_key),0)
  - COALESCE((SELECT sum(source_delta::numeric) FROM transfer_unified_applications WHERE request_id=request_key AND variant_id=item_key),0)
 INTO total;
 IF total<0 OR total>9223372036854775807 THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Unified source ledger outside bigint bounds';
 END IF;
 source_debit:=total::bigint;
 SELECT legacy.credit::numeric + COALESCE(sum(destination_delta::numeric),0) INTO total
 FROM transfer_unified_applications WHERE request_id=request_key AND variant_id=item_key;
 IF total<0 OR total>9223372036854775807 THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Unified destination ledger outside bigint bounds';
 END IF;
 credit:=total::bigint;
 SELECT COALESCE(max(revision),0) INTO applied_revision FROM transfer_unified_applications
 WHERE request_id=request_key AND variant_id=item_key;
 SELECT * INTO proposal FROM transfer_unified_proposals
 WHERE request_id=request_key AND variant_id=item_key AND revision=applied_revision;
 dispatch:=COALESCE(proposal.dispatch_quantity,legacy.dispatch);
 actual:=COALESCE(proposal.arrival_quantity,legacy.actual);
 retained:=COALESCE(proposal.retained_quantity,legacy.restored);
 origin_unknown:=greatest(receipt.expected_quantity-dispatch,0)-COALESCE(proposal.retained_quantity,0);
 transit_unknown:=greatest(dispatch-actual,0);
 excess:=greatest(actual-dispatch,0);
 SELECT count(*) INTO unified_generation FROM transfer_unified_operations WHERE request_id=request_key AND variant_id=item_key;
 RETURN NEXT;
END;
$$;

-- Entrypoint replay precedes INSERT, so these guards never block exact old
-- retries. Rejection remains available even after ownership/staleness changes.
CREATE FUNCTION fence_legacy_unified_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.action<>'reject' AND EXISTS (SELECT 1 FROM transfer_unified_proposals
   WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE=CASE TG_TABLE_NAME
   WHEN 'transfer_count_operations' THEN 'Correction predecessor changed'
   WHEN 'transfer_restitution_operations' THEN 'Restitution predecessor changed'
   ELSE 'Reconciliation predecessor changed' END;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER admit_unified_ownership BEFORE INSERT ON transfer_count_operations
FOR EACH ROW EXECUTE FUNCTION fence_legacy_unified_ownership();
CREATE TRIGGER admit_unified_ownership BEFORE INSERT ON transfer_restitution_operations
FOR EACH ROW EXECUTE FUNCTION fence_legacy_unified_ownership();
CREATE TRIGGER admit_unified_ownership BEFORE INSERT ON transfer_dispatch_operations
FOR EACH ROW EXECUTE FUNCTION fence_legacy_unified_ownership();

CREATE TRIGGER lock_unified_operations BEFORE INSERT ON transfer_unified_operations
FOR EACH STATEMENT EXECUTE FUNCTION lock_transfer_reservation_integrity();
CREATE TRIGGER admit_active_participants BEFORE INSERT ON transfer_unified_operations
FOR EACH ROW EXECUTE FUNCTION admit_active_transfer_participants();
CREATE TRIGGER admit_unified_proposal BEFORE INSERT ON transfer_unified_proposals
FOR EACH ROW EXECUTE FUNCTION admit_transfer_count_evidence();
CREATE TRIGGER admit_unified_decision BEFORE INSERT ON transfer_unified_decisions
FOR EACH ROW EXECUTE FUNCTION admit_transfer_count_evidence();

CREATE FUNCTION apply_transfer_unified_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE header transfer_requests%ROWTYPE; receipt transfer_receipt_lines%ROWTYPE;
 latest transfer_unified_proposals%ROWTYPE; state record; legacy record; plan record;
 balance inventory_balances%ROWTYPE; difference bigint; locked integer:=0; audience text;
BEGIN
 SELECT * INTO header FROM transfer_requests WHERE id=NEW.request_id FOR UPDATE;
 IF header.status IS DISTINCT FROM 'received' OR NEW.actor_location_id IS NULL
    OR NEW.actor_location_id NOT IN(header.origin_location_id,header.destination_location_id) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Unified endpoint unauthorized';
 END IF;
 IF EXISTS(SELECT 1 FROM transfer_unified_operations WHERE operation_key=NEW.operation_key) THEN
  RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Use unified entrypoint for durable replay';
 END IF;
 SELECT * INTO receipt FROM transfer_receipt_lines WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id;
 IF NOT FOUND OR receipt.expected_quantity<=0 THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Unified requires originally expected variant';
 END IF;
 SELECT * INTO STRICT state FROM transfer_unified_line(NEW.request_id,NEW.variant_id);
 SELECT * INTO STRICT legacy FROM transfer_effective_line(NEW.request_id,NEW.variant_id);
 SELECT * INTO latest FROM transfer_unified_proposals WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id ORDER BY revision DESC LIMIT 1;
 IF NEW.expected_revision IS DISTINCT FROM COALESCE(latest.revision,0) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Stale unified revision';
 END IF;
 NEW.recorded_at:=statement_timestamp();
 NEW.source_existing_before:=NULL; NEW.source_existing_after:=NULL;
 NEW.destination_existing_before:=NULL; NEW.destination_existing_after:=NULL;
 IF NEW.action='propose' THEN
  SELECT * INTO STRICT plan FROM transfer_unified_accounting(receipt.expected_quantity,
   NEW.dispatch_quantity,NEW.arrival_quantity,NEW.retained_quantity,state.source_debit,state.credit);
  IF NEW.retained_at_origin AND NEW.actor_location_id<>header.origin_location_id THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only unified origin may attest';
  END IF;
  IF NEW.retained_quantity>0 AND NEW.actor_location_id=header.origin_location_id AND NOT NEW.retained_at_origin THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Unified retention requires origin attestation';
  END IF;
  IF latest.revision IS NOT NULL AND latest.initiator_location_id<>NEW.actor_location_id
     AND NOT EXISTS(SELECT 1 FROM transfer_unified_decisions WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id AND revision=latest.revision) THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only unified initiator may replace';
  END IF;
  NEW.revision:=COALESCE(latest.revision,0)+1;
  INSERT INTO transfer_unified_proposals VALUES(NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,
   NEW.actor_location_id,NEW.dispatch_quantity,NEW.arrival_quantity,NEW.retained_quantity,NEW.retained_at_origin,
   state.source_debit,state.credit,legacy.count_generation,legacy.restitution_generation,
   legacy.reconciliation_generation,state.unified_generation,NEW.reason,NEW.recorded_at);
 ELSIF NEW.action IN('accept','reject') THEN
  IF latest.revision IS NULL OR latest.initiator_location_id=NEW.actor_location_id THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only unified counterparty may decide';
  END IF;
  IF NEW.dispatch_quantity IS NOT NULL OR NEW.arrival_quantity IS NOT NULL OR NEW.retained_quantity IS NOT NULL
     OR EXISTS(SELECT 1 FROM transfer_unified_decisions WHERE request_id=NEW.request_id AND variant_id=NEW.variant_id AND revision=latest.revision) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Unified decision terminal or invalid';
  END IF;
  IF NEW.retained_at_origin AND (NEW.action<>'accept' OR NEW.actor_location_id<>header.origin_location_id) THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only unified origin may attest';
  END IF;
  NEW.revision:=latest.revision;
  IF NEW.action='accept' THEN
   IF (latest.base_source_debit,latest.base_destination_credit,latest.count_generation,
       latest.restitution_generation,latest.reconciliation_generation,latest.unified_generation+1)
      IS DISTINCT FROM(state.source_debit,state.credit,legacy.count_generation,
       legacy.restitution_generation,legacy.reconciliation_generation,state.unified_generation) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Unified predecessor changed';
   END IF;
   IF latest.retained_quantity>0 AND NOT (
      (latest.initiator_location_id=header.origin_location_id AND latest.retained_at_origin)
      OR (NEW.actor_location_id=header.origin_location_id AND NEW.retained_at_origin)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Unified retention requires origin attestation';
   END IF;
   SELECT * INTO STRICT plan FROM transfer_unified_accounting(receipt.expected_quantity,
    latest.dispatch_quantity,latest.arrival_quantity,latest.retained_quantity,state.source_debit,state.credit);
   -- Existing shared fence precedes the header and both physical endpoint rows.
   -- Validate both, including zero-effect rows, before either inventory update.
   FOR balance IN SELECT * FROM inventory_balances WHERE variant_id=NEW.variant_id
    AND location_id IN(header.origin_location_id,header.destination_location_id)
    ORDER BY location_id,variant_id FOR UPDATE LOOP
    locked:=locked+1;
    difference:=CASE WHEN balance.location_id=header.origin_location_id THEN plan.source_delta ELSE plan.destination_delta END;
    IF balance.existing<balance.reserved OR balance.existing::numeric+difference<balance.reserved
       OR balance.existing::numeric+difference>9223372036854775807
       OR balance.reserved::numeric<(SELECT COALESCE(sum(quantity::numeric),0) FROM transfer_request_allocations
         WHERE origin_location_id=balance.location_id AND variant_id=NEW.variant_id AND consumed_at IS NULL AND released_at IS NULL) THEN
     RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Unified requires covered endpoint stock';
    END IF;
    IF balance.location_id=header.origin_location_id THEN
     NEW.source_existing_before:=balance.existing; NEW.source_existing_after:=balance.existing+plan.source_delta;
    ELSE
     NEW.destination_existing_before:=balance.existing; NEW.destination_existing_after:=balance.existing+plan.destination_delta;
    END IF;
   END LOOP;
   IF locked<>2 THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Unified requires both endpoint balances'; END IF;
   IF plan.source_delta<>0 THEN
    UPDATE inventory_balances SET existing=NEW.source_existing_after WHERE location_id=header.origin_location_id AND variant_id=NEW.variant_id;
   END IF;
   IF plan.destination_delta<>0 THEN
    UPDATE inventory_balances SET existing=NEW.destination_existing_after WHERE location_id=header.destination_location_id AND variant_id=NEW.variant_id;
   END IF;
  END IF;
  INSERT INTO transfer_unified_decisions VALUES(NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,
   NEW.actor_location_id,NEW.action='accept',NEW.retained_at_origin,NEW.reason,NEW.recorded_at);
 ELSE
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Invalid unified action';
 END IF;
 PERFORM scope FROM realtime_revisions WHERE scope IN('transfers:'||header.origin_location_id,'transfers:'||header.destination_location_id) ORDER BY scope FOR UPDATE;
 FOR audience IN SELECT scope FROM realtime_revisions WHERE scope IN('transfers:'||header.origin_location_id,'transfers:'||header.destination_location_id) ORDER BY scope LOOP
  UPDATE realtime_revisions SET revision=revision+1 WHERE scope=audience;
  PERFORM pg_notify('luson_realtime',audience);
 END LOOP;
 RETURN NEW;
END;
$$;
CREATE TRIGGER apply_unified_operation BEFORE INSERT ON transfer_unified_operations
FOR EACH ROW EXECUTE FUNCTION apply_transfer_unified_operation();

CREATE FUNCTION validate_transfer_unified_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid boolean;
BEGIN
 IF TG_TABLE_NAME='transfer_unified_proposals' THEN
  SELECT EXISTS(SELECT 1 FROM transfer_unified_operations o WHERE o.operation_key=NEW.operation_key AND o.action='propose'
   AND (o.request_id,o.variant_id,o.revision,o.actor_location_id,o.dispatch_quantity,o.arrival_quantity,o.retained_quantity,o.retained_at_origin,o.reason,o.recorded_at)
    IS NOT DISTINCT FROM(NEW.request_id,NEW.variant_id,NEW.revision,NEW.initiator_location_id,NEW.dispatch_quantity,NEW.arrival_quantity,NEW.retained_quantity,NEW.retained_at_origin,NEW.reason,NEW.recorded_at)
   AND o.expected_revision=NEW.revision-1) INTO valid;
 ELSE
  SELECT EXISTS(SELECT 1 FROM transfer_unified_operations o WHERE o.operation_key=NEW.operation_key
   AND o.action=CASE WHEN NEW.accepted THEN 'accept' ELSE 'reject' END
   AND (o.request_id,o.variant_id,o.revision,o.actor_location_id,o.retained_at_origin,o.reason,o.recorded_at)
    IS NOT DISTINCT FROM(NEW.request_id,NEW.variant_id,NEW.revision,NEW.actor_location_id,NEW.retained_at_origin,NEW.reason,NEW.recorded_at)
   AND o.expected_revision=NEW.revision) INTO valid;
 END IF;
 IF TG_TABLE_NAME='transfer_unified_decisions' THEN
  valid:=valid AND (NEW.accepted = EXISTS(SELECT 1 FROM transfer_unified_applications a
    WHERE (a.request_id,a.variant_id,a.revision)=(NEW.request_id,NEW.variant_id,NEW.revision)
    AND a.operation_key=NEW.operation_key));
 END IF;
 IF NOT valid THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Unified evidence requires durable consent'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER validate_unified_proposal AFTER INSERT ON transfer_unified_proposals
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_transfer_unified_evidence();
CREATE CONSTRAINT TRIGGER validate_unified_decision AFTER INSERT ON transfer_unified_decisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_transfer_unified_evidence();

CREATE FUNCTION guard_transfer_unified_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF pg_trigger_depth()<>2 OR NOT EXISTS(
  SELECT 1 FROM transfer_unified_operations o
  JOIN transfer_unified_decisions d ON d.operation_key=o.operation_key
  JOIN transfer_unified_proposals p ON (p.request_id,p.variant_id,p.revision)=(o.request_id,o.variant_id,o.revision)
  JOIN transfer_requests h ON h.id=o.request_id
  JOIN transfer_receipt_lines r ON (r.request_id,r.variant_id)=(o.request_id,o.variant_id)
  CROSS JOIN LATERAL transfer_unified_accounting(r.expected_quantity,p.dispatch_quantity,p.arrival_quantity,p.retained_quantity,p.base_source_debit,p.base_destination_credit) plan
  JOIN inventory_balances src ON src.location_id=h.origin_location_id AND src.variant_id=o.variant_id
  JOIN inventory_balances dst ON dst.location_id=h.destination_location_id AND dst.variant_id=o.variant_id
  WHERE o.operation_key=NEW.operation_key AND o.action='accept' AND d.accepted
   AND (o.request_id,o.variant_id,o.revision)=(NEW.request_id,NEW.variant_id,NEW.revision)
   AND (d.request_id,d.variant_id,d.revision)=(NEW.request_id,NEW.variant_id,NEW.revision)
   AND p.initiator_location_id IN(h.origin_location_id,h.destination_location_id)
   AND o.actor_location_id IN(h.origin_location_id,h.destination_location_id)
   AND o.actor_location_id<>p.initiator_location_id AND d.actor_location_id=o.actor_location_id
   AND (p.retained_quantity=0 OR (p.initiator_location_id=h.origin_location_id AND p.retained_at_origin)
     OR (o.actor_location_id=h.origin_location_id AND o.retained_at_origin))
   AND (NEW.source_delta,NEW.destination_delta)=(plan.source_delta,plan.destination_delta)
   AND o.source_existing_after::numeric-o.source_existing_before=NEW.source_delta
   AND o.destination_existing_after::numeric-o.destination_existing_before=NEW.destination_delta
   AND src.existing=o.source_existing_after AND dst.existing=o.destination_existing_after
 ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Unified application requires bilateral effects'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guard_unified_application BEFORE INSERT ON transfer_unified_applications
FOR EACH ROW EXECUTE FUNCTION guard_transfer_unified_application();
CREATE FUNCTION record_transfer_unified_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.action='accept' THEN
  INSERT INTO transfer_unified_applications VALUES(NEW.request_id,NEW.variant_id,NEW.revision,NEW.operation_key,
   NEW.source_existing_after-NEW.source_existing_before,NEW.destination_existing_after-NEW.destination_existing_before);
 END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER record_unified_application AFTER INSERT ON transfer_unified_operations
FOR EACH ROW EXECUTE FUNCTION record_transfer_unified_application();

CREATE FUNCTION transfer_unified_reconcile(request_key bigint,item_key integer,actor_key smallint,retry_key text,
 operation_action text,revision_key bigint,dispatch_key bigint,arrival_key bigint,retained_key bigint,attested boolean,operation_reason text)
RETURNS transfer_unified_operations LANGUAGE plpgsql AS $$
DECLARE header transfer_requests%ROWTYPE; result transfer_unified_operations%ROWTYPE;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='25000', MESSAGE='Unified requires READ COMMITTED';
 END IF;
 PERFORM pg_advisory_xact_lock(714025,1);
 SELECT * INTO header FROM transfer_requests WHERE id=request_key FOR UPDATE;
 IF header.status IS DISTINCT FROM 'received' OR actor_key IS NULL OR actor_key NOT IN(header.origin_location_id,header.destination_location_id) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Unified endpoint unauthorized';
 END IF;
 SELECT * INTO result FROM transfer_unified_operations WHERE operation_key=retry_key;
 IF FOUND THEN
  IF (result.request_id,result.variant_id,result.actor_location_id,result.action,result.expected_revision,
      result.dispatch_quantity,result.arrival_quantity,result.retained_quantity,result.retained_at_origin,result.reason)
    IS DISTINCT FROM(request_key,item_key,actor_key,operation_action,revision_key,dispatch_key,arrival_key,retained_key,attested,operation_reason) THEN
   RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Unified operation identity conflicts';
  END IF;
  RETURN result;
 END IF;
 INSERT INTO transfer_unified_operations(operation_key,request_id,variant_id,actor_location_id,action,
  expected_revision,dispatch_quantity,arrival_quantity,retained_quantity,retained_at_origin,reason)
 VALUES(retry_key,request_key,item_key,actor_key,operation_action,revision_key,dispatch_key,arrival_key,retained_key,attested,operation_reason)
 RETURNING * INTO result;
 RETURN result;
END;
$$;

-- Reuse the existing immutable evidence protection for every new ledger.
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['transfer_unified_operations','transfer_unified_proposals','transfer_unified_decisions','transfer_unified_applications'] LOOP
  EXECUTE format('CREATE TRIGGER protect_unified BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_pending_request()',tab);
  EXECUTE format('CREATE TRIGGER protect_unified_truncate BEFORE TRUNCATE ON %I EXECUTE FUNCTION protect_pending_request()',tab);
 END LOOP;
END $$;
ALTER TABLE transfer_personal_activity DROP CONSTRAINT transfer_personal_activity_category_check;
ALTER TABLE transfer_personal_activity ADD CHECK(category IN('transfer','count','restitution','reconciliation','unified'));
CREATE TRIGGER record_unified_personal_activity AFTER INSERT ON transfer_unified_operations
FOR EACH ROW EXECUTE FUNCTION record_transfer_personal_activity('unified');

-- Preserve retirement policy and include outstanding unified consent. No backfill.
ALTER FUNCTION branch_retirement_blocker(smallint) RENAME TO branch_legacy_retirement_blocker;
CREATE FUNCTION branch_retirement_blocker(branch_id smallint) RETURNS text LANGUAGE plpgsql AS $$
DECLARE blocker text;
BEGIN
 blocker:=branch_legacy_retirement_blocker(branch_id);
 IF blocker IS NOT NULL THEN RETURN blocker; END IF;
 IF EXISTS(SELECT 1 FROM transfer_unified_proposals p JOIN transfer_requests h ON h.id=p.request_id
  WHERE branch_id IN(h.origin_location_id,h.destination_location_id)
   AND NOT EXISTS(SELECT 1 FROM transfer_unified_proposals newer WHERE (newer.request_id,newer.variant_id)=(p.request_id,p.variant_id) AND newer.revision>p.revision)
   AND NOT EXISTS(SELECT 1 FROM transfer_unified_decisions d WHERE (d.request_id,d.variant_id,d.revision)=(p.request_id,p.variant_id,p.revision))) THEN
  RETURN 'operations';
 END IF;
 RETURN NULL;
END;
$$;
