-- Branch account settlement ("rendición de cuentas"): the warehouse admin visits a
-- branch, freezes it, counts the cash and the stock, settles a commission and leaves
-- a fund for the next period. The period runs from one closed settlement to the next,
-- with a cut date chosen by hand each time.
--
-- The vertical is two migrations. This one is the settlement's own shape:
--
--   tables, indexes, identity, the state machine and immutability.
--
-- Everything that reads or writes another table is 035: seeding the count sheet from
-- the branch's balances, the stock the closure applies, the cash ledger rows and its
-- admission, the freeze predicate and its wiring into the sale, purchase, transfer and
-- reconciliation paths. The split is what makes this file readable as the document's
-- contract: no table of 001-033 is named here.
--
-- Money authority lives here, not in the client:
--   expected cash = opening_cash + cash_sales - cash_expenses   (derived on read)
--   cash difference = counted_cash - expected cash              (derived on read)
--   taken cash = counted_cash + contributed_cash - closing_cash (derived on read)
-- The contribution is money the warehouse puts into the till at the cut, on top of
-- what it counted: it is what makes the first settlement of a branch possible with an
-- empty drawer (S10, L13), and it is recorded as its own ledger fact.
-- The commission is NOT part of any cash identity: it is computed and reported, and
-- paid outside the system. The stock difference, unlike the cash one, cannot survive
-- a closure: closing applies exactly what was counted.
--
-- The offer is the settlement's own fact and it is recorded when the warehouse
-- proposes: the period totals (sales_total, cash_sales, card_total, transfer_total,
-- qr_total) and commission_amount are computed by the database from the immutable
-- sales of the period and the frozen rate, and from then on they are immutable. A
-- rejection hands the settlement back for editing but not the offer, and the closure
-- applies the offer it was accepted with: it never recomputes it (R1-001).
--
-- No new realtime code is required: migration 004 already installs the balance
-- invalidation trigger, so every difference applied by the closure of 035 invalidates
-- the 'inventory' scope inside the same transaction.
CREATE TABLE branch_settings (
    branch_location_id smallint PRIMARY KEY REFERENCES locations(id),
    -- Percentual commission settled to the branch for new batteries sold in a
    -- period. A settlement cannot be proposed for a branch without this value.
    commission_rate_percent numeric(5,2) NOT NULL
        CHECK (commission_rate_percent >= 0 AND commission_rate_percent <= 100),
    updated_by_account_id integer NOT NULL REFERENCES auth_accounts(id),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branch_closings (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    branch_location_id smallint NOT NULL REFERENCES locations(id),
    -- open -> proposed -> (rejected -> proposed)* -> closed. A closed settlement is
    -- never reopened: an error is corrected by an appended correction (036), which
    -- itself needs the branch to accept it.
    status text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','proposed','rejected','closed')),
    -- period_start is the database's own answer: the closure instant of the previous
    -- closed settlement of the same branch, or the cut instant for the first one.
    period_start timestamptz NOT NULL,
    -- The instant the branch stopped operating, taken by the database at open.
    cut_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    -- The rate the settlement pays, read from branch_settings when the warehouse
    -- proposes it (S6). NULL while the settlement is a draft, and frozen from the
    -- proposal on, so changing the configured rate later never alters a proposed or a
    -- closed settlement.
    commission_rate_percent numeric(5,2)
        CHECK (commission_rate_percent >= 0 AND commission_rate_percent <= 100),
    opening_cash numeric(12,2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
    -- Cash the branch took in the period. A draft while the settlement is open, and
    -- from the proposal on it is the database's own reading of the sale payments.
    cash_sales numeric(12,2) NOT NULL DEFAULT 0 CHECK (cash_sales >= 0),
    -- Expenses the warehouse states at the cut: the branch's ledger is read by the
    -- admin, never typed by the client as a period fact.
    cash_expenses numeric(12,2) NOT NULL DEFAULT 0 CHECK (cash_expenses >= 0),
    -- The offer, recorded once by the proposal: the totals of the settled period and
    -- the commission they pay. 035 computes them; nothing rewrites them afterwards.
    sales_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (sales_total >= 0),
    commission_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (commission_amount >= 0),
    card_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (card_total >= 0),
    transfer_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (transfer_total >= 0),
    -- The fourth method (S13) has its own column and its own migration: it is 0 here
    -- so a settlement never reports money it did not classify.
    qr_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (qr_total >= 0),
    counted_cash numeric(12,2) CHECK (counted_cash >= 0),
    -- Money the warehouse puts into the till at the cut, on top of what it counted: the
    -- empty drawer of a branch that starts, the missing part of a fund it declares. A
    -- draft like the other cash fields, and a fact of its own in the ledger at closure.
    contributed_cash numeric(12,2) NOT NULL DEFAULT 0 CHECK (contributed_cash >= 0),
    -- The fund that stays in the branch and opens the next period.
    closing_cash numeric(12,2) CHECK (closing_cash >= 0),
    observation text NOT NULL DEFAULT '' CHECK (char_length(observation) <= 1000),
    opened_by_account_id integer NOT NULL REFERENCES auth_accounts(id),
    CHECK (period_start <= cut_at),
    -- A closure always states the rate it settled, the cash it counted and the fund it
    -- leaves behind, and it can never leave more than the drawer held: the cash counted
    -- plus the contribution the warehouse made.
    CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND commission_rate_percent IS NOT NULL
        AND counted_cash IS NOT NULL AND closing_cash IS NOT NULL
        AND closing_cash <= counted_cash + contributed_cash))
);

