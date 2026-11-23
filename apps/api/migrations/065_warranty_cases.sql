-- Battery warranty cases (T2, S1, S2, S5, S6, S7, S9, S11, S20): the document a battery gets
-- when it leaves service, whether a customer brings it back under warranty or the branch finds
-- it failed in its own shelf, and the journey of that battery to the warehouse, to the factory
-- and back.
--
-- Two doors, one case. A `warranty_claim` is identified by the serial number of a sold unit, so
-- it names the sale and the unit; a `stock_defect` is identified by the variant and the quantity
-- the branch found failed, so it names no sale and no serial. The two shapes are exclusive by
-- constraint, not by convention: a claim without its sale and its serial, a stock defect carrying
-- a serial, and a quantity that is not a positive whole battery are rows the table's own
-- constraints refuse, and a refused row is never stored.
--
-- What the claim is judged against is the sale, and the sale is the database's to read (S2). The
-- seller wrote the serial down (031) and promised a term on that unit; so the claim states the
-- serial and the branch, and this migration resolves the sale and the variant from it, refuses a
-- serial that was never sold (LW002), a unit sold without a term (LW003) and a term that has
-- already run out (LW004). The client never types a sale id: it could only be wrong. A term is
-- counted from the sale's own date, so the promise never restarts (S3 is the same arithmetic).
--
-- Why the loan is its own table and not a column of the case (S5, S6, S7). One case receives one
-- used battery after another: the one lent first may fail, and then the branch lends a second one
-- on the same case instead of opening a new one. So a loan is a row with its own ordinal, its own
-- outcome and its own date, and a case holds as many as it needed. The loan states the model code
-- and the quantity (S5) and never the serial as an identity: used batteries do have serials, but
-- nobody writes them down when lending one, so the serial is free optional text, it is indexed
-- nowhere and it is nobody's key -- two loans of the same model and quantity are two independent
-- rows, exactly as the counter experiences them. The source location is recorded and nothing is
-- moved: a loan may come from the case's branch, from the warehouse or from another branch (S6),
-- it writes no transfer and it changes no inventory_balances, because a used battery is not stock
-- anywhere in this repository (032, 045) and this migration adds no balance of its own (S18).
--
-- Why the events are append-only and the phase is theirs (S9). Every tramo of the journey --
-- received, in transit, at the warehouse, at the factory, resolved, closed -- is a row with its
-- actor, its instant, its note and, when the tramo is the factory shipment, the file number the
-- warehouse transcribes by hand. The rows are never updated and never deleted, so the history of
-- a case cannot be rewritten; the phase stored on the case is not a second authority but a copy
-- of the last event, written by the event's own trigger, and a direct UPDATE of it is refused
-- (LW009). A transition that enters the phase the case already holds is not a transition and is
-- refused too (LW006), with nothing written.
--
-- What a case is about is frozen (LW010): the branch, its correlative, the origin, the sale, the
-- variant, the serial, the quantity, the declared failure and the actor who opened it never
-- change. What moves is the phase, through its events, and the resolution the warehouse and the
-- factory reach: the verdict and the destination of each of the three units of the case -- the
-- reported battery, the lent one and, on a stock defect, the shelf it left (S11). The verdict and
-- the destinations are vocabularies frozen here (S23) and the matrix that relates them is the
-- store's (T4): the database refuses a value outside the lists and states that the stock has a
-- destination only on a `stock_defect`, because a claim never had branch stock in play.
--
-- What this file does not decide. The notice the receiving branch registers and the release of a
-- unit to sellable stock are tramos of this same history -- they carry their actor, their instant
-- and their motive in the note -- but the order that gates one with the other, the actors each one
-- may use (S19) and the resolution matrix of the verdicts are the store's (T4, T5), because S23
-- froze no event kind and no matrix to hang them on here.
--
-- Numeration (S20). A case has its own number per branch, allocated by this file from that
-- branch's own history under the branch row lock, exactly like a sale's correlative (025), so two
-- branches never share one. It is a number of its own and not the warranty numbering: it is stated
-- with the `C-` of the case, it runs on its own sequence, and the first case of a branch therefore
-- never reads like that branch's first warranty. The number is stored twice on purpose, the
-- sequence the branch keeps and the printed form `C-2-000001`, both unique inside the branch,
-- because the receipt of the loan prints it and the history sorts by it (S8).
--
-- Nothing here touches an applied migration: this file creates three tables, their indexes, their
-- functions and their triggers, and it rewrites no row of any table that already exists.

