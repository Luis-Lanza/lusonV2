-- The closing settles the purchase fund through its book (S9, S5, S6, S7). 048 gave the fund a
-- ledger and stated its balance as `sum(effective)` of `purchase_fund_ledger`; 050 made every
-- purchase write its own `compra` there. The settlement, meanwhile, kept stating the fund twice
-- outside that book: 044's `purchase_fund_counted` (what the warehouse counted) and
-- `purchase_fund_cash` (the amount it leaves, which opens the next period). Nothing joined the
-- second column to the ledger, so a closure could leave 400.00 in the fund and the branch's book
-- could still hold 0.00 -- two numbers about the same money, and two numbers that can differ is
-- exactly what S5 forbids. This version joins them:
--
--   1. `record_branch_closing_fund()`, a trigger on the closure, writes the amount a settlement
--      leaves as the fund's `reposicion` (S9). What it writes is the difference between the amount
--      the warehouse states and the balance the book holds at that instant, read from
--      `purchase_fund_ledger` under the lock of the branch (340251), which is the key of the
--      closure of 044, the purchases of 044/050 and the admission of 048. The balance after the
--      closure is therefore the stated amount, by construction and not by promise;
--   2. `admit_branch_fund_movement()` of 048 is restated whole with one path added: the movement
--      a closure writes, proved the way 046 proves the transfer of a settlement. A `reposicion`
--      of the branch is normally signed by an account of that branch, but the money a settlement
--      leaves is the warehouse's statement, made while the branch is frozen by the very
--      settlement that states it. The provenance is therefore the marker `luson.closing_fund`
--      naming the settlement + `pg_trigger_depth() >= 2`: a client statement runs at depth 1, so
--      no client can forge it, exactly like the drawer's `luson.closing_ledger` of 035.
--
-- **Why the fund of a closure is a movement and not a column.** A number a closure writes beside the
-- book is a number the book can contradict, and the branch reads the book: two arithmetics is how a
-- fund stops closing, and one arithmetic is what S5 asks for. The statement is therefore a row of
-- the ledger, and every reader -- the acta,
-- the history, the card of the envelope, the opening of the next period and the purchases it pays
-- for -- publishes the ledger's own sum.
--
-- **Where the fund's balance is computed.** In one place: `sum(effective)` of
-- `purchase_fund_ledger` (048, unedited). This migration adds no second arithmetic: it reads that
-- sum to decide the delta, and the acta publishes that same sum, read by the store
-- (`derivePurchaseFund`) at the settlement's own `closed_at`, which is the instant the closure
-- stamped both on the row and on the movement (`now()` of one transaction). `purchase_fund_cash`
-- is derived on read from the ledger rather than trusted as a column: the column stays as the
-- statement the warehouse made and the branch accepted (the offer the closure applies, frozen by
-- 044), and the number every reader publishes is the book's. A column that could drift from the
-- book no longer has a reader that believes it.
--
-- **What a closure that changes the fund twice writes.** It writes a second movement. The fund's
-- ledger is append only (048) and a closed settlement is never rewritten (034), so a correction of
-- the fund -- 036's correction applied after the closure, LC022 and the journal it applies -- is a
-- new row of the book and never an edit of the `reposicion`: a `correccion` that answers the
-- `compra` that made the fund short, or answers an `aporte` that was too high. The closed acta
-- keeps stating the fund it settled (the book at its own `closed_at`), and the appending movement
-- is the fact of the period that follows: the next settlement's opening is the same sum read one
-- function later, so the correction reaches the next period through the book and not through a
-- rewritten history.
--
-- **The statement is signed, and S6 still wins.** A settlement can leave more than the book holds
-- (the warehouse loads the fund) and it can leave less (the warehouse takes the surplus back to the
-- drawer or the warehouse): both are statements about the same money, and the second one is the
-- mirror of the first. It is written as a `reposicion` whose amount is the difference, which is
-- therefore the only kind of this ledger whose amount may be negative -- `aporte`, `compra` and
-- `correccion` keep the positive amount of 048, and the sign of a `reposicion` is the sign of the
-- difference it states. `purchase_fund_ledger` already reads a `reposicion` as positive money in, so
-- a negative `reposicion` is negative money in and no second arithmetic is introduced: the
-- direction is still the kind's, and the amount says how much.
--
-- What a signed amount changes in 048's own rules. Two of them assume every amount is positive: a
-- correction never exceeds `corrected.amount`, and the direction of its effect is read from the kind.
-- With a signed `reposicion` both read the magnitude and the direction instead -- `abs(amount)` and
-- `sign(amount)` -- so a correction of a `reposicion` that took money out gives it back, and the rule
-- keeps stating what it always stated for the three kinds whose amount is still positive. This is
-- the whole of the difference: 051 restates the admission of 048 with that change and with the
-- closing path, and every other statement, code and message of it is unchanged.
--
-- S6 wins twice over. The balance after the closure is the amount the statement froze, and 044
-- keeps that amount non-negative (`purchase_fund_cash >= 0`), so no statement can make the fund
-- negative: a settlement that declared less than zero could not even be stored. And the amount the
-- difference can take out is bounded by the book itself, because the difference is only negative
-- when the book holds more than the statement. So the fund is never driven below zero by a closure,
-- not even by one that leaves nothing at all (a statement of `0.00` closes the fund to zero and
-- writes a `reposicion` of minus the whole balance).
--
-- Writing: this file relaxes one CHECK of 048's ledger (the amount of a `reposicion` is signed,
-- because a statement can leave less than the book holds), creates one trigger function with its
-- trigger, and replaces one function of the fund's admission -- its trigger keeps calling the name
-- it already has -- with two of its correction rules read on the magnitude and the sign. No table,
-- no view and no settlement is created or rewritten and no row is written here, and 048, 049 and
-- 050 are used exactly as they are: this migration has no dependency on 050 beyond the `compra`
-- movements it writes, which 048 already admits.