-- One live settlement per branch: open, proposed and rejected all keep the branch
-- frozen, so any of them blocks a second one.
CREATE UNIQUE INDEX branch_closings_one_live ON branch_closings(branch_location_id)
WHERE status <> 'closed';
CREATE INDEX branch_closings_by_branch ON branch_closings(branch_location_id, cut_at DESC);

-- One line per variant: the expected snapshot the database had at open, and what the
-- admin counted. A NULL counted_quantity means the variant is still pending, which is
-- what blocks proposing and closing.
CREATE TABLE closing_count_lines (
    closing_id bigint NOT NULL REFERENCES branch_closings(id),
    variant_id integer NOT NULL REFERENCES catalog_variants(id),
    expected_quantity bigint NOT NULL CHECK (expected_quantity >= 0),
    counted_quantity bigint CHECK (counted_quantity >= 0 AND counted_quantity <= 1000000),
    PRIMARY KEY (closing_id, variant_id)
);

-- Cash that moves in and out of the branch till, independent of sales: the branch
-- records small expenses as they happen, and the closure records the transfer between
-- the branch and the warehouse. Immutable: a wrong movement is fixed by its opposite.
-- Its admission is 035 (it reads the settlement and the branch status); the table and
-- its append-only guards are the shape of the ledger and live here.
CREATE TABLE branch_cash_movements (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    branch_location_id smallint NOT NULL REFERENCES locations(id),
    closing_id bigint REFERENCES branch_closings(id),
    -- gasto: paid out by the branch for a small expense.
    -- recaudacion: taken from the branch till by the warehouse.
    -- aporte: put into the branch till by the warehouse (the first settlement).
    kind text NOT NULL CHECK (kind IN ('gasto','recaudacion','aporte')),
    amount numeric(12,2) NOT NULL CHECK (amount > 0),
    description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_by_account_id integer NOT NULL REFERENCES auth_accounts(id)
);
CREATE INDEX branch_cash_movements_by_branch ON branch_cash_movements(branch_location_id, occurred_at);
-- One transfer of each kind per settlement, behind the admission guard: the cash
-- history of a closed settlement never grows.
CREATE UNIQUE INDEX branch_cash_movements_one_transfer ON branch_cash_movements(closing_id, kind)
WHERE kind <> 'gasto';

