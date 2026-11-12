-- Branch guards and the closure: everything of the account settlement ("rendición de
-- cuentas") that reads or writes another table.
--
-- The vertical is two migrations. 034 is the settlement's own shape -- tables, indexes,
-- identity, state machine and immutability -- and it names no table of 001-033. This one
-- is the rest:
--
--   * the freeze predicate every branch-facing flow consults, and its wiring into sale,
--     purchase, transfer and reconciliation (S3, L16, R4-001, R4-002);
--   * the count sheet's snapshot, taken from the branch's balances when the settlement
--     opens (S4);
--   * the offer the branch is shown, computed from the sales of the period and recorded
--     when the warehouse proposes (S6, S20, R1-001);
--   * the cash ledger's admission and the two ledger rows the closure writes (S10,
--     R3-003);
--   * the stock the closure applies (S5, R3-002, R4-004) and the closure itself.
--
-- It adds guards and only guards. No table, column, index, function or trigger of
-- 001-034 is rewritten or dropped: those versions are already applied and their
-- checksums recorded, and every branch-facing document keeps its own admission function
-- (admit_sale, admit_purchase, admit_transfer_creation, admit_transfer_decision) exactly
-- as it is. The established way to add a rule to such a table in this schema is a second
-- row-level trigger on the table that carries the branch, the way 017 added
-- admit_active_participants beside the creation guards instead of editing them.
--
-- PostgreSQL fires the BEFORE ROW triggers of one table in name order, so each trigger
-- below is named to fire before the admission trigger of its own table: the frozen branch
-- is refused with the domain error before that document's rules run, and on the transfer
-- transitions before admit_transfer_decision moves a single balance. The same ordering
-- holds inside the settlement: admit_branch_closing_transition (034) validates a
-- transition and freezes the rate before record_branch_closing_ledger and
-- record_branch_closing_offer read it, and the AFTER trigger apply_branch_closing_closure
-- applies the stock once the row is written.
--
-- Which tables are branch-facing, read from the schema of 001-033 and not assumed:
--
--   sales -- branch_location_id. 025 refuses location 1 outright (LV001), so every sale
--     belongs to a branch, and apply_sale_line decrements that branch's
--     inventory_balances. A sale during a settlement is exactly the stale count the
--     closure would resurrect.
--
--   purchases -- location_id. 032 refuses location <= 1 (LP001), so every purchase belongs
--     to a branch; it is the branch's money-out document and the money it takes out of
--     the drawer belongs to the period being settled.
--
--   transfer_requests -- origin_location_id and destination_location_id. A branch that
--     ships is the origin and a branch that receives is the destination, and this table is
--     the only document that announces either move. Both participant columns are asserted,
--     because a request always names at least one branch, and they are locked in ascending
--     location order so two opposite requests can never deadlock. The warehouse is never
--     frozen: a settlement can only name a branch (034 refuses branch_location_id = 1 with
--     LC002), so branch_closure_blocker(1) is always false and a request that does not name
--     a frozen branch is not touched.
--
--   transfer_requests, on its lifecycle -- dispatch and receipt do not create a second
--     document, they move the request itself, so the refusal has to hang on the transition:
--     approved -> in_transit takes the stock out of the origin and in_transit -> received
--     puts it into the destination.
--
--   branch_cash_movements -- its admission (below): a branch expense belongs to the branch
--     that records it and only while it operates; the money of a settlement belongs to the
--     warehouse and to the closure.
--
-- The reconciliation operations of 011, 012, 013 and 018 are branch-facing too, and this
-- is R4-002: they are operated by a physical endpoint of a received transfer and they move
-- that endpoint's inventory_balances.
--
--   transfer_count_operations (011) -- actor_location_id is the account that attests a
--     corrected count. 011 requires it to be the origin or the destination of the request
--     (42501) and an accepted correction raises or lowers the destination's balance.
--
--   transfer_restitution_operations (012) -- actor_location_id attests the quantity kept,
--     again one of the two endpoints, and an accepted restitution moves the source
--     endpoint's balance back.
--
--   transfer_dispatch_operations (013) -- actor_location_id is the endpoint that did not
--     dispatch, and an accepted reconciliation moves both the source and the destination
--     balance at once.
--
--   transfer_unified_operations (018) -- the same bilateral correction for a request that
--     is accounted by one workflow, and it moves both balances as well.
--
-- A frozen branch cannot be reconciled: the guard asserts the actor's location and both
-- endpoints of the request before those operations write their evidence, so the branch's
-- stock is never moved behind the count sheet the admin photographed (LC001, and the
-- closure never has to refuse a stock that already moved).
--
-- The tables that reference locations(id) and are deliberately NOT wired:
--
--   stock_entries, stock_adjustments -- location_id, warehouse-only. 021 refuses any
--     location other than 1 (LS005) and 022 reuses the same rule, so a branch can never be
--     the location of a stock ingress or of an adjustment: a guard here could never fire.
--     The branch's own stock ingress is the transfer receipt above.
--
--   inventory_balances -- location_id, but it is the balance every flow moves, including
--     the closure of the very settlement that freezes the branch: the closure applies the
--     counted stock while its own settlement is live (S5, S17), so a guard here would
--     refuse every closure.
--
--   the transfer cancellation -- pending/approved -> cancelled releases a reservation and
--     moves no stock and no cash, and this migration refuses to close a settlement while a
--     reservation of the branch is still open (S3); refusing the release would only leave a
--     frozen branch unable to clean up after itself.