-- The case: one battery out of service, its two possible origins, the journey's current phase and
-- the resolution. A case belongs to the branch that owes the client the answer (S19); the
-- warehouse only moves the battery along.
CREATE TABLE warranty_cases (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- The branch that owns the case. Never the warehouse: the warehouse has no client.
    branch_location_id smallint NOT NULL REFERENCES locations(id),
    -- The branch's own correlative, allocated by admit_warranty_case() from this branch's
    -- history: the caller never chooses it. Independent of the warranty numbering of 025.
    branch_sequence bigint NOT NULL DEFAULT 0 CHECK (branch_sequence BETWEEN 1 AND 999999999),
    -- The printed form of the same number, written by the same trigger: the receipt of the loan
    -- and the case history show this one (S8, S20). The `C-` is what tells it apart from the
    -- warranty number of a sale, which is the branch and its own correlative.
    case_number text NOT NULL DEFAULT '' CHECK (case_number ~ '^C-[1-9][0-9]{0,4}-[0-9]{6,12}$'),
    origin text NOT NULL CHECK (origin IN ('warranty_claim','stock_defect')),
    -- A case is born received at its branch and moves only through its own events (S9).
    phase text NOT NULL DEFAULT 'received'
        CHECK (phase IN ('received','in_transit','at_warehouse','at_factory','resolved','closed')),
    -- The resolution the warehouse and the factory reach, stated once and never zero (S11).
    verdict text CHECK (verdict IS NULL OR verdict IN
        ('repaired','replaced','unrepairable','not_covered','lost','refused_at_warehouse')),
    -- Where each unit of the case ends: the reported battery, the lent used one and, on a stock
    -- defect, the branch shelf that is short. A claim has no shelf in play, so it states none.
    reported_destination text CHECK (reported_destination IS NULL OR reported_destination IN
        ('customer','stock','scrap','retained_by_factory')),
    loan_destination text CHECK (loan_destination IS NULL OR loan_destination IN
        ('customer','stock','scrap','retained_by_factory')),
    stock_destination text CHECK (stock_destination IS NULL OR stock_destination IN
        ('customer','stock','scrap','retained_by_factory')),
    -- The claimed sale. Resolved by the trigger from the serial, never typed by the caller, and
    -- null on a stock defect, which was never sold.
    sale_id bigint REFERENCES sales(id),
    -- The variant of the battery: the unit's on a claim, the shelf's on a stock defect.
    variant_id integer NOT NULL REFERENCES catalog_variants(id),
    -- The serial the client read off the battery. Free text written down, exactly like the serial
    -- of a sold unit (031): it is how a claim is recognised, not a stock identity. A later case
    -- for a repaired battery that failed again is legitimate (S7 forbids a second case for the
    -- same claim, which the store owns), so this column is indexed and not unique.
    serial_number text CHECK (serial_number IS NULL
        OR char_length(btrim(serial_number)) BETWEEN 1 AND 64),
    -- How many batteries of that shelf the branch found failed. Whole batteries, never zero.
    quantity bigint CHECK (quantity IS NULL OR quantity BETWEEN 1 AND 1000000),
    -- What failed, in the words of whoever registered the case.
    declared_failure text NOT NULL CHECK (char_length(btrim(declared_failure)) BETWEEN 1 AND 500),
    created_by_account_id integer NOT NULL REFERENCES auth_accounts(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- A correlative and a case number are unique inside their branch, so two branches never share
    -- either numeration (S20).
    UNIQUE (branch_location_id, branch_sequence),
    UNIQUE (case_number),
    -- A claimed sale and its variant are one persisted line of that sale.
    FOREIGN KEY (sale_id, variant_id) REFERENCES sale_lines(sale_id, variant_id),
    -- The two entry doors are exclusive: a claim names its sale and its serial and no quantity, a
    -- stock defect names its positive quantity and neither a sale nor a serial (S1).
    CHECK ((origin = 'warranty_claim'
            AND sale_id IS NOT NULL AND serial_number IS NOT NULL AND quantity IS NULL)
        OR (origin = 'stock_defect'
            AND sale_id IS NULL AND serial_number IS NULL AND quantity IS NOT NULL)),
    -- Only a stock defect has a shelf in play (S11).
    CHECK (stock_destination IS NULL OR origin = 'stock_defect')
);

-- The tray of one branch is read newest first, and the warehouse desk reads the cases of one
-- phase, oldest first, because a case is never closed by a date (S15).
CREATE INDEX warranty_cases_branch_history ON warranty_cases(branch_location_id, id DESC);
CREATE INDEX warranty_cases_phase_queue ON warranty_cases(phase, id);
-- The history of one battery is read by the serial the client brought (S2, S20).
CREATE INDEX warranty_cases_claimed_serial ON warranty_cases(upper(btrim(serial_number)))
WHERE serial_number IS NOT NULL;

-- One used battery lent on one case (S5, S6, S7). The loan states a model code and a quantity and
-- identifies no physical battery: the serial is optional free text that nobody keys on.
CREATE TABLE warranty_case_loans (
    case_id bigint NOT NULL REFERENCES warranty_cases(id),
    -- 1..n inside its own case, allocated by admit_warranty_case_loan(): the first loan of a case
    -- is 1 and a failed one is followed by 2 on the same case, never by a new case (S7). The
    -- placeholder default is overwritten before any check runs, exactly like a sale's correlative.
    loan_ordinal integer NOT NULL DEFAULT 0 CHECK (loan_ordinal BETWEEN 1 AND 100),
    -- The used battery's model code, written with the same frozen pattern 032 and 045 store
    -- (033 widened it for the comma of the catalogue). The caller trims and upper-cases it.
    model text NOT NULL CHECK (model ~ '^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$'),
    quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
    -- What the counter may have written on the receipt of some batteries and never on others: it
    -- is optional, it is free text, it is unique nowhere and it keys nothing (S5).
    serial_number text NOT NULL DEFAULT '' CHECK (char_length(serial_number) <= 64),
    -- Where the battery was taken from: the case's branch, the warehouse or another branch (S6).
    -- This column moves no stock and writes no transfer.
    source_location_id smallint NOT NULL REFERENCES locations(id),
    given_at timestamptz NOT NULL DEFAULT now(),
    -- What became of this loan. `failed` is the one that is replaced by another loan of the same
    -- case, and a fate once decided is final (LW012).
    fate text NOT NULL DEFAULT 'open'
        CHECK (fate IN ('open','returned','kept_by_customer','failed','lost')),
    given_by_account_id integer NOT NULL REFERENCES auth_accounts(id),
    PRIMARY KEY (case_id, loan_ordinal)
);

-- The loans of one window are what the used pool of the settlement reads (S17), and the loans of
-- one source are what a branch or the warehouse reviews.
CREATE INDEX warranty_case_loans_by_given_at ON warranty_case_loans(given_at DESC);
CREATE INDEX warranty_case_loans_by_source ON warranty_case_loans(source_location_id, given_at DESC);

-- One tramo of the journey (S9): the phase the case enters, who did it, when, why and -- on the
-- factory shipment -- the file number the warehouse transcribes by hand. Append-only: no UPDATE,
-- no DELETE and no TRUNCATE.
CREATE TABLE warranty_case_events (
    case_id bigint NOT NULL REFERENCES warranty_cases(id),
    -- 1..n inside its own case, allocated by admit_warranty_case_event() under the case lock, so
    -- two warehouses cannot both take the next number of one history.
    event_ordinal integer NOT NULL DEFAULT 0 CHECK (event_ordinal BETWEEN 1 AND 1000),
    -- The phase this tramo enters, from the same frozen list the case states.
    phase text NOT NULL
        CHECK (phase IN ('received','in_transit','at_warehouse','at_factory','resolved','closed')),
    -- The factory's own file number, transcribed by hand when the battery is shipped there. Empty
    -- on every other tramo: a refusal at the warehouse never registers one (LW007).
    factory_case_number text NOT NULL DEFAULT ''
        CHECK (char_length(factory_case_number) <= 200
            AND factory_case_number = btrim(factory_case_number)),
    actor_account_id integer NOT NULL REFERENCES auth_accounts(id),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    -- The reason of the tramo: why the warehouse refused, why the release was authorised, what
    -- the factory answered. Optional, because a movement usually has nothing to explain.
    note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
    PRIMARY KEY (case_id, event_ordinal)
);

-- The history of one case is read whole, in its own order, once per case and once per receipt.
CREATE INDEX warranty_case_events_by_case ON warranty_case_events(case_id, event_ordinal);

-- The branch that owns the case, its correlative and what the case is about are database
-- authority, not a caller promise: the branch row stays locked for the rest of the transaction,
-- so a branch retired concurrently cannot still open a case, and one writer at a time allocates
-- the next number of that branch.
CREATE FUNCTION admit_warranty_case() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    active boolean;
    owner_location smallint;
    owner_enabled boolean;
    next_sequence bigint;
    variant_kind text;
    claimed sale_units%ROWTYPE;
    sold_at timestamptz;
BEGIN
    -- A case is a document of its branch, and of nobody else (S19): the warehouse owns no client
    -- and answers to none, and the account that opens it belongs to the branch that owes the
    -- answer.
    IF TG_OP = 'INSERT' THEN
        IF NEW.branch_location_id <= 1 THEN
            RAISE EXCEPTION USING ERRCODE='LW001',
                MESSAGE='A battery case belongs to a branch: the warehouse never owns one';
        END IF;
        SELECT deleted_at IS NULL INTO active FROM locations
        WHERE id=NEW.branch_location_id FOR UPDATE;
        IF NOT FOUND OR NOT active THEN
            RAISE EXCEPTION USING ERRCODE='LW001',
                MESSAGE='A battery case requires an active branch';
        END IF;
        SELECT location_id,enabled INTO owner_location,owner_enabled
        FROM auth_accounts WHERE id=NEW.created_by_account_id;
        IF NOT FOUND OR NOT owner_enabled
           OR owner_location IS DISTINCT FROM NEW.branch_location_id THEN
            RAISE EXCEPTION USING ERRCODE='LW001',
                MESSAGE='A battery case is opened only by the account of its own branch';
        END IF;
        -- The correlative of this branch, under the row locked above.
        SELECT coalesce(max(case_row.branch_sequence),0)+1 INTO next_sequence
        FROM warranty_cases case_row WHERE case_row.branch_location_id=NEW.branch_location_id;
        IF next_sequence > 999999999 THEN
            RAISE EXCEPTION USING ERRCODE='LW013',
                MESSAGE='Case correlative exhausted for this branch';
        END IF;
        NEW.branch_sequence := next_sequence;
        NEW.case_number := 'C-' || NEW.branch_location_id::text || '-' || lpad(next_sequence::text,6,'0');
        -- A case is born received at its branch, whatever the caller promised: the first tramo is
        -- the counter that took the battery in (S1).
        NEW.phase := 'received';
        NEW.verdict := NULL;
        -- The claim is judged against the sale (S2). The serial is the identity the client
        -- brings, so the sale and the variant are read from it and the caller never states them.
        -- The quantity is not read from anywhere: a claim is one battery, so a claim that states
        -- one is refused by the shape of the row below and never silently corrected.
        IF NEW.origin = 'warranty_claim' THEN
            SELECT unit.* INTO claimed
            FROM sale_units unit
            WHERE upper(btrim(unit.serial_number))=upper(btrim(NEW.serial_number));
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE='LW002',
                    MESSAGE='The claimed serial number was never sold',
                    DETAIL=NEW.serial_number;
            END IF;
            -- A unit sold without a term is a recorded decision, not missing data (031): there is
            -- no coverage to claim against and the claim is not merely early.
            IF claimed.warranty_months IS NULL THEN
                RAISE EXCEPTION USING ERRCODE='LW003',
                    MESSAGE='The claimed unit was sold without a warranty term',
                    DETAIL=NEW.serial_number;
            END IF;
            SELECT sale.created_at INTO sold_at FROM sales sale WHERE sale.id=claimed.sale_id;
            -- A term counts from the sale's own date and never restarts (S3).
            IF sold_at + claimed.warranty_months * interval '1 month' <= now() THEN
                RAISE EXCEPTION USING ERRCODE='LW004',
                    MESSAGE='The warranty term of the claimed unit has expired',
                    DETAIL=NEW.serial_number;
            END IF;
            NEW.sale_id := claimed.sale_id;
            NEW.variant_id := claimed.variant_id;
        END IF;
        -- This vertical is about batteries and about nothing else (a product is counted, never
        -- serialized, and never comes back under warranty), and it is judged after the claim, so
        -- a claim is checked on the variant the sale states and never on the caller's.
        SELECT entry.kind INTO variant_kind
        FROM catalog_variants variant
        JOIN catalog_entries entry ON entry.id=variant.catalog_entry_id
        WHERE variant.id=NEW.variant_id;
        IF variant_kind IS DISTINCT FROM 'battery' THEN
            RAISE EXCEPTION USING ERRCODE='LW005',
                MESSAGE='A battery case names a battery',
                DETAIL=coalesce(NEW.variant_id::text,'');
        END IF;
        RETURN NEW;
    END IF;
    -- From here on the row exists: what the case is about is frozen and the phase moves only
    -- through the events of this very case (LW009, LW010).
    IF NEW.branch_location_id IS DISTINCT FROM OLD.branch_location_id
       OR NEW.branch_sequence IS DISTINCT FROM OLD.branch_sequence
       OR NEW.case_number IS DISTINCT FROM OLD.case_number
       OR NEW.origin IS DISTINCT FROM OLD.origin
       OR NEW.sale_id IS DISTINCT FROM OLD.sale_id
       OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
       OR NEW.serial_number IS DISTINCT FROM OLD.serial_number
       OR NEW.quantity IS DISTINCT FROM OLD.quantity
       OR NEW.declared_failure IS DISTINCT FROM OLD.declared_failure
       OR NEW.created_by_account_id IS DISTINCT FROM OLD.created_by_account_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION USING ERRCODE='LW010',
            MESSAGE='What a battery case is about is frozen',
            DETAIL=OLD.case_number;
    END IF;
    -- The stored phase is a copy of the last event, never a second authority: the marker names
    -- the case whose event is running, and a client statement runs at trigger depth 1 and can
    -- neither reach this depth nor promise the marker (045 proves the same provenance).
    IF NEW.phase IS DISTINCT FROM OLD.phase
       AND (current_setting('luson.warranty_case_event', true) IS DISTINCT FROM NEW.id::text
            OR pg_trigger_depth() < 2) THEN
        RAISE EXCEPTION USING ERRCODE='LW009',
            MESSAGE='A battery case moves phase only with its own event',
            DETAIL=NEW.phase;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_warranty_case BEFORE INSERT OR UPDATE ON warranty_cases
FOR EACH ROW EXECUTE FUNCTION admit_warranty_case();

-- A tramo is judged before it is written, under the lock of its own case so the correlative of
-- the history and the phase it leaves are one writer's at a time. Nothing is written when a
-- transition is refused (S9).
CREATE FUNCTION admit_warranty_case_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header warranty_cases%ROWTYPE;
    next_ordinal integer;
BEGIN
    SELECT * INTO header FROM warranty_cases WHERE id=NEW.case_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LW008',
            MESSAGE='A case event requires a persisted case';
    END IF;
    SELECT coalesce(max(event.event_ordinal),0)+1 INTO next_ordinal
    FROM warranty_case_events event WHERE event.case_id=NEW.case_id;
    IF next_ordinal > 1000 THEN
        RAISE EXCEPTION USING ERRCODE='LW008',
            MESSAGE='A battery case admits at most one thousand events';
    END IF;
    NEW.event_ordinal := next_ordinal;
    -- A tramo that enters the phase the case already holds is not a tramo.
    IF NEW.phase = header.phase THEN
        RAISE EXCEPTION USING ERRCODE='LW006',
            MESSAGE='A case event enters a phase the case is not already in',
            DETAIL=NEW.phase;
    END IF;
    -- The factory file number travels with the factory shipment and with nothing else, so a
    -- refusal at the warehouse can never register one (S9, S10).
    IF (NEW.phase = 'at_factory') <> (btrim(NEW.factory_case_number) <> '') THEN
        RAISE EXCEPTION USING ERRCODE='LW007',
            MESSAGE='The factory shipment carries its file number, and only it',
            DETAIL=NEW.phase;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_warranty_case_event BEFORE INSERT ON warranty_case_events
FOR EACH ROW EXECUTE FUNCTION admit_warranty_case_event();

-- The phase of the case is the phase of its last tramo: this trigger writes the copy, naming the
-- case in the transaction-local marker so the guard of the case admits exactly this one write and
-- refuses every other (LW009).
CREATE FUNCTION advance_warranty_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('luson.warranty_case_event', NEW.case_id::text, true);
    UPDATE warranty_cases SET phase=NEW.phase WHERE id=NEW.case_id;
    PERFORM set_config('luson.warranty_case_event', '', true);
    RETURN NULL;
END;
$$;
CREATE TRIGGER advance_warranty_case AFTER INSERT ON warranty_case_events
FOR EACH ROW EXECUTE FUNCTION advance_warranty_case();

-- The loans of one case are numbered here, under the lock of the case, so two counters lending
-- on one case cannot both take the same ordinal. Nothing else of a loan is derived: the model,
-- the quantity, the source and the actor are the caller's and are frozen once written.
CREATE FUNCTION admit_warranty_case_loan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header warranty_cases%ROWTYPE;
BEGIN
    SELECT * INTO header FROM warranty_cases WHERE id=NEW.case_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LW014',
            MESSAGE='A loan requires a persisted case';
    END IF;
    NEW.loan_ordinal := coalesce((
        SELECT max(loan.loan_ordinal) FROM warranty_case_loans loan
        WHERE loan.case_id=NEW.case_id),0)+1;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_warranty_case_loan BEFORE INSERT ON warranty_case_loans
FOR EACH ROW EXECUTE FUNCTION admit_warranty_case_loan();

-- A loan is what was handed over and where it came from, and only its fate is decided afterwards
-- (S7). Once a fate is decided it is final: a failed used battery is replaced by another loan of
-- the same case, never by rewriting the one that failed.
CREATE FUNCTION guard_warranty_case_loan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.case_id IS DISTINCT FROM OLD.case_id
       OR NEW.loan_ordinal IS DISTINCT FROM OLD.loan_ordinal
       OR NEW.model IS DISTINCT FROM OLD.model
       OR NEW.quantity IS DISTINCT FROM OLD.quantity
       OR NEW.serial_number IS DISTINCT FROM OLD.serial_number
       OR NEW.source_location_id IS DISTINCT FROM OLD.source_location_id
       OR NEW.given_at IS DISTINCT FROM OLD.given_at
       OR NEW.given_by_account_id IS DISTINCT FROM OLD.given_by_account_id THEN
        RAISE EXCEPTION USING ERRCODE='LW011',
            MESSAGE='A loan is frozen: only its fate is decided',
            DETAIL=OLD.case_id::text;
    END IF;
    IF OLD.fate <> 'open' AND NEW.fate IS DISTINCT FROM OLD.fate THEN
        RAISE EXCEPTION USING ERRCODE='LW012',
            MESSAGE='A decided loan fate is final: a failed loan is replaced by another loan',
            DETAIL=OLD.fate;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER guard_warranty_case_loan BEFORE UPDATE ON warranty_case_loans
FOR EACH ROW EXECUTE FUNCTION guard_warranty_case_loan();

-- The history of a case is append-only: a tramo is written once and never corrected, so the
-- events are immutable including TRUNCATE, exactly like the documents this repository already
-- keeps that way.
CREATE TRIGGER protect_warranty_case_events BEFORE UPDATE OR DELETE ON warranty_case_events
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_warranty_case_events_truncate BEFORE TRUNCATE ON warranty_case_events
EXECUTE FUNCTION protect_pending_request();

-- A case is never deleted, not even when it is closed: it is the answer the branch owes the
-- client and the history the client may ask for. It is not frozen, though -- its phase and its
-- resolution move -- so only the removal is guarded here.
CREATE TRIGGER protect_warranty_cases BEFORE DELETE ON warranty_cases
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_warranty_cases_truncate BEFORE TRUNCATE ON warranty_cases
EXECUTE FUNCTION protect_pending_request();

-- A loan is a fact of the counter and is never removed either: a battery was handed over and the
-- receipt of the client says so.
CREATE TRIGGER protect_warranty_case_loans BEFORE DELETE ON warranty_case_loans
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_warranty_case_loans_truncate BEFORE TRUNCATE ON warranty_case_loans
EXECUTE FUNCTION protect_pending_request();