-- Every round of the proposal is kept: what the warehouse offered, who decided, why
-- it was rejected. Nothing is overwritten, so the branch can always be shown exactly
-- what it accepted.
CREATE TABLE closing_proposals (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    closing_id bigint NOT NULL REFERENCES branch_closings(id),
    round smallint NOT NULL CHECK (round >= 1),
    proposed_payload jsonb NOT NULL,
    proposed_by_account_id integer NOT NULL REFERENCES auth_accounts(id),
    proposed_at timestamptz NOT NULL DEFAULT now(),
    decided_by_account_id integer REFERENCES auth_accounts(id),
    decided_at timestamptz,
    decision text CHECK (decision IN ('accepted','rejected')),
    decision_reason text NOT NULL DEFAULT '' CHECK (char_length(decision_reason) <= 1000),
    UNIQUE (closing_id, round),
    -- A rejection always explains itself; an acceptance never carries a rejection reason.
    CHECK (decision IS DISTINCT FROM 'rejected'
        OR char_length(btrim(decision_reason)) BETWEEN 1 AND 1000),
    CHECK ((decision IS NULL) = (decided_at IS NULL)),
    CHECK (decision IS NULL OR decided_by_account_id IS NOT NULL)
);

-- At most one undecided proposal per settlement: the warehouse waits for the branch.
CREATE UNIQUE INDEX closing_proposals_one_pending ON closing_proposals(closing_id)
WHERE decision IS NULL;

-- Corrections of an already closed settlement. They are appended, never applied in
-- place: the closure keeps its history and the accepted correction states what
-- changed and why.
CREATE TABLE closing_corrections (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    closing_id bigint NOT NULL REFERENCES branch_closings(id),
    status text NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed','accepted','rejected')),
    reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
    payload jsonb NOT NULL,
    proposed_by_account_id integer NOT NULL REFERENCES auth_accounts(id),
    proposed_at timestamptz NOT NULL DEFAULT now(),
    decided_by_account_id integer REFERENCES auth_accounts(id),
    decided_at timestamptz,
    decision_reason text NOT NULL DEFAULT '' CHECK (char_length(decision_reason) <= 1000),
    CHECK ((status = 'proposed') = (decided_at IS NULL)),
    CHECK (status = 'proposed' OR decided_by_account_id IS NOT NULL),
    CHECK (status = 'proposed' OR status = 'accepted'
        OR char_length(btrim(decision_reason)) BETWEEN 1 AND 1000)
);

CREATE UNIQUE INDEX closing_corrections_one_pending ON closing_corrections(closing_id)
WHERE status = 'proposed';

-- Only the warehouse admin opens a settlement, only for a branch that is still
-- operating, and the database decides the cut instant and the period start. The
-- commission rate is not read here: it is a fact of the proposal (S6), so a settlement
-- opens without one.
CREATE FUNCTION admit_branch_closing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    actor auth_accounts%ROWTYPE;
    previous timestamptz;
BEGIN
    SELECT * INTO actor FROM auth_accounts WHERE id=NEW.opened_by_account_id;
    IF NOT FOUND OR actor.id <> 1 OR actor.location_id <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='LC002',
            MESSAGE='Only the warehouse settles a branch account';
    END IF;
    IF NEW.branch_location_id = 1 THEN
        RAISE EXCEPTION USING ERRCODE='LC002',
            MESSAGE='Account settlements belong to branches, not to the warehouse';
    END IF;
    IF EXISTS (SELECT 1 FROM locations
        WHERE id=NEW.branch_location_id AND deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE='LC017',
            MESSAGE='A retired branch is not settled';
    END IF;
    NEW.status := 'open';
    NEW.closed_at := NULL;
    NEW.cut_at := now();
    NEW.commission_rate_percent := NULL;
    -- A closure of the same branch may commit between this read and the unique index
    -- wait, and the snapshot below would then inherit a fund and a cut instant that are
    -- already obsolete. The branch is locked for the rest of the transaction, and every
    -- path that reads or writes the settlement of a branch takes the same lock: the
    -- closure itself, and the freeze guards of 035 (R4-001).
    PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);
    SELECT max(closed_at) INTO previous FROM branch_closings
    WHERE branch_location_id = NEW.branch_location_id AND status = 'closed';
    NEW.period_start := coalesce(previous, NEW.cut_at);
    NEW.opening_cash := coalesce((
        SELECT closing_cash FROM branch_closings
        WHERE branch_location_id = NEW.branch_location_id AND status = 'closed'
        ORDER BY closed_at DESC LIMIT 1), 0);
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_branch_closing BEFORE INSERT ON branch_closings
FOR EACH ROW EXECUTE FUNCTION admit_branch_closing();

