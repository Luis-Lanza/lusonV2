-- 060 -- the drawer that never goes negative (S1-S6)
--
-- The branch's operating till is the money it spends during the period: the fund the last closed
-- settlement left, plus the cash its sales collected, plus the signed effect of every movement it
-- recorded. Until now nothing bounded it. `branch_cash_movements` asserted a positive amount
-- (034), and the admission of 054 returned before reading any balance for every kind that is not
-- a correction, so a branch could record a `gasto` of more than its till held and the expectation
-- simply went negative -- visible only at the settlement, when the shortage had already been
-- spent.
--
-- This migration states the expectation once (`branch_drawer_expected`) and refuses the movement
-- that would spend beyond it (`LC032`). It bounds the drawer and nothing else: the four refusals
-- of a correction answer first, exactly as in 054, and the transfers of an acta are written by the
-- closure of its settlement, so they never reach the guard (S6). Money in is never refused (S3),
-- which is what lets a branch reconcile a physical till the system has not recorded yet.
--
-- The purchase fund keeps its own rule (LF003). The two envelopes are separate and neither bounds
-- the other; what is added here is that the drawer cannot be spent below zero, not that it pays
-- for purchases.
--
--   S1 a movement that would make the expectation negative is refused
--   S2 what is available is the expectation: inherited + cash sales + signed effect
--   S3 money in is never refused
--   S4 the refusal names itself, so the caller states it instead of guessing
--   S5 every refusal of 054 keeps its precedence
--   S6 the transfers of a settlement are outside the rule
--
-- Nothing is rewritten and no data is touched: three functions are redefined -- the sign, the
-- expectation and the admission -- the ledger's view is redefined to read the sign from the one
-- function instead of its own arithmetic, and one index is added for the read the guard does.