-- The amount of a `reposicion` is signed (S9, S6). 048 states that every movement of the fund carries
-- a positive amount, and that is what the direction of the four kinds is for: money in for an
-- `aporte` or a `reposicion`, money out for a `compra`, the opposite of the target for a
-- `correccion`. A settlement that takes the surplus of the fund back to the warehouse is a
-- statement about money that leaves, and the kind that states what a settlement leaves is the
-- `reposicion`, so its amount is the signed difference and nothing else changes: the view already
-- reads a `reposicion` as money in, and a negative one is negative money in. The three other kinds
-- keep the positive amount of 048, because their direction is never in doubt.
--
-- The constraint is dropped and restated instead of edited in 048 for the reason every applied
-- version is: its checksum is recorded, so what changes is stated here.
ALTER TABLE branch_fund_movements DROP CONSTRAINT branch_fund_movements_amount_check;
ALTER TABLE branch_fund_movements ADD CONSTRAINT branch_fund_movements_amount_check CHECK (
    (kind = 'reposicion' AND amount <> 0) OR (kind <> 'reposicion' AND amount > 0));

-- The fund a closure leaves (S9). The amount the warehouse states is the fund of the next period,
-- and the movement that states it is a `reposicion` of the branch's book: the book is the only
-- place the fund's balance comes from, so the statement has to be a row of it and not a column
-- beside it.
--
-- The delta, and not the stated amount. A `reposicion` moves money into the book, so what it
-- states is what the settlement leaves *minus* what the book already holds. Writing the stated
-- amount would count the fund twice and the balance would never close. The difference carries the
-- sign of the statement: a positive one is the fund the warehouse loads, a negative one is the
-- surplus it takes back, and a delta of zero writes nothing -- zero is the empty sum of a book and
-- not a movement to explain, exactly as the founding of 048 writes nothing for 0,00.
CREATE FUNCTION record_branch_closing_fund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    balance numeric(12,2);
BEGIN
    IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
        RETURN NEW;
    END IF;
    -- A settlement that states no amount leaves the fund as the book has it, and an unstated fund
    -- is zero and not unknown (S7): no column, no movement, and the acta publishes the signed sum.
    IF NEW.purchase_fund_cash IS NULL THEN
        RETURN NEW;
    END IF;
    -- The lock of 044, 048 and of this very closure (340251), taken before the balance is read.
    -- The transition guard of 044 already took it for this closure in this same transaction, so
    -- this call is free; it is stated here because the read below is what it protects -- two
    -- closures, or a closure and a purchase, can never read the same balance and both write it.
    PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);
    SELECT coalesce(sum(effective),0) INTO balance FROM purchase_fund_ledger
        WHERE branch_location_id = NEW.branch_location_id;
    IF NEW.purchase_fund_cash = balance THEN
        -- The settlement leaves exactly what the fund holds: the book is already right and no row
        -- of it is needed to say so.
        RETURN NEW;
    END IF;
    -- The difference is the statement, and its sign is the direction: the fund the warehouse loads
    -- (positive) or the surplus it takes back (negative). The balance after this row is the amount
    -- the settlement froze, which 044 keeps non-negative, so no closure can drive the fund below
    -- zero (S6) and the amount a closure takes out is bounded by what the book holds.
    --
    -- Provenance, the way 035 states it for the drawer: the closure sets the transaction-local
    -- marker to the settlement it is closing immediately before this insert, and the admission of
    -- the fund requires that marker, the depth only a trigger writer reaches, the settlement's own
    -- branch, and the settlement's own opener as the actor.
    PERFORM set_config('luson.closing_fund', NEW.id::text, true);
    INSERT INTO branch_fund_movements(
        branch_location_id, kind, amount, description, created_by_account_id)
    VALUES (NEW.branch_location_id, 'reposicion', NEW.purchase_fund_cash - balance,
        CASE WHEN NEW.purchase_fund_cash > balance
             THEN 'Reposición de la rendición ' || NEW.id
             ELSE 'Devolución del fondo de la rendición ' || NEW.id END,
        NEW.opened_by_account_id);
    PERFORM set_config('luson.closing_fund', '', true);
    RETURN NEW;
