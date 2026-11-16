-- The branch's own ledger grows one kind and one reference (S6, S7): a movement is never edited
-- nor deleted, so an error is answered by a movement that corrects it. This version installs
-- three things at once and they only make sense together:
--
--   1. the kind `correccion`, which states that the row exists because another row was wrong;
--   2. `corrects_id`, the single movement it answers, with the shape rules around it: exactly
--      one of the two, a correction never corrects a correction, and the corrections of one
--      movement never exceed the amount it stated;
--   3. `branch_cash_ledger`, one view that reads every row as signed money, so the drawer of the
--      period, the acta, the metrics and the ledger screen cannot compute two different answers
--      (S13). A `gasto` and a `recaudacion` leave the drawer; an `aporte` enters it; a
--      `correccion` moves it in the opposite direction of the movement it answers.
--
-- And it replaces two guards rather than editing their files: 035 and 042 are applied and their
-- checksums recorded, so the rules are restated whole with CREATE OR REPLACE, exactly as 044
-- restates the transition guard of 034. Their triggers keep calling the functions they name.
--
-- Why the branch may now write an `aporte` or a `recaudacion` of its own (S2). 035 admitted those
-- two kinds only as the closure's transfer of a settlement, because the warehouse is the one that
-- puts money in the till and takes it out. The branch records the act as it happens -- the owner
-- leaves cash for change, the warehouse collects between settlements -- and that movement states
-- the same two facts with `closing_id` NULL, which is exactly what separates a movement of the
-- period from a transfer of the acta (S5). A movement with a `closing_id` still follows every rule
-- of 035: it belongs to a proposed settlement of its own branch and only its closure writes it.
--
-- Why a settled movement is never corrected here (S7). The windows of a branch's closed
-- settlements tile its timeline, so `occurred_at` falling inside one of them is the honest test
-- of "this fact is already signed in an acta". Refusing those keeps the strongest promise of this
-- domain intact: a closed period is never recalculated. Running into one is answered in the
-- settlement's own correction workflow (036, 037, 040), not with a new ledger row.
--
-- Why the tope is a sum and not a single row. A branch may correct one movement in parts, so what
-- forbids the excess is the total of the corrections already written against it plus the one being
-- written now. The corrected row is taken FOR UPDATE before that sum is read, so two concurrent
-- corrections of the same movement cannot both fit under the amount it stated.
--
-- Nothing of the ledger is rewritten: this file adds one column, one view, replaces two functions
-- and one CHECK, and writes no row of any table.

-- Four kinds, and the shape that goes with them: a correction names a movement, anything else
-- names none. The CHECK is dropped by name and added again because 034's was inline on the
-- column; the column itself never changes type.
ALTER TABLE branch_cash_movements
    DROP CONSTRAINT IF EXISTS branch_cash_movements_kind_check;
ALTER TABLE branch_cash_movements
    ADD CONSTRAINT branch_cash_movements_kind_check
    CHECK (kind IN ('gasto','recaudacion','aporte','correccion'));

ALTER TABLE branch_cash_movements
    -- The movement this row answers, set only by a `correccion`.
    ADD COLUMN corrects_id bigint REFERENCES branch_cash_movements(id);

-- The shape, stated once: exactly one of the two readings. A correction without a target would be
-- money out of nowhere, and a target on any other kind would describe a cancelation that the rest
-- of the domain does not read.
ALTER TABLE branch_cash_movements
    ADD CONSTRAINT branch_cash_movements_correction_shape
    CHECK ((kind = 'correccion') = (corrects_id IS NOT NULL));

-- The corrections of one movement are read on every insertion against it: this is that lookup.
CREATE INDEX branch_cash_movements_corrects ON branch_cash_movements(corrects_id)
WHERE corrects_id IS NOT NULL;

-- The ledger as money (S13). One signed reading of every row: the drawer of the period is
-- `sum(effective)` over the rows that belong to no settlement, and the acta's own numbers are the
-- same sum restricted to the window it settled. A reader that sums `amount` by kind instead would
-- be a second arithmetic, and two arithmetics is how a book stops closing.
--
-- `effect_kind` is the kind whose direction the row carries: its own, or -- for a correction --
-- the one it answers. `effective` is positive for an aporte and negative for a gasto or a
-- recaudacion, and a correction carries the opposite sign of the movement it answers: money a
-- wrong `gasto` took out comes back in, and money a wrong `aporte` put in goes back out. Writing
-- the correction's direction as its own would make the book say the error twice.
CREATE VIEW branch_cash_ledger AS
SELECT movement.id,
       movement.branch_location_id,
       movement.closing_id,
       movement.kind,
       movement.amount,
       movement.description,
       movement.occurred_at,
       movement.created_by_account_id,
       movement.corrects_id,
       CASE WHEN movement.kind = 'correccion' THEN corrected.kind ELSE movement.kind END
           AS effect_kind,
       -- The direction is the one effect_kind states -- money in for an aporte, out for a gasto
       -- or a recaudacion -- inverted for a correction, which answers that direction instead of
       -- repeating it.
       CASE WHEN ((CASE WHEN movement.kind = 'correccion' THEN corrected.kind
                        ELSE movement.kind END) = 'aporte')
                 <> (movement.kind = 'correccion')
            THEN movement.amount ELSE -movement.amount END AS effective
  FROM branch_cash_movements movement
  LEFT JOIN branch_cash_movements corrected ON corrected.id = movement.corrects_id;