-- While the warehouse holds the settlement, the only thing that can change on a count
-- line is what was counted: the expected quantity is the snapshot taken at open (035
-- seeds it from the branch's balances), and a closed settlement's sheet never moves.
-- This guard owns the shape of the line, so it does not read any other table.
CREATE FUNCTION guard_closing_count_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE header branch_closings%ROWTYPE;
BEGIN
    SELECT * INTO header FROM branch_closings WHERE id=OLD.closing_id;
    IF NOT FOUND OR header.status NOT IN ('open','rejected') THEN
        RAISE EXCEPTION USING ERRCODE='LC004',
            MESSAGE='Count lines are written while the warehouse holds the settlement';
    END IF;
    IF NEW.closing_id <> OLD.closing_id OR NEW.variant_id <> OLD.variant_id
       OR NEW.expected_quantity <> OLD.expected_quantity THEN
        RAISE EXCEPTION USING ERRCODE='LC004',
            MESSAGE='Only the counted quantity can change on a count line';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER guard_closing_count_line BEFORE UPDATE ON closing_count_lines
FOR EACH ROW EXECUTE FUNCTION guard_closing_count_line();

-- A line of the count sheet is never removed: the seeded line of a variant with stock
-- is what makes counting it mandatory, so dropping it would let a whole variant escape
-- the count. TRUNCATE bypasses row triggers and would erase the count of every closed
-- settlement at once, so it has its own guard.
CREATE FUNCTION guard_closing_count_line_removal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE='LC004',
        MESSAGE='A count line is counted, never removed';
END;
$$;
CREATE TRIGGER protect_closing_count_lines BEFORE DELETE ON closing_count_lines
FOR EACH ROW EXECUTE FUNCTION guard_closing_count_line_removal();
CREATE TRIGGER protect_closing_count_lines_truncate BEFORE TRUNCATE ON closing_count_lines
EXECUTE FUNCTION guard_closing_count_line_removal();

-- The settlement state machine is the database's, not the caller's: a closed one is
-- immutable, a live one is drafted only through its own money fields, and the only way
-- in is open -> proposed -> (rejected -> proposed)* -> closed with an accepted round.
CREATE FUNCTION admit_branch_closing_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    configured numeric(5,2);
    latest record;
    pending integer;
    excess numeric(12,2);
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='Account settlements are never deleted';
    END IF;
    IF OLD.status = 'closed' THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='A closed account settlement is not reopened; correct it';
    END IF;
    -- The identity is frozen at open: where and when the settlement settled, who opened
    -- it and the cash it inherited. (Its own id is an always-generated identity column,
    -- which PostgreSQL refuses to rewrite before any guard runs.)
    IF NEW.branch_location_id <> OLD.branch_location_id
       OR NEW.period_start <> OLD.period_start
       OR NEW.cut_at <> OLD.cut_at
       OR NEW.opened_by_account_id <> OLD.opened_by_account_id
       OR NEW.opening_cash <> OLD.opening_cash THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='The identity of an account settlement is frozen at open';
    END IF;
    -- The closure instant is taken by this guard below, never by a caller.
    IF NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='The closure instant belongs to the closure';
    END IF;
    -- The fund never exceeds the drawer the admin declares: the cash counted plus the
    -- contribution. Checked on every live write, so the admin gets this message while
    -- typing instead of a bare constraint violation from the row CHECK.
    IF NEW.counted_cash IS NOT NULL AND NEW.closing_cash IS NOT NULL
       AND NEW.closing_cash - NEW.counted_cash - NEW.contributed_cash > 0 THEN
        RAISE EXCEPTION USING ERRCODE='LC006',
            MESSAGE='The fund left behind exceeds the cash counted plus the contribution by '
                || (NEW.closing_cash - NEW.counted_cash - NEW.contributed_cash);
    END IF;
    -- "Guardar y salir": while the settlement is open or rejected the admin may persist
    -- a draft of the money it typed and of its observation, and nothing else. The
    -- draftable fields are exactly cash_sales, cash_expenses, counted_cash,
    -- contributed_cash, closing_cash and observation: they are drafts because until the
    -- closure they are the admin's own reading of the branch, not a fact of the period.
    -- cash_sales is the only one that stops being a draft: 035 overwrites it at the
    -- proposal with the sum of the sale payments of the window, and from then on the
    -- offer rule below freezes it (R1-001).
    -- A proposed settlement is not editable at all, because the branch is deciding that
    -- very offer; the period totals and the commission rate are never drafts.
    IF NEW.status = OLD.status THEN
        IF OLD.status NOT IN ('open','rejected') THEN
            RAISE EXCEPTION USING ERRCODE='LC005',
                MESSAGE='Only an open or a rejected settlement is drafted';
        END IF;
        IF NEW.sales_total <> OLD.sales_total
           OR NEW.commission_amount <> OLD.commission_amount
           OR NEW.card_total <> OLD.card_total
           OR NEW.transfer_total <> OLD.transfer_total
           OR NEW.qr_total <> OLD.qr_total
           OR NEW.commission_rate_percent IS DISTINCT FROM OLD.commission_rate_percent THEN
            RAISE EXCEPTION USING ERRCODE='LC005',
                MESSAGE='The period totals and the commission rate are not drafts';
        END IF;
        RETURN NEW;
    END IF;
    IF NOT (
        (OLD.status = 'open' AND NEW.status = 'proposed')
        OR (OLD.status = 'proposed' AND NEW.status = 'rejected')
        OR (OLD.status = 'rejected' AND NEW.status = 'proposed')
        OR (OLD.status = 'proposed' AND NEW.status = 'closed')
    ) THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='Unsupported account settlement transition';
    END IF;
    -- R1-001: the offer -- the five totals and the commission they pay -- is recorded
    -- when the settlement is proposed (035 computes it) and never rewritten afterwards.
    -- Neither a rejection nor the closure touches it: the branch is shown, decides and
    -- closes exactly the numbers the database recorded.
    IF NEW.status <> 'proposed'
       AND (NEW.sales_total <> OLD.sales_total
            OR NEW.cash_sales <> OLD.cash_sales
            OR NEW.commission_amount <> OLD.commission_amount
            OR NEW.card_total <> OLD.card_total
            OR NEW.transfer_total <> OLD.transfer_total
            OR NEW.qr_total <> OLD.qr_total) THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='The offer of a settlement is recorded when it is proposed';
    END IF;
    IF NEW.status = 'proposed' THEN
        -- The rate is a fact of the proposal (S6): it is read from branch_settings when
        -- the warehouse proposes, and frozen from then on, so changing the configured
        -- rate never alters a proposed or a closed settlement.
        SELECT commission_rate_percent INTO configured FROM branch_settings
        WHERE branch_location_id = NEW.branch_location_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LC003',
                MESSAGE='The branch has no commission rate configured';
        END IF;
        NEW.commission_rate_percent := configured;
        -- R3-001: a branch can never be offered a settlement whose count is incomplete.
        -- The refusal names the pending variant, exactly like the closure one does, so
        -- the admin knows which line of the count sheet is missing.
        SELECT variant_id INTO pending FROM closing_count_lines
        WHERE closing_id = OLD.id AND counted_quantity IS NULL ORDER BY variant_id LIMIT 1;
        IF pending IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='LC019',
                MESSAGE='Variant ' || pending || ' has no counted quantity';
        END IF;
        -- The offer is a round of the proposal (S14, S15): proposing opens one, so a
        -- settlement is never offered without the version that states it, and it can
        -- always be rejected because there is always a round to reject (R4-003).
        SELECT round, decision INTO latest FROM closing_proposals
        WHERE closing_id = OLD.id ORDER BY round DESC LIMIT 1;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='The settlement has no proposal round to offer';
        END IF;
        IF latest.decision IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='Proposal round ' || latest.round || ' is already decided';
        END IF;
    ELSIF NEW.commission_rate_percent IS DISTINCT FROM OLD.commission_rate_percent THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='The commission rate is frozen when the settlement is proposed';
    END IF;
    -- The branch decides on the numbers it was shown: once proposed, the drawer fields
    -- are the offer, and closing or rejecting must apply exactly that offer. They are
    -- draftable only while the warehouse holds the settlement.
    IF OLD.status = 'proposed' AND NEW.status IN ('rejected','closed') THEN
        IF NEW.cash_sales IS DISTINCT FROM OLD.cash_sales
           OR NEW.cash_expenses IS DISTINCT FROM OLD.cash_expenses
           OR NEW.counted_cash IS DISTINCT FROM OLD.counted_cash
           OR NEW.contributed_cash IS DISTINCT FROM OLD.contributed_cash
           OR NEW.closing_cash IS DISTINCT FROM OLD.closing_cash
           OR NEW.observation IS DISTINCT FROM OLD.observation THEN
            RAISE EXCEPTION USING ERRCODE='LC005',
                MESSAGE='The drawer of a proposed settlement is the offer the branch decides';
        END IF;
    END IF;
    -- R4-003: a rejection is the branch's answer to a round, so the latest round must
    -- itself be rejected. A header-only update can never bypass an accepted round, and
    -- it can never return a settlement to the warehouse that the branch did not refuse.
    IF NEW.status = 'rejected' THEN
        SELECT round, decision INTO latest FROM closing_proposals
        WHERE closing_id = OLD.id ORDER BY round DESC LIMIT 1;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='The settlement has no proposal round to reject';
        END IF;
        IF latest.decision IS DISTINCT FROM 'rejected' THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='Proposal round ' || latest.round || ' is not rejected';
        END IF;
    END IF;
    -- Only an accepted round closes a settlement (S14): nothing is applied by an offer
    -- the branch has not accepted, and nothing closes over an undecided one.
    IF NEW.status = 'closed' THEN
        IF EXISTS (SELECT 1 FROM closing_proposals
            WHERE closing_id=OLD.id AND decision IS NULL) THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='A proposal round is still undecided';
        END IF;
        SELECT round, decision INTO latest FROM closing_proposals
        WHERE closing_id=OLD.id ORDER BY round DESC LIMIT 1;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='The settlement has no proposal round to accept';
        END IF;
        IF latest.decision <> 'accepted' THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='Proposal round ' || latest.round || ' was rejected, not accepted';
        END IF;
    END IF;
    -- The closure instant is the database's, taken by this BEFORE trigger: an AFTER
    -- trigger writes it too late, and re-writing the row it watches re-enters this
    -- very guard with a closed OLD row and refuses every closure. The ledger rows of
    -- the closure are written by 035, which applies them under this same lock.
    IF NEW.status = 'closed' THEN
        -- A closure always states the money it counted, the contribution the warehouse
        -- made and the fund it leaves, and the fund never exceeds the drawer: the cash
        -- counted plus the contribution.
        IF NEW.counted_cash IS NULL OR NEW.closing_cash IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='LC006',
                MESSAGE='A closure states the cash counted and the fund left behind';
        END IF;
        excess := NEW.closing_cash - NEW.counted_cash - NEW.contributed_cash;
        IF excess > 0 THEN
            RAISE EXCEPTION USING ERRCODE='LC006',
                MESSAGE='The fund left behind exceeds the cash counted plus the contribution by '
                    || excess;
        END IF;
        PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);
        NEW.closed_at := now();
    END IF;
    RETURN NEW;