END;
$$;
-- Named so it fires after admit_branch_closing_transition of 034/044 ('admit' sorts before
-- 'record'), which is what has already taken the lock and stamped the closure instant this
-- movement shares, and before record_branch_closing_ledger of 035 ('fund' sorts before 'ledger'),
-- although the two books are independent: the order only has to be one order.
CREATE TRIGGER record_branch_closing_fund BEFORE UPDATE ON branch_closings
FOR EACH ROW EXECUTE FUNCTION record_branch_closing_fund();

-- The admission of the fund's ledger, restated whole from 048 with the closing path added:
-- everything of 048 is here statement by statement -- the actor, the founding of a branch, the
-- backfill, the actor of a movement of the period, the freeze, the correction that names a
-- non-correction of its own branch and never exceeds it, and the balance that never goes negative
-- under the lock of the branch -- so every code and every message the branch and the warehouse
-- already read is unchanged.
CREATE OR REPLACE FUNCTION admit_branch_fund_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    actor auth_accounts%ROWTYPE;
    corrected branch_fund_movements%ROWTYPE;
    -- Named apart from the `settlement` alias the backfill of 048 uses, so no plpgsql variable
    -- shadows a table of the statements this function restates.
    funded branch_closings%ROWTYPE;
    used numeric(12,2);
    balance numeric(12,2);
    effect numeric(12,2);
    founding text := nullif(current_setting('luson.branch_founding', true), '');
    closing text := nullif(current_setting('luson.closing_fund', true), '');