-- The admission of the ledger, restated whole. Two paths, and the boundary between them is
-- `closing_id`:
--
--   - the transfer of a settlement: every rule of 035, statement by statement;
--   - a movement of the period: the branch's own till, unfrozen, with the four kinds, and the
--     correction guards below.
CREATE OR REPLACE FUNCTION admit_branch_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    actor auth_accounts%ROWTYPE;
    corrected branch_cash_movements%ROWTYPE;
    used numeric(12,2);
BEGIN
    SELECT * INTO actor FROM auth_accounts WHERE id=NEW.created_by_account_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LC011', MESSAGE='Cash movement requires a known account';
    END IF;
    IF NEW.closing_id IS NOT NULL THEN
        -- The money of a settlement is the warehouse's: it moves in the till of the branch that
        -- settlement belongs to, and never by an account of the branch.
        IF actor.id <> 1 OR actor.location_id <> 1 THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='Only the warehouse moves the money of a settlement';
        END IF;
        -- A settlement transfer is written once, by the closure itself, while the row still reads
        -- as proposed. Anything else -- in particular appending money to a closed settlement -- is
        -- refused: that history is fixed by an approved correction, never by a new ledger row.
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
        -- Provenance, checked last so the shape of the row is answered first: the row exists
        -- because the closure of this very settlement is writing it, right now, from inside its
        -- own trigger.
        IF current_setting('luson.closing_ledger', true) IS DISTINCT FROM NEW.closing_id::text
           OR pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION USING ERRCODE='LC020',
                MESSAGE='A cash movement of a settlement is written by its closure';
        END IF;
        RETURN NEW;
    END IF;
    -- A movement of the period states the branch and the actor together: only an account of that
    -- branch writes its own till, and the warehouse has no till of its own to write.
    IF actor.location_id <> NEW.branch_location_id THEN
        RAISE EXCEPTION USING ERRCODE='LC011',
            MESSAGE='Only the branch records its own cash movements';
    END IF;
    PERFORM assert_branch_not_frozen(NEW.branch_location_id);
    IF NEW.kind <> 'correccion' THEN
        RETURN NEW;
    END IF;
    -- The lock comes first: the sum below decides whether this correction still fits, and two
    -- corrections of the same movement must not read the same total.
    SELECT * INTO corrected FROM branch_cash_movements WHERE id=NEW.corrects_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LC030',
            MESSAGE='A correction names a movement of the ledger';
    END IF;
    IF corrected.branch_location_id <> NEW.branch_location_id THEN
        RAISE EXCEPTION USING ERRCODE='LC030',
            MESSAGE='A correction names a movement of its own branch';
    END IF;
    IF corrected.kind = 'correccion' THEN
        RAISE EXCEPTION USING ERRCODE='LC030', MESSAGE='A correction is not corrected';
    END IF;
    IF corrected.closing_id IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='LC030',
            MESSAGE='The transfer of a settlement is corrected in the settlement';
    END IF;
    -- The windows of closed settlements tile the branch's timeline: a movement inside one of them
    -- is already signed in an acta, and an acta is never recalculated (S7).
    IF EXISTS (SELECT 1 FROM branch_closings closing
        WHERE closing.branch_location_id = corrected.branch_location_id
          AND closing.status = 'closed'
          AND corrected.occurred_at >= closing.period_start
          AND corrected.occurred_at < closing.cut_at) THEN
        RAISE EXCEPTION USING ERRCODE='LC030',
            MESSAGE='A movement of a settled period is corrected in the settlement';
    END IF;
    SELECT coalesce(sum(amount),0) INTO used FROM branch_cash_movements
        WHERE corrects_id = corrected.id;
    IF used + NEW.amount > corrected.amount THEN
        RAISE EXCEPTION USING ERRCODE='LC031',
            MESSAGE='A correction never exceeds the movement it corrects';
    END IF;
    RETURN NEW;
END;
$$;

-- The instant of a movement (S3, 042). Until now only a `gasto` was stamped, because the branch
-- wrote nothing else; now every movement of the period is stamped with the database's instant, so
-- none of them can be dated into a window that is already settled. A settlement transfer keeps the
-- instant its closure writes, because that is the closure's fact and not the branch's -- and its
-- `closing_id` is what tells the two apart.
CREATE OR REPLACE FUNCTION stamp_branch_expense() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.closing_id IS NULL THEN
        NEW.occurred_at := now();
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON COLUMN branch_cash_movements.corrects_id IS
    'The movement a correction answers. Set by a correccion and by nothing else.';
COMMENT ON COLUMN branch_cash_movements.occurred_at IS
    'The instant the fact was written. A movement of the period is stamped by stamp_branch_expense; a settlement transfer by its closure.';