-- The predicate every branch-facing flow consults: a branch with a live settlement
-- cannot trade, receive stock, transfer, reconcile or spend. It is a plain read, so the
-- store and a diagnostic query can ask it without side effects.
CREATE FUNCTION branch_closure_blocker(target smallint) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM branch_closings
        WHERE branch_location_id = target AND status <> 'closed'
    );
$$;

-- The raising wrapper, and the one place where the freeze synchronises with the
-- settlement (R4-001). It takes the per-branch advisory lock the opener and the closure
-- take, before reading the predicate, for the same reason they do: the settlement of a
-- branch is written by one writer at a time. Without the lock a guard could read "no
-- settlement" from a snapshot taken before a concurrent opener committed, admit a sale,
-- and commit after the settlement opened -- and the closure would then refuse that brand
-- new sale with LC018, leaving the settlement impossible to close.
--
-- It is VOLATILE on purpose: a volatile function takes a fresh statement snapshot after
-- the lock wait, so the predicate is read after the opener it waited for committed.
CREATE FUNCTION assert_branch_not_frozen(target smallint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(340251, target::integer);
    IF branch_closure_blocker(target) THEN
        RAISE EXCEPTION USING ERRCODE='LC001',
            MESSAGE='The branch has an open account settlement and cannot operate';
    END IF;
END;
$$;

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
-- hands the settlement back for correction (S14) -- a branch usually rejects a count that
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

-- Cash movements are a ledger: append only, and a branch expense is always recorded by
-- the branch it belongs to while it is operating.
--
-- The settlement's own rows are written by no one but the closure (R3-003). The closure
-- sets the transaction-local marker 'luson.closing_ledger' to the settlement it is
-- closing immediately before it inserts, and this guard requires both that marker and
-- the trigger depth the marker can only be set from: a client statement runs at depth 1,
-- so a manual aporte or recaudacion is refused even for the warehouse account and even
-- if the client sets the marker itself. The combined facts are what proves provenance,
-- not the account and not the status of the settlement.
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
        -- A settlement transfer is written once, by the closure itself, while the row
        -- still reads as proposed (034 writes the state, this migration writes the
        -- money). Anything else -- in particular appending money to a closed settlement
        -- -- is refused: that history is fixed by an approved correction, never by a new
        -- ledger row.
        IF NOT EXISTS (SELECT 1 FROM branch_closings
            WHERE id=NEW.closing_id AND branch_location_id=NEW.branch_location_id
              AND status = 'proposed') THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='A cash movement belongs to a proposed settlement of its own branch';
        END IF;
        IF EXISTS (SELECT 1 FROM branch_cash_movements
            WHERE closing_id=NEW.closing_id AND kind=NEW.kind) THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='A settlement states its transfer once';
        END IF;
        -- Provenance, checked last so the shape of the row is answered first: the row
        -- exists because the closure of this very settlement is writing it, right now,
        -- from inside its own trigger.
        IF current_setting('luson.closing_ledger', true) IS DISTINCT FROM NEW.closing_id::text
           OR pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION USING ERRCODE='LC020',
                MESSAGE='A cash movement of a settlement is written by its closure';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_branch_cash_movement BEFORE INSERT ON branch_cash_movements
FOR EACH ROW EXECUTE FUNCTION admit_branch_cash_movement();

-- The offer: at open|rejected -> proposed the database records what the branch is being
-- asked to accept (R1-001). sales_total is the sum of the sold lines of the branch in
-- [period_start, cut_at); cash_sales, card_total and transfer_total are the sale
-- payments of that same window -- the three amounts 027 stores on the sale itself -- and
-- qr_total is 0 until the fourth method has its own migration (S13). commission_amount
-- is the frozen rate over the total of the period, rounded once by the database, half a
-- cent up (S20).
--
-- From here on the five totals and commission_amount are immutable: 034 refuses any
-- later change, and the closure applies the offer instead of recomputing it, so the
-- branch is shown exactly the numbers it accepted.
--
-- This runs after admit_branch_closing_transition (034), which is what freezes the rate
-- on this same row; the trigger names keep that order and the check below refuses a
-- transition that reached this point without one.
CREATE FUNCTION record_branch_closing_offer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    sold numeric(12,2);
    payments record;
BEGIN
    IF NEW.status <> 'proposed' OR OLD.status = 'proposed' THEN
        RETURN NEW;
    END IF;
    IF NEW.commission_rate_percent IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='LC003',
            MESSAGE='The branch has no commission rate configured';
    END IF;
    SELECT coalesce(sum(line.subtotal),0) INTO sold
    FROM sale_lines line
    JOIN sales sale ON sale.id = line.sale_id
    WHERE sale.branch_location_id = NEW.branch_location_id
      AND sale.created_at >= NEW.period_start
      AND sale.created_at < NEW.cut_at;
    SELECT coalesce(sum(sale.cash_amount),0) AS cash,
           coalesce(sum(sale.card_amount),0) AS card,
           coalesce(sum(sale.transfer_amount),0) AS transfer
    INTO payments
    FROM sales sale
    WHERE sale.branch_location_id = NEW.branch_location_id
      AND sale.created_at >= NEW.period_start
      AND sale.created_at < NEW.cut_at;
    NEW.sales_total := sold;
    NEW.cash_sales := payments.cash;
    NEW.card_total := payments.card;
    NEW.transfer_total := payments.transfer;
    NEW.qr_total := 0;
    -- One rounding, on the total of the period: numeric round() takes a half cent away
    -- from zero, so exactly half a cent goes up (S20).
    NEW.commission_amount := round(sold * NEW.commission_rate_percent / 100, 2);
    RETURN NEW;
END;
$$;
CREATE TRIGGER record_branch_closing_offer BEFORE UPDATE ON branch_closings
FOR EACH ROW EXECUTE FUNCTION record_branch_closing_offer();

-- The money of the drawer at the closure: the contribution the warehouse made and the
-- fund it leaves behind, as its difference. Both are ledger facts of the settlement and
-- both are written here, while the row still reads as proposed -- which is the window
-- admit_branch_cash_movement admits and the provenance marker it requires.
CREATE FUNCTION record_branch_closing_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE taken numeric(12,2);
BEGIN
    IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
        RETURN NEW;
    END IF;
    PERFORM set_config('luson.closing_ledger', NEW.id::text, true);
    IF NEW.contributed_cash > 0 THEN
        INSERT INTO branch_cash_movements(
            branch_location_id, closing_id, kind, amount, description, created_by_account_id)
        VALUES (NEW.branch_location_id, NEW.id, 'aporte', NEW.contributed_cash,
            'Aporte de fondo de la rendición', NEW.opened_by_account_id);
    END IF;
    -- What the drawer held at the cut is the cash counted plus the contribution, and its
    -- difference with the fund left behind is the settlement transfer. The S10 bound
    -- (closing_cash <= counted_cash + contributed_cash) keeps that difference
    -- non-negative today, so the settlement is a collection; the opposite direction is
    -- kept for the correction workflow that writes deltas later.
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
    PERFORM set_config('luson.closing_ledger', '', true);
    RETURN NEW;
END;
$$;
CREATE TRIGGER record_branch_closing_ledger BEFORE UPDATE ON branch_closings
FOR EACH ROW EXECUTE FUNCTION record_branch_closing_ledger();

-- Closing is the only moment stock moves, and it moves to exactly what was counted:
-- the stock difference cannot survive a closure. Every line must be counted first, and
-- no variant of the branch may still have an open reservation: a reserved unit is stock
-- the branch already promised, so settling it under the count would promise it twice
-- (S3, R3-002, R4-004). The refusal names the variant in both cases, because the admin
-- has to know which line of the sheet is blocking the closure.
CREATE FUNCTION apply_branch_closing_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    line record;
    balance inventory_balances%ROWTYPE;
    pending integer;
BEGIN
    IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
        RETURN NULL;
    END IF;
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
        -- Any open reservation blocks the closure, whatever was counted: the finding is
        -- the reservation itself, not the arithmetic of counted against reserved.
        IF coalesce(balance.reserved, 0) > 0 THEN
            RAISE EXCEPTION USING ERRCODE='LC007',
                MESSAGE='Variant ' || line.variant_id || ' still has reserved stock';
        END IF;
        -- The count is a snapshot of the cut instant. If the branch traded while the
        -- settlement is open, applying the stale count would resurrect sold stock or
        -- discard received stock. The freeze guards above are what prevent it; this
        -- refusal is what keeps the closure safe even if one of them is bypassed. A
        -- variant with no balance row yet has nothing to compare: the INSERT below
        -- creates it from the count.
        IF balance.location_id IS NOT NULL
           AND balance.existing IS DISTINCT FROM line.expected_quantity THEN
            RAISE EXCEPTION USING ERRCODE='LC018',
                MESSAGE='Variant ' || line.variant_id || ' moved during the settlement';
        END IF;
        -- A variant counted above its expected quantity may have no balance row at
        -- all, and then it exists only in the count: the closure creates the row, so
        -- the stock ends exactly at what was counted in both directions.
        INSERT INTO inventory_balances(location_id, variant_id, existing, reserved)
        VALUES (NEW.branch_location_id, line.variant_id, line.counted_quantity, 0)
        ON CONFLICT (location_id, variant_id)
        DO UPDATE SET existing = EXCLUDED.existing;
    END LOOP;
    -- closed_at was already stamped by the transition guard of 034, which owns the row:
    -- writing it from here would run that guard a second time on the row this trigger is
    -- watching, and it would refuse every closure.
    RETURN NULL;
END;
$$;
CREATE TRIGGER apply_branch_closing_closure AFTER UPDATE ON branch_closings
FOR EACH ROW EXECUTE FUNCTION apply_branch_closing_closure();

-- A branch that is being settled does not sell. The refusal is the predicate's own:
-- this migration never re-states the message or the SQLSTATE, so the store keeps
-- mapping LC001 and nothing else.
CREATE FUNCTION admit_sale_when_branch_operating() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM assert_branch_not_frozen(NEW.branch_location_id);
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_frozen_branch_sale BEFORE INSERT ON sales
FOR EACH ROW EXECUTE FUNCTION admit_sale_when_branch_operating();

-- A branch that is being settled spends no money on a purchase either: the purchase is
-- admitted by admit_purchase's own rules once, and only once, the branch is operating.
CREATE FUNCTION admit_purchase_when_branch_operating() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM assert_branch_not_frozen(NEW.location_id);
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_frozen_branch_purchase BEFORE INSERT ON purchases
FOR EACH ROW EXECUTE FUNCTION admit_purchase_when_branch_operating();

-- A branch that is being settled neither ships nor receives: the request is the only
-- document that announces either move, so both participants are asserted here, in
-- ascending location order so that two opposite requests cannot deadlock on their
-- per-branch locks.
CREATE FUNCTION admit_transfer_when_branches_operating() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.origin_location_id <= NEW.destination_location_id THEN
        PERFORM assert_branch_not_frozen(NEW.origin_location_id);
        PERFORM assert_branch_not_frozen(NEW.destination_location_id);
    ELSE
        PERFORM assert_branch_not_frozen(NEW.destination_location_id);
        PERFORM assert_branch_not_frozen(NEW.origin_location_id);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_frozen_branch_transfer BEFORE INSERT ON transfer_requests
FOR EACH ROW EXECUTE FUNCTION admit_transfer_when_branches_operating();

-- The two lifecycle steps that move real stock: dispatch empties the origin and receipt
-- fills the destination. The older row is read, not the new one, because a decision or a
-- cancellation changes neither and must stay untouched by this guard.
CREATE FUNCTION admit_transfer_move_when_branches_operating() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'approved' AND NEW.status = 'in_transit' THEN
        PERFORM assert_branch_not_frozen(OLD.origin_location_id);
    ELSIF OLD.status = 'in_transit' AND NEW.status = 'received' THEN
        PERFORM assert_branch_not_frozen(OLD.destination_location_id);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_frozen_branch_transfer_move BEFORE UPDATE ON transfer_requests
FOR EACH ROW EXECUTE FUNCTION admit_transfer_move_when_branches_operating();

-- A frozen branch cannot reconcile its received transfers (R4-002). The four operation
-- tables of 011, 012, 013 and 018 are the entry point of every reconciliation: the guard
-- runs before their own apply trigger, so the evidence row is refused before it exists
-- and before a single balance is locked.
--
-- Both ends and the actor are asserted. The actor is the branch account operating the
-- correction (the four operation triggers already refuse an actor that is not a physical
-- endpoint of the request), and the endpoints are the balances that move -- so neither a
-- branch reconciling its own transfer nor the warehouse reconciling one that lands on a
-- frozen branch can move that branch's stock behind the count sheet.
CREATE FUNCTION admit_reconciliation_when_branch_operating() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header transfer_requests%ROWTYPE;
    known boolean;
BEGIN
    SELECT * INTO header FROM transfer_requests WHERE id = NEW.request_id;
    known := FOUND;
    IF known THEN
        IF header.origin_location_id <= header.destination_location_id THEN
            PERFORM assert_branch_not_frozen(header.origin_location_id);
            PERFORM assert_branch_not_frozen(header.destination_location_id);
        ELSE
            PERFORM assert_branch_not_frozen(header.destination_location_id);
            PERFORM assert_branch_not_frozen(header.origin_location_id);
        END IF;
    END IF;
    -- Last, so that the per-branch locks were already taken in ascending order: for every
    -- admitted operation the actor is one of the two endpoints, so repeating its lock is a
    -- no-op, and an actor that is not an endpoint is refused by its own operation trigger
    -- after this guard.
    PERFORM assert_branch_not_frozen(NEW.actor_location_id);
    RETURN NEW;
END;
$$;
-- 011: corrected count of a received transfer. Nested after the ownership fence and
-- before apply_count_operation.
CREATE TRIGGER admit_frozen_branch_count BEFORE INSERT ON transfer_count_operations
FOR EACH ROW EXECUTE FUNCTION admit_reconciliation_when_branch_operating();
-- 012: retained quantity restitution. Before apply_restitution_operation.
CREATE TRIGGER admit_frozen_branch_restitution BEFORE INSERT ON transfer_restitution_operations
FOR EACH ROW EXECUTE FUNCTION admit_reconciliation_when_branch_operating();
-- 013: dispatch reconciliation of a received transfer. Before
-- apply_transfer_dispatch_operation.
CREATE TRIGGER admit_frozen_branch_dispatch BEFORE INSERT ON transfer_dispatch_operations
FOR EACH ROW EXECUTE FUNCTION admit_reconciliation_when_branch_operating();
-- 018: the unified reconciliation of the same movement. Before
-- apply_transfer_unified_operation.
CREATE TRIGGER admit_frozen_branch_unified BEFORE INSERT ON transfer_unified_operations
FOR EACH ROW EXECUTE FUNCTION admit_reconciliation_when_branch_operating();
