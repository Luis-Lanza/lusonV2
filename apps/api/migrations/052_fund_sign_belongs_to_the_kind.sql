-- The sign belongs to the kind, and the kind is what the guard and the view both read (S5, S6, S9).
-- 051 settled the fund of a closure through the branch's book; this version corrects the three
-- defects its review found. It corrects them *here* and not in 051 for the reason every applied
-- version is left alone: 051 is applied and its checksum is recorded, so a database that already
-- ran it is upgraded by adding this version, and a database that applies the whole prefix gets 051
-- and then this file, which restates what it replaces. The three defects and their answers:
--
--   1. Two arithmetics for one sign. 051 restated the admission of the fund with the effect of a
--      correction computed by hand -- `-sign(corrected.amount) * NEW.amount` -- while the view of
--      048, which owns `effective`, reads the direction from the kind. For the signed `reposicion`
--      that 051 introduced the two disagree, and a correction the guard measured as money in is
--      money out in the book: a closure's own row could be answered and the fund driven below zero
--      through a check that measured something else (S6). The answer is one expression --
--      `branch_fund_effective()` -- which `purchase_fund_ledger` publishes and which
--      `admit_branch_fund_movement()` measures with, so no second, hand-made formula exists.
--
--   2. A sign in the amount is a sign anybody can write. 051 made the amount of a `reposicion`
--      signed, so an account of the branch could insert a negative reposición directly and drain
--      the fund with no settlement at all, bypassing the provenance the closure has (S9). The
--      house's own rule answers it: **the sign belongs to the kind, never to the amount**. Every
--      movement carries a positive amount again, and the two directions a closure states have two
--      names -- `reposicion` for the fund the warehouse leaves and `devolucion` for the surplus it
--      takes back -- so the money that leaves the fund is a kind that the admission attributes to
--      the closure alone, through the marker 051 already uses and the row's own `closing_id`.
--
--   3. A closed acta is never recalculated. The read of 051 replaced the frozen
--      `purchase_fund_cash` of a closed settlement with the ledger's sum whenever the branch had
--      any row of the book, so a settlement closed before 051 -- whose closure wrote no movement --
--      changed the number it had published as soon as a load or a purchase landed in the book, and
--      the opening of the next period changed with it (S5, S7). The answer is that the movement of
--      a closure names the settlement that states it (`closing_id`), and a closed settlement is
--      read from the book **only** when its own closure wrote that movement; every other closed
--      settlement keeps the number it settled. `settled_purchase_fund()` is where that rule lives,
--      and the acta, the opening of the next period and the card of the envelope read it there.
--
-- **Why a kind and not a signed amount.** A sign stored in the amount is a sign any writer of the
-- book can choose, so the direction of the money would be a value a client states instead of a fact
-- of the document that states it: an account of the branch could take money out of the fund with no
-- settlement behind it, which is exactly the hole finding 2 describes. A kind is a fact of the
-- document -- a purchase spends, a closure states, a correction answers -- and the amount is then
-- only how much. Two kinds for the two directions of a closure also let the admission name the one
-- only a closure may write, which a sign can never say: `-400.00` and `400.00` are the same writer.
--
-- What this file writes: one column and one index on the fund's ledger, three restatements of its
-- checks, one function of the sign, one restated view, one read of a closed settlement, two
-- restated functions (the closure's writer and the ledger's admission; their triggers keep calling
-- the names they already have) and the comments of all of it. No row is inserted, updated or
-- deleted here, no settlement and no purchase is rewritten, and 048, 050 and 051 are used exactly
-- as they are.

-- The movement a closure wrote names the settlement that stated it (S9). 051 proved the writer with
-- a transaction-local marker, and that marker is gone once the transaction commits: the book kept no
-- fact saying which settlement a movement of the fund belongs to, so a reader could only guess it
-- from the instant the row carried. The column is that fact, and finding 3 is a read of it: a closed
-- settlement publishes the book only when a movement names it, and never because the branch happens
-- to have a book. A settlement states its fund once, so the column is unique where it is set.
ALTER TABLE branch_fund_movements ADD COLUMN closing_id bigint REFERENCES branch_closings(id);
CREATE UNIQUE INDEX branch_fund_movements_by_closing
    ON branch_fund_movements(closing_id) WHERE closing_id IS NOT NULL;