-- The signed effect of one movement, stated once: positive for money in (an `aporte`), negative
-- for money out (a `gasto` or a `recaudacion`), and the opposite of the direction it answers for a
-- correction. The ledger's view and the guard below both read this function, so the book and the
-- bound can never disagree about which way a row moves the drawer.
CREATE OR REPLACE FUNCTION branch_cash_effective(kind text, corrected_kind text, amount numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN (CASE WHEN kind = 'correccion' THEN corrected_kind ELSE kind END = 'aporte')
                     <> (kind = 'correccion')
                THEN amount ELSE -amount END
$$;

-- What the branch's till holds right now (S2), stated once: the amount the last closed settlement
-- left, plus the cash its sales collected since, plus the signed effect of the movements of that
-- same window. The window is the reader's, term for term: the same last closed settlement, the
-- same cut, and only the movements that name no settlement -- the transfers of an acta belong to
-- the acta, not to the book of the period.
--
-- A branch that closed nothing yet inherits nothing and reads its whole history, which is the same
-- answer `DrawerExpected` gives for an opening of zero. The open side of the window is stated as one
-- bound -- `created_at >= coalesce(since, '-infinity')` instead of `since IS NULL OR ...` -- because
-- this function is called from a trigger: after five executions its plan goes generic, and only a
-- predicate of that shape stays an index qual of the branch's window instead of reading every sale
-- the branch ever made. Every term is bounded by numeric(12,2), so the sum is exact.
CREATE OR REPLACE FUNCTION branch_drawer_expected(p_branch smallint)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE
    opening numeric(12,2) := 0;
    since timestamptz;
    collected numeric(12,2);
    effect numeric(12,2);
BEGIN
    SELECT closing_cash, cut_at INTO opening, since
      FROM branch_closings
     WHERE branch_location_id = p_branch AND status = 'closed'
     ORDER BY cut_at DESC, id DESC
     LIMIT 1;
    IF NOT FOUND THEN
        opening := 0;
        since := NULL;
    END IF;
    SELECT coalesce(sum(sale.cash_amount), 0) INTO collected
      FROM sales sale
     WHERE sale.branch_location_id = p_branch
       AND sale.created_at >= coalesce(since, '-infinity'::timestamptz);
    SELECT coalesce(sum(ledger.effective), 0) INTO effect
      FROM branch_cash_ledger ledger
     WHERE ledger.branch_location_id = p_branch
       AND ledger.closing_id IS NULL
       AND ledger.occurred_at >= coalesce(since, '-infinity'::timestamptz);
    RETURN opening + collected + effect;
END;
$$;

-- The read the guard does on every movement out of the till, indexed by the window it sums: a
-- guard that reads a balance cannot scan the branch's whole sales history to answer.
CREATE INDEX sales_branch_cash_window ON sales(branch_location_id, created_at);

-- The one refusal of this migration, stated once: the movement is admitted only when what the till
-- holds after it is not negative. The lock of the branch is taken first -- the same key the freeze
-- and the two ledgers use -- so two movements of one till never read the same balance, and so a
-- movement never races the closing that opens or closes its window.
CREATE OR REPLACE FUNCTION assert_branch_drawer_holds(p_branch smallint, p_kind text,
    p_corrected_kind text, p_amount numeric) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    effect numeric(12,2);
    holds numeric(12,2);
BEGIN
    effect := branch_cash_effective(p_kind, p_corrected_kind, p_amount);
    -- Money in needs no read (S3): an aporte is admitted on an empty till, which is the whole
    -- point of being able to reconcile one.
    IF effect >= 0 THEN
        RETURN;
    END IF;
    PERFORM pg_advisory_xact_lock(340251, p_branch::integer);
    holds := branch_drawer_expected(p_branch);
    IF holds + effect < 0 THEN
        RAISE EXCEPTION USING ERRCODE='LC032',
            MESSAGE='The drawer does not hold the cash of this movement';
    END IF;
END;
$$;

-- The book, restated from 046 with its sign read from the one function instead of its own CASE.
-- Every column keeps its name, its order and its type: a reader of `branch_cash_ledger` cannot
-- tell this migration happened.
CREATE OR REPLACE VIEW branch_cash_ledger AS
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
       branch_cash_effective(movement.kind, corrected.kind, movement.amount) AS effective
  FROM branch_cash_movements movement
  LEFT JOIN branch_cash_movements corrected ON corrected.id = movement.corrects_id;

-- The drawer's admission, restated whole from 054 with one path added: the balance the till holds
-- decides whether a movement of the period is admitted. Everything of 054 is here statement by
-- statement -- the load of the two funds, the settlement transfer of 035, the founding of a
-- branch, the actor of a movement of the period, the freeze and the four refusals of a correction
-- -- so every code and every message the branch and the warehouse already read is unchanged, and
-- every refusal keeps its precedence (S5): the guard answers last, after all of them.
CREATE OR REPLACE FUNCTION admit_branch_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    actor auth_accounts%ROWTYPE;
    corrected branch_cash_movements%ROWTYPE;
    used numeric(12,2);
    founding text := nullif(current_setting('luson.branch_founding', true), '');
    load_funds text := nullif(current_setting('luson.branch_funds', true), '');
BEGIN
    SELECT * INTO actor FROM auth_accounts WHERE id=NEW.created_by_account_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LC011', MESSAGE='Cash movement requires a known account';
    END IF;
    -- The load of the funds of a branch that already exists (054, S1-S6): the movement of a till its
    -- own branch cannot sign, because the warehouse states it, and the act that states it is the
    -- proof. See the header of this migration: the marker names the branch and the row runs at the
    -- depth only a trigger reaches, so a client statement with a bare set_config is refused here.
    IF load_funds IS NOT NULL AND NEW.kind = 'aporte' AND NEW.corrects_id IS NULL
       AND NEW.closing_id IS NULL THEN
        IF load_funds <> NEW.branch_location_id::text THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='The load of funds writes no movement of another branch';
        END IF;
        IF pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='A load of funds is written by the act that states it';
        END IF;
        PERFORM assert_load_of_branch_funds(NEW.branch_location_id, NEW.created_by_account_id);
        RETURN NEW;
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
        -- S6: the closure states the money of the acta, and the acta's own checks govern it. The
        -- drawer's bound is about what a branch spends during the period, not about what a
        -- settlement transfers out of it.
        RETURN NEW;
    END IF;
    -- The founding of a branch (S4, S12), the one movement of a till its own branch cannot sign:
    -- the creator is the warehouse administrator and the branch has no account yet. It is
    -- admitted only when the marker names this branch AND the branch's own `locations` row was
    -- written by this transaction, which is what a client with a bare set_config cannot state.
    -- See the header of this migration: the depth of a founding insert is 1, so it cannot be the
    -- proof here, the way it is for a settlement transfer.
    IF NEW.kind = 'aporte' AND NEW.corrects_id IS NULL THEN
        IF founding IS NOT NULL AND founding <> NEW.branch_location_id::text THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='The founding of a branch writes no movement of another branch';
        END IF;
        IF founding = NEW.branch_location_id::text THEN
            IF NOT EXISTS (SELECT 1 FROM locations
                WHERE id = NEW.branch_location_id AND xmin = pg_current_xact_id()::xid) THEN
                RAISE EXCEPTION USING ERRCODE='LC011',
                    MESSAGE='The opening contribution of a branch is written by the transaction that creates it';
            END IF;
            PERFORM assert_branch_not_frozen(NEW.branch_location_id);
            RETURN NEW;
        END IF;
    END IF;
    -- A movement of the period states the branch and the actor together: only an account of that
    -- branch writes its own till, and the warehouse has no till of its own to write.
    IF actor.location_id <> NEW.branch_location_id THEN
        RAISE EXCEPTION USING ERRCODE='LC011',
            MESSAGE='Only the branch records its own cash movements';
    END IF;
    PERFORM assert_branch_not_frozen(NEW.branch_location_id);
    IF NEW.kind <> 'correccion' THEN
        -- The one rule of this migration (S1): a movement of the period is admitted only when the
        -- till still holds what it spends.
        PERFORM assert_branch_drawer_holds(NEW.branch_location_id, NEW.kind, NULL, NEW.amount);
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
    -- A correction answers the direction it corrects, so correcting an `aporte` takes money out of
    -- the till and obeys the same bound (S1). It answers last, after its own four refusals (S5).
    PERFORM assert_branch_drawer_holds(NEW.branch_location_id, NEW.kind, corrected.kind, NEW.amount);
    RETURN NEW;
END;
$$;
