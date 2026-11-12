-- Branch account settlement ("rendición de cuentas"): the warehouse admin visits a
-- branch, freezes it, counts the cash and the stock, settles a commission and leaves
-- a fund for the next period. The period runs from one closed settlement to the next,
-- with a cut date chosen by hand each time.
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
-- No new realtime code is required: migration 004 already installs
-- invalidate_balance_change on inventory_balances, so every difference applied by
-- the closure trigger invalidates the 'inventory' scope inside the same transaction.
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
    cash_sales numeric(12,2) NOT NULL DEFAULT 0 CHECK (cash_sales >= 0),
    cash_expenses numeric(12,2) NOT NULL DEFAULT 0 CHECK (cash_expenses >= 0),
    -- Snapshots of the settled period, written once at closure.
    sales_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (sales_total >= 0),
    commission_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (commission_amount >= 0),
    card_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (card_total >= 0),
    transfer_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (transfer_total >= 0),
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

-- The predicate every branch-facing flow consults: a branch with a live settlement
-- cannot trade, receive stock, transfer or spend. Migration 035 wires it into the
-- existing admission functions; it is defined here because it reads this table.
CREATE FUNCTION branch_closure_blocker(target smallint) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM branch_closings
        WHERE branch_location_id = target AND status <> 'closed'
    );
$$;