-- The two directions of a closure have two names (S5, S6): what the warehouse leaves is the
-- `reposicion` of 048, and what it takes back is a `devolucion`. The shape of the two is stated with
-- them -- a movement of the period names no settlement, a `devolucion` is always the statement of
-- one, and a movement that names a settlement is one of those two kinds -- so a row of the book can
-- be neither money out of the period nor a correction attached to an acta.
ALTER TABLE branch_fund_movements DROP CONSTRAINT branch_fund_movements_kind_check;
ALTER TABLE branch_fund_movements ADD CONSTRAINT branch_fund_movements_kind_check
    CHECK (kind IN ('aporte','compra','reposicion','devolucion','correccion'));
ALTER TABLE branch_fund_movements ADD CONSTRAINT branch_fund_movements_closing_shape CHECK (
    (kind <> 'devolucion' OR closing_id IS NOT NULL)
    AND (closing_id IS NULL OR (kind IN ('reposicion','devolucion') AND corrects_id IS NULL)));

-- The amount of every movement is positive again (S6): the sign is the kind's and never the
-- amount's, so a `devolucion` is how the fund says money left it and no amount of any kind can be
-- negative. This is the relaxation of 051 withdrawn, and it is withdrawn for everything.
--
-- NOT VALID, and stated here so it is not read as an oversight: a database that applied 051 may
-- hold the negative `reposicion` rows that version admitted, and this book is append only (048) --
-- no row is rewritten, deleted or re-created, not even to satisfy a rule stated later. The
-- constraint binds every row written from this version on, which is the rule; the rows 051 wrote
-- keep the amount they were written with and are read by the kind they carry, exactly as 048's view
-- always read them -- a `reposicion` with a negative amount is money out of the fund, and
-- `branch_fund_effective` below reads it that way.
ALTER TABLE branch_fund_movements DROP CONSTRAINT branch_fund_movements_amount_check;
ALTER TABLE branch_fund_movements ADD CONSTRAINT branch_fund_movements_amount_check
    CHECK (amount > 0) NOT VALID;

-- The signed effect of one row of the fund, in one place (S5, S6). 048's view published it as
-- `effective` and 048/051's admission measured the balance it moves, as two expressions of the same
-- rule; with a signed amount they stopped agreeing. It is written once here and read by both: the
-- direction is the kind's -- money in for an `aporte` or a `reposicion`, money out for a `compra` or
-- a `devolucion` -- inverted for a `correccion`, which carries the direction of the movement it
-- answers instead of a direction of its own. The answered kind is the caller's fact: a correction
-- names it, and every other row does not have one.
CREATE FUNCTION branch_fund_effective(kind text, amount numeric, answered_kind text)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
        WHEN kind <> 'correccion' AND kind IN ('aporte','reposicion') THEN amount
        WHEN kind <> 'correccion' THEN -amount
        WHEN answered_kind IN ('aporte','reposicion') THEN -amount
        ELSE amount END
$$;

-- The ledger as money (S5, S7), restated from 048 with its one arithmetic named instead of written:
-- every row of the view is one row of the table, `effect_kind` is the kind whose direction the row
-- carries, and `effective` is what `branch_fund_effective` answers. The balance of the fund is
-- `sum(effective)` and nothing else may compute it, and the admission of the ledger now measures
-- that same expression, so the guard and the book it guards cannot disagree again.
CREATE OR REPLACE VIEW purchase_fund_ledger AS
SELECT movement.id,
       movement.branch_location_id,
       movement.kind,
       movement.amount,
       movement.description,
       movement.occurred_at,
       movement.created_by_account_id,
       movement.corrects_id,
       CASE WHEN movement.kind = 'correccion' THEN corrected.kind ELSE movement.kind END
           AS effect_kind,
       branch_fund_effective(movement.kind, movement.amount,
           CASE WHEN movement.kind = 'correccion' THEN corrected.kind END) AS effective
  FROM branch_fund_movements movement
  LEFT JOIN branch_fund_movements corrected ON corrected.id = movement.corrects_id;

