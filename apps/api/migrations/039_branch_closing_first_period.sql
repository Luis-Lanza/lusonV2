-- The first period of a branch starts where the branch started, not at the visit that
-- settles it (S2, S6, S11).
--
-- 034 states the period of a settlement as the closure instant of the previous closed
-- settlement of the same branch, "or the cut instant for the first one". The second half of
-- that rule loses money. With the first period starting at the very instant the branch is
-- frozen, everything the branch did before the warehouse's visit belongs to no period at
-- all: a sale made before the first settlement falls outside [period_start, cut_at), so the
-- offer records sales_total 0.00, cash_sales 0.00 and commission_amount 0.00 -- the manager
-- is paid nothing for it -- and the cash that sale left in the till is not a sale of the
-- drawer identity either, so the difference of the first closure reports it as a surplus the
-- branch never had. This is the ordinary case of a branch created after go-live, or of a
-- first visit that comes a month after the branch opened. S2 wants the first period to start
-- at the start of the system and S6 makes the sales of the period the commission base, so the
-- boundary of the first period has to be earlier than the first settlement, never equal to it.
--
-- The boundary chosen: the earliest activity the database records for that branch, and the
-- cut instant only for a branch with nothing recorded. That is read from the two ledgers the
-- settlement actually sums -- the sales of the branch (sales.created_at, the commission base
-- of S6) and the movements of its till (branch_cash_movements.occurred_at, the expenses of
-- S8) -- because those two are the whole of what a period adds up, so the earliest of them is
-- the earliest instant the period can honestly state about itself. The alternatives were
-- rejected on evidence rather than on taste:
--
--   * locations does not record when a branch was created (only deleted_at, 017), so "the
--     instant the branch came into existence" is not a fact this schema can state, and
--     initialization_metadata.initialized_at is the start of the installation, not of a
--     branch that was created much later: settling a brand new branch from the installation's
--     own date would claim a period the branch never lived through.
--   * purchases, received transfers, stock entries and stock adjustments move the shelf, and
--     the shelf is not a window: a settlement counts what exists (S4) and leaves exactly what
--     was counted (S5), and it never sums what entered and left. See the note on the expected
--     snapshot below.
--
-- A branch that has never sold and never spent anything has no recorded activity, so the
-- minimum is NULL, coalesce leaves the cut instant, and the first period is empty: zero sales,
-- zero commission, an empty drawer (S11). That is the bootstrap the admin asked for: the
-- count is aligned and the drawer starts with the contribution the warehouse declares at the
-- closure, which is a ledger fact of its own.
--
-- Nothing else of the opening changes, and this file is written to make that checkable
-- statement by statement: only the first settlement takes the new boundary, every later one
-- still starts at the closure of the previous one (S2); the per-branch advisory lock is taken
-- before the period and the fund are read, exactly as 034 does it; the inherited fund is still
-- the closing_cash of the last closure or 0; the retired branch is still refused with LC017;
-- the warehouse is still the only one who opens, with LC002; and the one-live-per-branch rule
-- keeps living in the unique index of 034, untouched. period_start stays frozen at open by the
-- transition guard of 034.
--
-- Why this file replaces a function instead of editing it: 001-038 are applied and their
-- checksums recorded, so the opener of 034 cannot be changed in place. It is redefined whole
-- with CREATE OR REPLACE, the same way 037 redefines the offer it had to extend, and the
-- trigger of 034 (admit_branch_closing BEFORE INSERT) is not recreated: a second trigger on
-- the same event would run the admission twice. No other function of the vertical is touched.
--
-- The same boundary does NOT bound the expected stock snapshot. seed_closing_count_lines (035)
-- keeps seeding one line per variant with stock, straight from inventory_balances at the cut
-- instant, and that is correct rather than an oversight: stock is a state of the shelf, not a
-- total of the period. The closure does not add up what entered and left the branch -- it
-- counts what physically exists (S4) and leaves the shelf exactly as counted (S5) -- so
-- bounding the snapshot by period_start would ask the admin to count only the units that
-- arrived inside a window, which is not what a count is, and would silently drop the units
-- that arrived earlier from a sheet whose whole purpose is to cover them. Gaps in the shelf's
-- own history are a different rule (S5's difference of count) and not a correction of this
-- boundary.

CREATE OR REPLACE FUNCTION admit_branch_closing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    actor auth_accounts%ROWTYPE;
    previous timestamptz;
    first_activity timestamptz;
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
    -- A closure of the same branch may commit between this read and the unique index wait,
    -- and the snapshot below would then inherit a period, a fund and a cut instant that are
    -- already obsolete. The branch is locked for the rest of the transaction, and every path
    -- that reads or writes the settlement of a branch takes the same lock: the closure
    -- itself, and the freeze guards of 035 (R4-001). Taking it before the reads below is what
    -- makes the earliest activity a sale committed a moment ago still visible here.
    PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);
    SELECT max(closed_at) INTO previous FROM branch_closings
    WHERE branch_location_id = NEW.branch_location_id AND status = 'closed';
    IF previous IS NOT NULL THEN
        -- Every period after the first is the closure instant of the previous settlement of
        -- the same branch, exactly as 034 states it (S2). This version does not move it.
        NEW.period_start := previous;
    ELSE
        -- The first period covers what the branch did before the warehouse arrived. LEAST
        -- ignores a NULL input, so a branch that only sold or only paid out of its till starts
        -- at whichever of the two happened first, and a branch with neither stays NULL here.
        SELECT least(
            (SELECT min(sale.created_at) FROM sales sale
             WHERE sale.branch_location_id = NEW.branch_location_id),
            (SELECT min(movement.occurred_at) FROM branch_cash_movements movement
             WHERE movement.branch_location_id = NEW.branch_location_id))
        INTO first_activity;
        -- A branch that has done nothing yet opens an empty period at its own cut instant:
        -- no sale, so no commission, and a drawer fed only by the contribution the admin
        -- declares when the settlement closes (S11).
        NEW.period_start := coalesce(first_activity, NEW.cut_at);
    END IF;
    NEW.opening_cash := coalesce((
        SELECT closing_cash FROM branch_closings
        WHERE branch_location_id = NEW.branch_location_id AND status = 'closed'
        ORDER BY closed_at DESC LIMIT 1), 0);
    RETURN NEW;
END;
$$;