END;
$$;
-- The guard owns both halves of "never reopened": an UPDATE is a transition, and a
-- DELETE of a live or a closed settlement is refused by the same function.
CREATE TRIGGER admit_branch_closing_transition BEFORE UPDATE OR DELETE ON branch_closings
FOR EACH ROW EXECUTE FUNCTION admit_branch_closing_transition();
-- TRUNCATE never fires a row-level DELETE trigger, so the settlement history needs its
-- own statement-level guard: a closed settlement is never erased.
CREATE TRIGGER protect_branch_closings_truncate BEFORE TRUNCATE ON branch_closings
EXECUTE FUNCTION protect_pending_request();

-- The ledger is append only: a wrong movement is fixed by its opposite. This is the
-- immutability half of the table, and it is here because it reads no other table; who
-- may append a movement is 035.
CREATE TRIGGER protect_branch_cash_movements BEFORE UPDATE OR DELETE ON branch_cash_movements
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_branch_cash_movements_truncate BEFORE TRUNCATE ON branch_cash_movements
EXECUTE FUNCTION protect_pending_request();

-- A proposal round is immutable once decided, and only the branch it belongs to can
-- decide it. Any enabled account of that branch may accept or reject.
CREATE FUNCTION admit_closing_proposal_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header branch_closings%ROWTYPE;
    actor auth_accounts%ROWTYPE;