BEGIN
    SELECT * INTO actor FROM auth_accounts WHERE id=NEW.created_by_account_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LF001',
            MESSAGE='A fund movement requires a known account';
    END IF;
    -- The fund of a settlement (051, S9), the one movement of this book that its branch cannot
    -- sign: the warehouse states it while the branch is frozen by the settlement that states it.
    -- The provenance is the drawer's (035, 046): the marker names the settlement and the insert
    -- runs from inside a trigger. A client statement runs at depth 1, so a bare set_config
    -- reaches none of this, and the rest of the row is read back from the settlement itself.
    IF closing IS NOT NULL THEN
        IF closing !~ '^[0-9]{1,18}$' THEN
            RAISE EXCEPTION USING ERRCODE='LF001',
                MESSAGE='The closing of a settlement states the fund it leaves';
        END IF;
        IF NEW.kind <> 'reposicion' OR NEW.corrects_id IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='LF001',
                MESSAGE='The closing of a settlement states only the fund it leaves';
        END IF;
        SELECT * INTO funded FROM branch_closings WHERE id=closing::bigint;
        IF NOT FOUND OR funded.branch_location_id <> NEW.branch_location_id
           OR funded.status <> 'proposed' THEN
            RAISE EXCEPTION USING ERRCODE='LF001',
                MESSAGE='The closing states the fund of a settlement it is closing of its own branch';
        END IF;
        IF pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION USING ERRCODE='LF001',
                MESSAGE='The fund of a settlement is written by its closure';
        END IF;
        IF NEW.created_by_account_id <> funded.opened_by_account_id THEN
            RAISE EXCEPTION USING ERRCODE='LF001',
                MESSAGE='The fund of a settlement is stated by the settlement''s own opener';
        END IF;
        -- The balance was measured by the closure under the lock of the branch, and the movement
        -- is the difference it measured, so the sum this rule computes can only grow here: the
        -- zero rule below is answered by construction and is not restated.
        RETURN NEW;
    END IF;
    IF NEW.kind = 'aporte' AND NEW.corrects_id IS NULL THEN
        IF founding IS NOT NULL AND founding <> NEW.branch_location_id::text THEN
            RAISE EXCEPTION USING ERRCODE='LF001',
                MESSAGE='The founding of a branch writes no movement of another branch';
        END IF;
        IF founding = NEW.branch_location_id::text THEN
            IF NOT EXISTS (SELECT 1 FROM locations
                WHERE id = NEW.branch_location_id AND xmin = pg_current_xact_id()::xid) THEN
                RAISE EXCEPTION USING ERRCODE='LF001',
                    MESSAGE='The opening of a fund is written by the transaction that creates its branch';
            END IF;
            PERFORM assert_branch_not_frozen(NEW.branch_location_id);
            RETURN NEW;
        END IF;
        IF current_setting('luson.fund_backfill', true) = 'on' THEN
            IF NOT EXISTS (
                SELECT 1 FROM branch_closings settlement
                WHERE settlement.branch_location_id = NEW.branch_location_id
                  AND settlement.status = 'closed'
                  AND settlement.purchase_fund_cash = NEW.amount
                  AND settlement.closed_at = NEW.occurred_at
                  AND settlement.closed_at = (
                      SELECT max(later.closed_at) FROM branch_closings later
                      WHERE later.branch_location_id = NEW.branch_location_id
                        AND later.status = 'closed')) THEN
                RAISE EXCEPTION USING ERRCODE='LF001',
                    MESSAGE='The opening of a fund states its last closed settlement';
            END IF;
            IF EXISTS (SELECT 1 FROM branch_fund_movements
                WHERE branch_location_id = NEW.branch_location_id) THEN
                RAISE EXCEPTION USING ERRCODE='LF001',
                    MESSAGE='A branch receives the opening of its fund once';
            END IF;
            PERFORM assert_branch_not_frozen(NEW.branch_location_id);
            RETURN NEW;
        END IF;
    END IF;
    IF actor.location_id <> NEW.branch_location_id THEN
        RAISE EXCEPTION USING ERRCODE='LF001',
            MESSAGE='Only the branch records its own fund movements';
    END IF;
    PERFORM assert_branch_not_frozen(NEW.branch_location_id);
    IF NEW.kind = 'correccion' THEN
        SELECT * INTO corrected FROM branch_fund_movements WHERE id=NEW.corrects_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LF001',
                MESSAGE='A correction names a movement of the fund ledger';
        END IF;
        IF corrected.branch_location_id <> NEW.branch_location_id THEN
            RAISE EXCEPTION USING ERRCODE='LF001',
                MESSAGE='A correction names a movement of its own branch';
        END IF;
        IF corrected.kind = 'correccion' THEN
            RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='A correction is not corrected';
        END IF;
        SELECT coalesce(sum(amount),0) INTO used FROM branch_fund_movements
            WHERE corrects_id = corrected.id;
        -- The magnitude, because a `reposicion` of a closure can state money out: what a correction
        -- never exceeds is how much the movement it answers moved, in the direction it moved it.
        IF used + NEW.amount > abs(corrected.amount) THEN
            RAISE EXCEPTION USING ERRCODE='LF002',
                MESSAGE='A correction never exceeds the movement it corrects';
        END IF;
        -- The effect is the opposite of the direction the movement it answers carried (048, restated
        -- for the signed amount of a `reposicion`): money a wrong `compra` took out comes back in,
        -- money a wrong load put in goes back out, and a `reposicion` that took money out -- the
        -- surplus a closure returned -- gives it back when it was a correction of that.
        effect := CASE WHEN corrected.kind IN ('aporte','reposicion')
                       THEN -sign(corrected.amount) * NEW.amount
                       ELSE sign(corrected.amount) * NEW.amount END;
    ELSE
        effect := CASE WHEN NEW.kind IN ('aporte','reposicion') THEN NEW.amount
                       ELSE -NEW.amount END;
    END IF;
    PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);
    SELECT coalesce(sum(effective),0) INTO balance FROM purchase_fund_ledger
        WHERE branch_location_id = NEW.branch_location_id;
    IF balance + effect < 0 THEN
        RAISE EXCEPTION USING ERRCODE='LF003',
            MESSAGE='The purchase fund never goes negative: ' || balance
                || ' in it, ' || NEW.amount || ' requested';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION record_branch_closing_fund() IS
    'Writes the amount a settlement leaves in the purchase fund as the `reposicion` of the branch ledger: the signed difference against sum(effective) of purchase_fund_ledger, whose sign is the direction of the money, so the balance after the closure is the stated amount and never below zero (S6, S9).';
COMMENT ON FUNCTION admit_branch_fund_movement() IS
    'The admission of the purchase fund ledger: who signs a movement, the shape of a correction and that the fund never goes negative (S5-S7). A `reposicion` written by the closure of a settlement is admitted through the marker luson.closing_fund and the trigger depth, and is signed by the settlement''s own opener (S9).';