-- The fund one closed settlement published, in one place (S5, S7, S9). Three readers want it -- the
-- acta of the settlement, the opening of the next period and the card of the envelope -- and 051 let
-- each of them read the book unconditionally, which is what recalculated a closed acta. The rule is
-- stated once, here:
--
--   * the book answers for a settlement whose own closure wrote its movement -- the row whose
--     `closing_id` names it -- because that closure is what reconciled the book to the amount the
--     settlement stated, so the sum at its own instant is exactly that amount;
--   * the posted number, `purchase_fund_cash`, answers for every other closed settlement: one that
--     closed before a closure settled the fund through its book (051), or one that stated exactly
--     what the book already held and so wrote no row. It is the number the acta published, and a
--     historical acta is never recalculated.
--
-- The one settlement the book still answers without a movement of its own closure is the one that
-- stated nothing at all: an unstated fund is zero and not unknown (S7), the closure left the book as
-- it was, and the sum at that instant is the fund it left.
--
-- NULL when the settlement does not exist. A caller holding the row of the settlement cannot reach
-- that, and the read fails closed instead of publishing a number about nothing.
CREATE FUNCTION settled_purchase_fund(branch smallint, closed_at timestamptz)
RETURNS numeric LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN settled.purchase_fund_cash IS NULL
                     OR EXISTS (SELECT 1 FROM branch_fund_movements movement
                                 WHERE movement.closing_id = settled.id)
                THEN coalesce((SELECT sum(ledger.effective) FROM purchase_fund_ledger ledger
                                WHERE ledger.branch_location_id = settled.branch_location_id
                                  AND ledger.occurred_at <= settled.closed_at),0)
                ELSE settled.purchase_fund_cash END
      FROM branch_closings settled
     WHERE settled.branch_location_id = $1
       AND settled.closed_at = $2
       AND settled.status = 'closed'
$$;

-- The fund a closure leaves, restated from 051 with the sign in the kind and the settlement named by
-- the row (S9, S6). The delta is still the difference between the amount the warehouse states and
-- the balance the book holds at that instant, read from `purchase_fund_ledger` under the lock of the
-- branch (340251), so the balance after the closure is the stated amount by construction. What
-- changes is how the difference is said: a positive difference is a `reposicion` (the warehouse
-- loads the fund) and a negative one is a `devolucion` (it takes the surplus back), both with a
-- positive amount, because the direction is the kind's. A difference of zero writes nothing -- zero
-- is the empty sum of a book and not a movement to explain -- and an unstated fund writes nothing
-- either, because it leaves the book as the book has it.
--
-- The provenance is 051's and one fact more: the marker `luson.closing_fund` names the settlement,
-- the insert runs at the depth only a trigger reaches, the actor is the settlement's own opener, and
-- the row names the settlement it states, so the acta of that settlement can read its own movement
-- afterwards (`settled_purchase_fund`).
CREATE OR REPLACE FUNCTION record_branch_closing_fund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    balance numeric(12,2);
    difference numeric(12,2);
    direction text;
BEGIN
    IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
        RETURN NEW;
    END IF;
    -- A settlement that states no amount leaves the fund as the book has it, and an unstated fund is
    -- zero and not unknown (S7): no column, no movement, and the acta publishes the signed sum.
    IF NEW.purchase_fund_cash IS NULL THEN
        RETURN NEW;
    END IF;
    -- The lock of 044, 048 and of this very closure (340251), taken before the balance is read. The
    -- transition guard of 044 already took it for this closure in this same transaction, so this
    -- call is free; it is stated here because the read below is what it protects -- two closures, or
    -- a closure and a purchase, can never read the same balance and both write it.
    PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);
    SELECT coalesce(sum(effective),0) INTO balance FROM purchase_fund_ledger
        WHERE branch_location_id = NEW.branch_location_id;
    IF NEW.purchase_fund_cash = balance THEN
        -- The settlement leaves exactly what the fund holds: the book is already right and no row of
        -- it is needed to say so.
        RETURN NEW;
    END IF;
    -- The difference is the statement and its direction is a kind: the fund the warehouse leaves is
    -- a `reposicion`, the surplus it takes back is a `devolucion`, and neither amount is signed.
    IF NEW.purchase_fund_cash > balance THEN
        difference := NEW.purchase_fund_cash - balance;
        direction := 'reposicion';
    ELSE
        difference := balance - NEW.purchase_fund_cash;
        direction := 'devolucion';
    END IF;
    -- Provenance, the way 035 states it for the drawer: the closure sets the transaction-local
    -- marker to the settlement it is closing immediately before this insert, and the admission of
    -- the fund requires that marker, the depth only a trigger writer reaches, the settlement's own
    -- branch, the settlement's own opener as the actor, and the settlement named by the row itself.
    PERFORM set_config('luson.closing_fund', NEW.id::text, true);
    INSERT INTO branch_fund_movements(
        branch_location_id, kind, amount, description, created_by_account_id, closing_id)
    VALUES (NEW.branch_location_id, direction, difference,
        CASE WHEN direction = 'reposicion'
             THEN 'Reposición de la rendición ' || NEW.id
             ELSE 'Devolución del fondo de la rendición ' || NEW.id END,
        NEW.opened_by_account_id, NEW.id);
    PERFORM set_config('luson.closing_fund', '', true);
    RETURN NEW;