BEGIN
    -- A rejection returns the settlement to the warehouse for editing, so the next
    -- round is proposed over a 'rejected' settlement: there is no limit of rounds.
    SELECT * INTO header FROM branch_closings WHERE id=NEW.closing_id;
    IF NOT FOUND OR header.status NOT IN ('open','rejected') THEN
        RAISE EXCEPTION USING ERRCODE='LC008',
            MESSAGE='A proposal belongs to a live settlement';
    END IF;
    SELECT * INTO actor FROM auth_accounts WHERE id=NEW.proposed_by_account_id;
    IF NOT FOUND OR actor.id <> 1 OR actor.location_id <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='LC008',
            MESSAGE='Only the warehouse proposes a settlement';
    END IF;
    NEW.decision := NULL;
    NEW.decided_at := NULL;
    NEW.decided_by_account_id := NULL;
    NEW.decision_reason := '';
    NEW.round := coalesce((SELECT max(round) FROM closing_proposals
        WHERE closing_id=NEW.closing_id), 0) + 1;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_closing_proposal_insert BEFORE INSERT ON closing_proposals
FOR EACH ROW EXECUTE FUNCTION admit_closing_proposal_insert();

CREATE FUNCTION guard_closing_proposal_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header branch_closings%ROWTYPE;
    actor auth_accounts%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE='LC009',
            MESSAGE='Proposal rounds are never deleted';
    END IF;
    IF OLD.decision IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='LC009',
            MESSAGE='A decided proposal round is final';
    END IF;
    IF NEW.proposed_payload <> OLD.proposed_payload OR NEW.round <> OLD.round
       OR NEW.closing_id <> OLD.closing_id
       OR NEW.proposed_by_account_id <> OLD.proposed_by_account_id THEN
        RAISE EXCEPTION USING ERRCODE='LC009',
            MESSAGE='A proposal round states what the warehouse offered, unchanged';
    END IF;
    IF NEW.decision IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO header FROM branch_closings WHERE id=OLD.closing_id;
    IF header.status <> 'proposed' THEN
        RAISE EXCEPTION USING ERRCODE='LC010',
            MESSAGE='Only a proposed settlement can be decided';
    END IF;
    SELECT * INTO actor FROM auth_accounts WHERE id=coalesce(NEW.decided_by_account_id, 0);
    IF NOT FOUND OR actor.location_id <> header.branch_location_id OR actor.enabled IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE='LC010',
            MESSAGE='Only an enabled account of the branch decides it';
    END IF;
    NEW.decided_at := now();
    RETURN NEW;