CREATE FUNCTION assert_branch_not_frozen(target smallint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF branch_closure_blocker(target) THEN
        RAISE EXCEPTION USING ERRCODE='LC001',
            MESSAGE='The branch has an open account settlement and cannot operate';
    END IF;
END;
$$;

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

-- Opening a settlement freezes the expected snapshot for every variant the branch
-- holds, so the count sheet is a fact of the cut instant and never a live read.
CREATE FUNCTION seed_closing_count_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO closing_count_lines(closing_id, variant_id, expected_quantity)
    SELECT NEW.id, balance.variant_id, balance.existing
    FROM inventory_balances balance
    WHERE balance.location_id = NEW.branch_location_id AND balance.existing > 0;
    RETURN NULL;
END;
$$;
CREATE TRIGGER seed_closing_count_lines AFTER INSERT ON branch_closings
FOR EACH ROW EXECUTE FUNCTION seed_closing_count_lines();

-- A count line belongs to the warehouse while the settlement is not being decided: the
-- sheet is writable while it is open and again after a rejection, because a rejection
-- hands the settlement back for correction (S14) — a branch usually rejects a count that
-- is wrong. It is frozen while the branch is deciding, and forever once closed. The
-- expected quantity is the database's own snapshot, never a caller promise: a caller
-- that sends one is ignored.
CREATE FUNCTION admit_closing_count_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header branch_closings%ROWTYPE;
    balance inventory_balances%ROWTYPE;
BEGIN
    SELECT * INTO header FROM branch_closings WHERE id=NEW.closing_id;
    IF NOT FOUND OR header.status NOT IN ('open','rejected') THEN
        RAISE EXCEPTION USING ERRCODE='LC004',
            MESSAGE='Count lines are written while the warehouse holds the settlement';
    END IF;
    SELECT * INTO balance FROM inventory_balances
    WHERE location_id=header.branch_location_id AND variant_id=NEW.variant_id;
    NEW.expected_quantity := coalesce(balance.existing, 0);
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_closing_count_line BEFORE INSERT ON closing_count_lines
FOR EACH ROW EXECUTE FUNCTION admit_closing_count_line();

-- While the warehouse holds the settlement, the only thing that can change on a count
-- line is what was counted: the same window as the insert above, and never a closed one.
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
    -- The closure instant is taken by the closure itself below, never by a caller.
    IF NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='The closure instant belongs to the closure';
    END IF;
    -- "Guardar y salir": while the settlement is open or rejected the admin may persist
    -- a draft of the money it typed and of its observation, and nothing else. The
    -- draftable fields are exactly cash_sales, cash_expenses, counted_cash,
    -- contributed_cash, closing_cash and observation: they are drafts because until the
    -- closure they are the admin's own reading of the branch, not a fact of the period.
    -- A proposed settlement is not editable at all, because the branch is deciding that
    -- very offer; the period snapshots and the commission rate are never drafts.
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
                MESSAGE='The period snapshots and the commission rate are not drafts';
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
    -- The snapshots of the settled period are written once, by the closure itself.
    IF NEW.status <> 'closed'
       AND (NEW.sales_total <> OLD.sales_total
            OR NEW.commission_amount <> OLD.commission_amount
            OR NEW.card_total <> OLD.card_total
            OR NEW.transfer_total <> OLD.transfer_total
            OR NEW.qr_total <> OLD.qr_total) THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='The period snapshots are written once, by the closure';
    END IF;
    -- The rate is a fact of the proposal (S6): it is read from branch_settings when the
    -- warehouse proposes, and frozen from then on, so changing the configured rate
    -- never alters a proposed or a closed settlement.
    IF NEW.status = 'proposed' THEN
        SELECT commission_rate_percent INTO configured FROM branch_settings
        WHERE branch_location_id = NEW.branch_location_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LC003',
                MESSAGE='The branch has no commission rate configured';
        END IF;
        NEW.commission_rate_percent := configured;
    ELSIF NEW.commission_rate_percent IS DISTINCT FROM OLD.commission_rate_percent THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='The commission rate is frozen when the settlement is proposed';
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
    -- very guard with a closed OLD row and refuses every closure.
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

-- Closing is the only moment stock moves, and it moves to exactly what was counted:
-- the stock difference cannot survive a closure. Every line must be counted first, and
-- the money of the drawer becomes the closing ledger: the contribution the warehouse
-- made, and the fund left behind as its difference.
CREATE FUNCTION apply_branch_closing_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    line record;
    balance inventory_balances%ROWTYPE;
    pending integer;
    taken numeric(12,2);
BEGIN
    IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
        RETURN NULL;
    END IF;
    -- The refusal names the variant still pending, exactly like the stock one below:
    -- the admin has to know which line of the count sheet is missing.
    SELECT variant_id INTO pending FROM closing_count_lines
    WHERE closing_id=NEW.id AND counted_quantity IS NULL ORDER BY variant_id LIMIT 1;
    IF pending IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='LC006',
            MESSAGE='Variant ' || pending || ' has no counted quantity';
    END IF;
    FOR line IN
        SELECT * FROM closing_count_lines WHERE closing_id = NEW.id ORDER BY variant_id
    LOOP
        SELECT * INTO balance FROM inventory_balances
        WHERE location_id=NEW.branch_location_id AND variant_id=line.variant_id FOR UPDATE;
        IF line.counted_quantity < coalesce(balance.reserved, 0) THEN
            RAISE EXCEPTION USING ERRCODE='LC007',
                MESSAGE='Counted quantity of variant ' || line.variant_id
                    || ' is lower than its reserved stock';
        END IF;
        -- A variant counted above its expected quantity may have no balance row at
        -- all, and then it exists only in the count: the closure creates the row, so
        -- the stock ends exactly at what was counted in both directions.
        INSERT INTO inventory_balances(location_id, variant_id, existing, reserved)
        VALUES (NEW.branch_location_id, line.variant_id, line.counted_quantity, 0)
        ON CONFLICT (location_id, variant_id)
        DO UPDATE SET existing = EXCLUDED.existing;
    END LOOP;
    -- The contribution is money the warehouse puts into the till, so it is a ledger fact
    -- of its own: it is what the first settlement of a branch records (S11), and it is
    -- the difference of nothing.
    IF NEW.contributed_cash > 0 THEN
        INSERT INTO branch_cash_movements(
            branch_location_id, closing_id, kind, amount, description, created_by_account_id)
        VALUES (NEW.branch_location_id, NEW.id, 'aporte', NEW.contributed_cash,
            'Aporte de fondo de la rendición', NEW.opened_by_account_id);
    END IF;
    -- What the drawer held at the cut is the cash counted plus that contribution, and
    -- its difference with the fund left behind is the settlement transfer: positive
    -- leaves the branch for the warehouse, negative would be a further contribution.
    -- The S10 bound keeps this difference non-negative today.
    taken := NEW.counted_cash + NEW.contributed_cash - NEW.closing_cash;
    IF taken <> 0 THEN
        INSERT INTO branch_cash_movements(
            branch_location_id, closing_id, kind, amount, description, created_by_account_id)
        VALUES (
            NEW.branch_location_id, NEW.id,
            CASE WHEN taken > 0 THEN 'recaudacion' ELSE 'aporte' END,
            abs(taken),
            CASE WHEN taken > 0 THEN 'Recaudación de la rendición'
                 ELSE 'Aporte de fondo para la rendición' END,
            NEW.opened_by_account_id);
    END IF;
    -- closed_at was already stamped by the BEFORE transition guard, which owns the
    -- row: writing it from here would run the transition guard a second time on the
    -- row this trigger is watching, and it would refuse every closure.
    RETURN NULL;
END;
$$;
CREATE TRIGGER apply_branch_closing_closure AFTER UPDATE ON branch_closings
FOR EACH ROW EXECUTE FUNCTION apply_branch_closing_closure();

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

-- Cash movements are a ledger: append only, and a branch expense is always recorded by
-- the branch it belongs to while it is operating.
CREATE FUNCTION admit_branch_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor auth_accounts%ROWTYPE;
BEGIN
    SELECT * INTO actor FROM auth_accounts WHERE id=NEW.created_by_account_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LC011', MESSAGE='Cash movement requires a known account';
    END IF;
    IF NEW.kind = 'gasto' THEN
        IF actor.location_id <> NEW.branch_location_id THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='Only the branch records its own expenses';
        END IF;
        PERFORM assert_branch_not_frozen(NEW.branch_location_id);
        NEW.closing_id := NULL;
    ELSE
        IF NEW.closing_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='A collection or contribution belongs to a settlement';
        END IF;
        -- The money of a settlement is the warehouse's: it moves in the till of the
        -- branch that settlement belongs to, and never by an account of the branch.
        IF actor.id <> 1 OR actor.location_id <> 1 THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='Only the warehouse moves the money of a settlement';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM branch_closings
            WHERE id=NEW.closing_id AND branch_location_id=NEW.branch_location_id) THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='A cash movement belongs to a settlement of its own branch';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_branch_cash_movement BEFORE INSERT ON branch_cash_movements
FOR EACH ROW EXECUTE FUNCTION admit_branch_cash_movement();
CREATE TRIGGER protect_branch_cash_movements BEFORE UPDATE OR DELETE ON branch_cash_movements
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_branch_cash_movements_truncate BEFORE TRUNCATE ON branch_cash_movements
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