END;
$$;

-- The admission of the fund's ledger, restated whole from 051 with the three corrections of this
-- version in it. Everything of 048 and 051 that is not about the sign is here statement by statement
-- -- the actor, the founding of a branch, the backfill, the actor of a movement of the period, the
-- freeze, the correction that names a non-correction of its own branch and never exceeds it, and the
-- balance that never goes negative under the lock of the branch -- so every code and every message
-- the branch and the warehouse already read is unchanged. What changes:
--
--   * the effect of the row is `branch_fund_effective`, the expression the view publishes, for every
--     path including the closure's (finding 1). The guard and the book it guards cannot disagree;
--   * money that leaves the fund is the kind `devolucion`, and only the closure of a settlement may
--     write it (finding 2): a branch account that writes one is refused, and a movement of the
--     period that names a settlement is refused with it;
--   * the row of a closure names the settlement it states and must name the very settlement being
--     closed (finding 3), which is what lets a closed acta read its own movement and no other.
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
    -- The one row of this book its branch cannot sign is the statement of its closure, and this is
    -- the path it takes. Every other row is a movement of the period and is judged as 048 judged it.
    by_closing boolean := false;
    founding text := nullif(current_setting('luson.branch_founding', true), '');
    closing text := nullif(current_setting('luson.closing_fund', true), '');