END;
$$;
-- The guard owns both halves of "a round is never rewritten": an UPDATE is a
-- decision, and a DELETE of any round is refused by the same function.
CREATE TRIGGER guard_closing_proposal_decision BEFORE UPDATE OR DELETE ON closing_proposals
FOR EACH ROW EXECUTE FUNCTION guard_closing_proposal_decision();
CREATE TRIGGER protect_closing_proposals_truncate BEFORE TRUNCATE ON closing_proposals
EXECUTE FUNCTION protect_pending_request();

-- Corrections are proposed by the warehouse and decided by the branch, exactly like a
-- settlement. Their application to the ledger lands in migration 036.
CREATE FUNCTION admit_closing_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header branch_closings%ROWTYPE;
    actor auth_accounts%ROWTYPE;
BEGIN
    SELECT * INTO header FROM branch_closings WHERE id=NEW.closing_id;
    IF NOT FOUND OR header.status <> 'closed' THEN
        RAISE EXCEPTION USING ERRCODE='LC012',
            MESSAGE='Only a closed settlement is corrected';
    END IF;
    SELECT * INTO actor FROM auth_accounts WHERE id=NEW.proposed_by_account_id;
    IF NOT FOUND OR actor.id <> 1 OR actor.location_id <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='LC012',
            MESSAGE='Only the warehouse proposes a correction';
    END IF;
    NEW.status := 'proposed';
    NEW.decided_at := NULL;
    NEW.decided_by_account_id := NULL;
    NEW.decision_reason := '';
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_closing_correction BEFORE INSERT ON closing_corrections
FOR EACH ROW EXECUTE FUNCTION admit_closing_correction();

