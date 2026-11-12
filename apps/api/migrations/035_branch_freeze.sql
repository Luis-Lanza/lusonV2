-- Branch freeze wiring ("Correcto, la sucursal se congela", S3): while a branch has a live
-- account settlement -- open, proposed or rejected -- it operates nothing. 034 owns the
-- state machine and the predicate, branch_closure_blocker() and its raising wrapper
-- assert_branch_not_frozen(), and it wired that predicate into its own cash-expense
-- ledger. This migration wires the same predicate into the admission paths the rest of the
-- schema already has, which is finding R4-001 of the native review of 034: without it a
-- frozen branch kept selling and selling kept moving its stock, the count was photographed
-- at the cut, and the closure then applied a stale count over stock that had already moved.
--
-- It adds guards and only guards. No table, column, index, function or trigger of 001-034
-- is rewritten or dropped: those versions are already applied and their checksums are
-- recorded, and every branch-facing document keeps its own admission function (admit_sale,
-- admit_purchase, admit_transfer_creation, admit_transfer_decision) exactly as it is. The
-- established way to add a rule to such a table in this schema is a second row-level
-- trigger on the table that carries the branch, the way 017 added
-- admit_active_participants beside the creation guards instead of editing them.
--
-- PostgreSQL fires the BEFORE row triggers of one table in name order, so each trigger
-- below is named to fire before the admission trigger of its own table: the frozen branch
-- is refused with the domain error before that document's rules run, and on the transfer
-- transitions before admit_transfer_decision moves a single balance.
--
-- Which tables are branch-facing, read from the schema of 001-034 and not assumed:
--
--   sales -- branch_location_id. 025 refuses location 1 outright (LV001), so every sale
--     belongs to a branch, and apply_sale_line decrements that branch's
--     inventory_balances. A sale during a settlement is exactly the stale count the
--     closure would resurrect.
--
--   purchases -- location_id. 032 refuses location <= 1 (LP001), so every purchase belongs
--     to a branch; it is the branch's money-out document and the money it takes out of the
--     drawer belongs to the period being settled.
--
--   transfer_requests -- origin_location_id and destination_location_id. A branch that
--     ships is the origin and a branch that receives is the destination, and this table is
--     the only document that announces either move. Both participant columns are asserted,
--     because a request always names at least one branch. The warehouse is never frozen: a
--     settlement can only name a branch (034 refuses branch_location_id = 1 with LC002), so
--     branch_closure_blocker(1) is always false and a request that does not name a frozen
--     branch is not touched.
--
--   transfer_requests, on its lifecycle -- dispatch and receipt do not create a second
--     document, they move the request itself, so the refusal has to hang on the transition:
--     approved -> in_transit takes the stock out of the origin and in_transit -> received
--     puts it into the destination.
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
--   branch_cash_movements -- already guarded by admit_branch_cash_movement in 034, which
--     calls the predicate for a branch expense. This migration does not duplicate it.
--
--   the transfer cancellation -- pending/approved -> cancelled releases a reservation and
--     moves no stock and no cash, and 034 already refuses to close a settlement while
--     reservations are open (S3); refusing the release would only leave a frozen branch
--     unable to clean up after itself.

-- A branch that is being settled does not sell. The refusal is 034's own: this migration
-- never re-states the message or the SQLSTATE, so the store keeps mapping LC001 and nothing
-- else.
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
-- document that announces either move, so both participants are asserted here, and the
-- order of the two calls is the order the columns are declared in.
CREATE FUNCTION admit_transfer_when_branches_operating() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM assert_branch_not_frozen(NEW.origin_location_id);
    PERFORM assert_branch_not_frozen(NEW.destination_location_id);
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