BEGIN
    SELECT * INTO actor FROM auth_accounts WHERE id=NEW.created_by_account_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LF001',
            MESSAGE='A fund movement requires a known account';
    END IF;
    -- The fund of a settlement (051, 052, S9), the one movement of this book that its branch cannot
    -- sign: the warehouse states it while the branch is frozen by the settlement that states it. The
    -- provenance is the drawer's (035, 046): the marker names the settlement and the insert runs from
    -- inside a trigger. A client statement runs at depth 1, so a bare set_config reaches none of this,
    -- and the rest of the row is read back from the settlement itself.
    IF closing IS NOT NULL THEN
        IF closing !~ '^[0-9]{1,18}$' THEN
            RAISE EXCEPTION USING ERRCODE='LF001',
                MESSAGE='The closing of a settlement states the fund it leaves';
        END IF;
        -- The two directions of a closure, and no third: the fund the settlement leaves and the
        -- surplus it takes back. A correction is never written by a closure -- a wrong statement is
        -- answered by an appended correction of the period that follows.
        IF NEW.kind NOT IN ('reposicion','devolucion') OR NEW.corrects_id IS NOT NULL THEN
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
        -- The settlement the row names is the one being closed, and not merely one of its branch: it
        -- is the fact a reader uses to know that this book was reconciled to that acta (finding 3).
        IF NEW.closing_id IS DISTINCT FROM funded.id THEN
            RAISE EXCEPTION USING ERRCODE='LF001',
                MESSAGE='The fund of a settlement names the settlement it is closing';
        END IF;
        by_closing := true;
    END IF;
    IF NOT by_closing THEN
        -- Money out of the fund is the statement of a closure and of nothing else (finding 2). A
        -- `devolucion` written by a branch account is money leaving the fund with no settlement
        -- behind it -- the hole a signed amount used to open -- so it is refused here by name.
        IF NEW.kind = 'devolucion' THEN
            RAISE EXCEPTION USING ERRCODE='LF001',
                MESSAGE='Only the closing of a settlement takes money out of the fund';
        END IF;
        -- A movement of the period belongs to the period: naming a settlement would describe an acta
        -- the closure of that settlement did not write, and the acta would then read a book it never
        -- stated.
        IF NEW.closing_id IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='LF001',
                MESSAGE='A movement of the period belongs to no settlement';
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
                -- This admission is restated by later versions, so the backfill predicates must travel with it.
                IF NOT EXISTS (
                    SELECT 1 FROM branch_closings settlement
                    JOIN locations branch ON branch.id = settlement.branch_location_id
                    WHERE settlement.branch_location_id = NEW.branch_location_id
                      AND settlement.branch_location_id > 1
                      AND branch.deleted_at IS NULL
                      AND settlement.status = 'closed'
                      AND settlement.purchase_fund_cash IS NOT NULL
                      AND settlement.purchase_fund_cash > 0
                      AND settlement.purchase_fund_cash = NEW.amount
                      AND settlement.closed_at = NEW.occurred_at
                      AND settlement.opened_by_account_id = NEW.created_by_account_id
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
            -- The magnitude, and only because the book may hold the rows 051 admitted under its
            -- signed rule (see the amount check above): what a correction never exceeds is how much
            -- the movement it answers moved. For every row this version admits that is the amount
            -- itself, which is positive.
            IF used + NEW.amount > abs(corrected.amount) THEN
                RAISE EXCEPTION USING ERRCODE='LF002',
                    MESSAGE='A correction never exceeds the movement it corrects';
            END IF;
        END IF;
    END IF;
    -- The signed effect of this row, read from the one expression the view publishes (finding 1). The
    -- direction of a correction is the opposite of the movement it answers, so the kind it answers is
    -- carried in; every other row carries its own kind and no answered one.
    effect := branch_fund_effective(NEW.kind, NEW.amount,
        CASE WHEN NEW.kind = 'correccion' THEN corrected.kind END);
    -- "El fondo de compras nunca queda negativo" lives here and nowhere else (S6, S7). The balance is
    -- the signed sum of this very ledger, read from `purchase_fund_ledger` so there is no second
    -- arithmetic, and an insert whose money would take it below zero is refused with the balance and
    -- the amount in front of the caller. The closure's own statement is measured by this same rule,
    -- and it cannot fail it: the difference the closure wrote is the one that lands the book on the
    -- amount 044 keeps non-negative.
    --
    -- The lock is taken before the balance is read, and it is the key of 044 and of the closure of
    -- this branch (340251), deliberately shared: two purchases of one branch can never both fit in
    -- the same remaining amount, and a movement can never read a fund that the closure of the branch
    -- is replacing in the same instant. A key of its own would leave exactly that window open.
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

COMMENT ON COLUMN branch_fund_movements.closing_id IS
    'The settlement whose closure wrote this movement. Set by the closure of a settlement and by nothing else, and unique: it is how a closed acta knows that the book was reconciled to it (S9, 052).';
COMMENT ON FUNCTION branch_fund_effective(text,numeric,text) IS
    'The signed effect of one movement of the fund: the direction of its kind (money in for aporte and reposicion, out for compra and devolucion), inverted for a correccion. purchase_fund_ledger publishes it as effective and admit_branch_fund_movement measures with it, so the guard and the book cannot disagree (S5, S6).';
COMMENT ON FUNCTION settled_purchase_fund(smallint,timestamptz) IS
    'The fund one closed settlement published: the signed sum of purchase_fund_ledger at its closed_at when its own closure wrote the movement that reconciled it, and the amount it stated otherwise, so a closed acta is never recalculated (S5, S7, S9).';
COMMENT ON FUNCTION record_branch_closing_fund() IS
    'Writes the amount a settlement leaves in the purchase fund as a `reposicion` (the fund the warehouse loads) or a `devolucion` (the surplus it takes back) of the branch ledger: the difference against sum(effective) of purchase_fund_ledger, always positive, so the balance after the closure is the stated amount and never below zero (S6, S9).';
COMMENT ON FUNCTION admit_branch_fund_movement() IS
    'The admission of the purchase fund ledger: who signs a movement, the shape of a correction, the direction a kind carries and that the fund never goes negative (S5-S7). A `reposicion` or a `devolucion` written by the closure of a settlement is admitted through the marker luson.closing_fund, the trigger depth, the settlement''s own opener and the settlement the row names (S9).';