CREATE FUNCTION guard_closing_correction_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header branch_closings%ROWTYPE;
    actor auth_accounts%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE='LC013',
            MESSAGE='Corrections are never deleted';
    END IF;
    IF OLD.status <> 'proposed' THEN
        RAISE EXCEPTION USING ERRCODE='LC013',
            MESSAGE='A decided correction is final';
    END IF;
    IF NEW.payload <> OLD.payload OR NEW.closing_id <> OLD.closing_id
       OR NEW.reason <> OLD.reason THEN
        RAISE EXCEPTION USING ERRCODE='LC013',
            MESSAGE='A correction states what the warehouse offered, unchanged';
    END IF;
    IF NEW.status = 'proposed' THEN
        RETURN NEW;
    END IF;
    SELECT * INTO header FROM branch_closings WHERE id=OLD.closing_id;
    SELECT * INTO actor FROM auth_accounts WHERE id=coalesce(NEW.decided_by_account_id, 0);
    IF NOT FOUND OR actor.location_id <> header.branch_location_id OR actor.enabled IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE='LC014',
            MESSAGE='Only an enabled account of the branch decides a correction';
    END IF;
    NEW.decided_at := now();
    RETURN NEW;
END;
$$;
CREATE TRIGGER guard_closing_correction_decision BEFORE UPDATE OR DELETE ON closing_corrections
FOR EACH ROW EXECUTE FUNCTION guard_closing_correction_decision();
CREATE TRIGGER protect_closing_corrections_truncate BEFORE TRUNCATE ON closing_corrections
EXECUTE FUNCTION protect_pending_request();

-- The commission rate is the only branch setting today; the warehouse owns it.
CREATE FUNCTION admit_branch_settings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor auth_accounts%ROWTYPE;
BEGIN
    SELECT * INTO actor FROM auth_accounts WHERE id=NEW.updated_by_account_id;
    IF NOT FOUND OR actor.id <> 1 OR actor.location_id <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='LC015',
            MESSAGE='Only the warehouse configures a branch commission';
    END IF;
    IF NEW.branch_location_id = 1 THEN
        RAISE EXCEPTION USING ERRCODE='LC015',
            MESSAGE='The warehouse does not settle a commission to itself';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_branch_settings BEFORE INSERT OR UPDATE ON branch_settings
FOR EACH ROW EXECUTE FUNCTION admit_branch_settings();
