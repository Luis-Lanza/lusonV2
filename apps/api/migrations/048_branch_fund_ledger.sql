-- The purchase fund gets the ledger the drawer already had (S5, S7). Until now the fund existed
-- only as two columns of a settlement (`purchase_fund_counted`, `purchase_fund_cash` of 044), so
-- the fund of a branch that had never closed a settlement had no balance at all -- and 044
-- deliberately let a purchase through against it ("an unstated envelope is not zero"). That is
-- the hole this version closes: a fund is a book, its balance is the signed sum of the book, and
-- **el fondo de compras nunca queda negativo** is a rule of the database, in one place.
--
-- Five things are installed and they only make sense together:
--
--   1. `branch_fund_movements`, shaped exactly like the drawer's ledger: four kinds, the same
--      shape rule around `corrects_id`, the same append-only guards, the same stamped instant;
--   2. `purchase_fund_ledger`, the one signed reading of every row: `+` for the money that enters
--      the fund (an `aporte`, a `reposicion`, the correction of a `compra`), `-` for the money
--      that leaves it (`compra`, and the correction of an `aporte`). The fund's balance is
--      `sum(effective)` and nothing else may compute it;
--   3. the admission of the new ledger, mirroring 046's: the actor belongs to that branch, the
--      branch is not frozen, a correction names a non-correction of its own branch and never
--      exceeds it, and an insert that would leave the fund below zero is refused with the balance
--      and the amount in the message;
--   4. `create_branch_funded`, the founding of a branch with its two amounts: it calls the
--      existing `create_branch(text)` -- untouched -- and writes the drawer's opening and the
--      fund's opening as two `aporte` rows signed by the administrator that creates the branch,
--      and nothing at all when both amounts are 0 (S1-S4, S12);
--   5. the backfill of S12: the fund's opening row of every branch that already exists is the
--      `purchase_fund_cash` of its last closed settlement, carrying the instant that settlement
--      closed and not the instant this migration ran.
--
-- Why the drawer's admission of 046 is restated here. S4 states that the branch's initial cash is
-- a movement of the drawer's ledger signed by the admin that creates the branch, and 046 admits a
-- movement of the period only when the actor belongs to the branch. The creator is the warehouse
-- administrator -- 014 leaves no other administrator, and its CHECK ties account 1 to location 1
-- -- and a brand-new branch has no account of its own: an account names the location it belongs
-- to, and the location does not exist until the branch is created. The two facts cannot both
-- hold, so the founding is the one movement of a till that its own branch cannot sign. 046 is not
-- edited -- it is applied and its checksum recorded -- so its function is restated whole with
-- CREATE OR REPLACE: the drawer's own rules, statement by statement, plus the founding path
-- below, exactly as 046 restated 035 and 044 restated 034. Its trigger keeps calling the function
-- it already names.
--
-- Why the founding path cannot be forged with a bare set_config. 046's closing path proves its
-- writer with a transaction-local marker and `pg_trigger_depth() >= 2`, and that works because
-- the writer of a settlement transfer is itself a trigger: a client statement runs at depth 1. A
-- founding is not written by a trigger -- `create_branch_funded` is a function a caller runs --
-- so its insert runs at depth 1, exactly like a client statement, and the depth answers nothing
-- here (measured: a trigger fired by an INSERT inside a function reports depth 1). The founding
-- is therefore proved by the fact S12 asks for and no marker can fake: the branch's own
-- `locations` row was written by this very transaction, and the marker names that branch. A
-- client that sets the marker for a branch that already exists is refused, because the instant of
-- a founding is the transaction that creates the branch: la sucursal y sus dos movimientos nacen
-- juntos, o no nace nada.
--
-- Writing: this file adds one table, one view, three functions of the new ledger, one restated
-- function of the drawer, one founding function and the rows of the backfill. No row of the
-- drawer's ledger is rewritten, no settlement is touched, and `create_branch(text)` keeps its
-- body, its lock and its grant.

-- The ledger of the fund (S5): append only, signed on read, and the four facts a fund states.
-- It mirrors the drawer's table of 034 and 046 column by column, because the two books are read by
-- the same admin and must not need two different readings.
CREATE TABLE branch_fund_movements (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    branch_location_id smallint NOT NULL REFERENCES locations(id),
    -- aporte: money put into the fund -- the founding, or a load the warehouse states.
    -- compra: money the fund paid for a purchase.
    -- reposicion: the amount a closure leaves in the fund for the next period.
    -- correccion: the answer to a movement that was wrong.
    kind text NOT NULL CHECK (kind IN ('aporte','compra','reposicion','correccion')),
    amount numeric(12,2) NOT NULL CHECK (amount > 0),
    description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
    -- The instant the fact is written, stamped by stamp_branch_fund_movement. Only the backfill
    -- states one of its own, and it states the closing instant it comes from.
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_by_account_id integer NOT NULL REFERENCES auth_accounts(id),
    -- The movement this row answers, set only by a `correccion`.
    corrects_id bigint REFERENCES branch_fund_movements(id),
    -- The shape, stated once, exactly as the drawer's ledger states it in 046: exactly one of the
    -- two readings. A correction without a target would be money out of nowhere, and a target on
    -- any other kind would describe a cancelation nothing reads.
    CONSTRAINT branch_fund_movements_correction_shape
        CHECK ((kind = 'correccion') = (corrects_id IS NOT NULL))
);
CREATE INDEX branch_fund_movements_by_branch
    ON branch_fund_movements(branch_location_id, occurred_at);
-- The corrections of one movement are summed on every insertion against it: this is that lookup.
CREATE INDEX branch_fund_movements_corrects ON branch_fund_movements(corrects_id)
WHERE corrects_id IS NOT NULL;

-- Append only, the way the drawer's ledger is (034): a wrong movement is answered by its opposite
-- and never edited, deleted or truncated. TRUNCATE fires no row-level event, so it needs its own
-- statement-level guard.
CREATE TRIGGER protect_branch_fund_movements BEFORE UPDATE OR DELETE ON branch_fund_movements
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_branch_fund_movements_truncate BEFORE TRUNCATE ON branch_fund_movements
EXECUTE FUNCTION protect_pending_request();

-- The ledger as money (S5, S7). One signed reading of every row: the fund's balance is
-- `sum(effective)` over a branch, and a reader that sums `amount` by kind instead would be a
-- second arithmetic -- and two arithmetics is how a book stops closing.
--
-- `effect_kind` is the kind whose direction the row carries: its own, or -- for a correction --
-- the one it answers. `effective` is positive for the two kinds that put money in the fund
-- (`aporte`, `reposicion`) and negative for the one that takes it out (`compra`), and a correction
-- carries the opposite sign of the movement it answers: money a wrong `compra` took out comes back
-- in, and money a wrong `aporte` put in goes back out. Writing the correction's direction as its
-- own would make the book say the error twice.
CREATE VIEW purchase_fund_ledger AS
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
       -- The direction is the one effect_kind states -- money in for an aporte or a reposicion,
       -- out for a compra -- inverted for a correction, which answers that direction instead of
       -- repeating it.
       CASE WHEN ((CASE WHEN movement.kind = 'correccion' THEN corrected.kind
                        ELSE movement.kind END) IN ('aporte','reposicion'))
                 <> (movement.kind = 'correccion')
            THEN movement.amount ELSE -movement.amount END AS effective
  FROM branch_fund_movements movement
  LEFT JOIN branch_fund_movements corrected ON corrected.id = movement.corrects_id;

-- The admission of the fund's ledger: who may append a movement, the shape of a correction, and
-- the rule that the balance never goes negative.
CREATE FUNCTION admit_branch_fund_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    actor auth_accounts%ROWTYPE;
    corrected branch_fund_movements%ROWTYPE;
    used numeric(12,2);
    balance numeric(12,2);
    effect numeric(12,2);
    founding text := nullif(current_setting('luson.branch_founding', true), '');
BEGIN
    SELECT * INTO actor FROM auth_accounts WHERE id=NEW.created_by_account_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LF001',
            MESSAGE='A fund movement requires a known account';
    END IF;
    -- The two openings of a branch, and why they are not signed by the branch (S4, S12). The
    -- founding aporte of the fund -- and the drawer's, in the restated admission below -- is
    -- written by create_branch_funded in the transaction that creates the branch, with the
    -- administrator of that founding as its actor. The marker names the branch; the proof that
    -- this is a founding and not a client borrowing the marker is that the branch's own
    -- `locations` row carries this transaction's id (xmin), which no earlier branch does.
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
        -- The backfill of S12: the marker is not the proof. A row is admitted only when it states
        -- exactly what the statement below writes, condition for condition -- a live branch (never
        -- the warehouse, never a retired one), the account that opened the branch's last closed
        -- settlement, and that settlement's positive fund and closing instant -- so the marker
        -- cannot backdate an opening for a retired branch or the warehouse, sign one with another
        -- branch's account, or open a branch that already has a fund movement.
        IF current_setting('luson.fund_backfill', true) = 'on' THEN
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
    -- A movement of the period states the branch and the actor together: only an account of that
    -- branch moves its own fund, and the warehouse has no fund of its own.
    IF actor.location_id <> NEW.branch_location_id THEN
        RAISE EXCEPTION USING ERRCODE='LF001',
            MESSAGE='Only the branch records its own fund movements';
    END IF;
    PERFORM assert_branch_not_frozen(NEW.branch_location_id);
    IF NEW.kind = 'correccion' THEN
        -- The lock comes first: the sum below decides whether this correction still fits, and two
        -- corrections of the same movement must not read the same total.
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
        -- A movement may be corrected in parts, so what forbids the excess is the total of the
        -- corrections already written against it plus the one being written now.
        SELECT coalesce(sum(amount),0) INTO used FROM branch_fund_movements
            WHERE corrects_id = corrected.id;
        IF used + NEW.amount > corrected.amount THEN
            RAISE EXCEPTION USING ERRCODE='LF002',
                MESSAGE='A correction never exceeds the movement it corrects';
        END IF;
        effect := CASE WHEN corrected.kind IN ('aporte','reposicion') THEN -NEW.amount
                       ELSE NEW.amount END;
    ELSE
        effect := CASE WHEN NEW.kind IN ('aporte','reposicion') THEN NEW.amount
                       ELSE -NEW.amount END;
    END IF;
    -- "El fondo de compras nunca queda negativo" lives here and nowhere else (S6, S7). The balance
    -- is the signed sum of this very ledger, read from `purchase_fund_ledger` so there is no
    -- second arithmetic, and an insert whose money would take it below zero is refused with the
    -- balance and the amount in front of the caller.
    --
    -- The lock is taken before the balance is read, and it is the key of 044 and of the closure of
    -- this branch (340251), deliberately shared: two purchases of one branch can never both fit in
    -- the same remaining amount, and a movement can never read a fund that the closure of the
    -- branch is replacing in the same instant. A key of its own would leave exactly that window
    -- open.
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
CREATE TRIGGER admit_branch_fund_movement BEFORE INSERT ON branch_fund_movements
FOR EACH ROW EXECUTE FUNCTION admit_branch_fund_movement();

-- The instant of a fund movement is the database's, so nobody dates a movement by hand: the row
-- carries the moment it was written.
--
-- The one exception is the backfill of S12, and it is stated here rather than assumed: the
-- opening of an existing branch is the fund its last settlement left behind, and that is a fact
-- of the closing, not of the day this migration ran. The historical instant matters because the
-- book of a branch is read as history: an opening dated today would say the fund appeared with
-- the deployment and would sit after movements the branch already wrote, which is a lie about an
-- order the admin reads. The marker is not the proof -- the admission above refuses a backfill
-- row whose amount and instant are not exactly the ones the branch's last closed settlement
-- stated, on a branch that still has no fund movement -- so a client cannot use it to date a row
-- of its own.
CREATE FUNCTION stamp_branch_fund_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('luson.fund_backfill', true) IS DISTINCT FROM 'on' THEN
        NEW.occurred_at := now();
    END IF;
    RETURN NEW;
END;
$$;
-- Named to fire after the admission: a row the admission refuses is refused with its own code
-- before any instant is written, and the backfill's instant is validated before it is kept.
CREATE TRIGGER stamp_branch_fund_movement BEFORE INSERT ON branch_fund_movements
FOR EACH ROW EXECUTE FUNCTION stamp_branch_fund_movement();

-- The drawer's admission, restated whole from 046 with one path added: the founding of a branch.
-- Everything of 046 is here statement by statement -- the settlement transfer of 035, the actor of
-- a movement of the period, the freeze, and the three refusals of a correction -- so every code
-- and every message the branch and the warehouse already read is unchanged.
CREATE OR REPLACE FUNCTION admit_branch_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    actor auth_accounts%ROWTYPE;
    corrected branch_cash_movements%ROWTYPE;
    used numeric(12,2);
    founding text := nullif(current_setting('luson.branch_founding', true), '');
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

-- The founding of a branch (S1-S4, S12): one transaction that either creates the branch and its
-- two opening movements or creates nothing. Both amounts are required at the call and neither may
-- be negative; 0,00 is a valid and explicit answer, and it writes no movement, because a branch
-- that starts without money for its drawer or its fund is a fact the founding states and not a
-- row of zero that the ledger would have to explain.
--
-- `create_branch(text)` is called as it is: same lock, same allocation of the next identity, same
-- stock fanout of the branch, same grant. What is added here is the money, and the marker that
-- lets the two openings be signed by the administrator that creates the branch.
CREATE FUNCTION create_branch_funded(branch_name text, opening_cash numeric,
    purchase_fund numeric, creator_account_id integer) RETURNS smallint LANGUAGE plpgsql AS $$
DECLARE
    branch_id smallint;
BEGIN
    IF opening_cash IS NULL OR purchase_fund IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='LF001',
            MESSAGE='The founding of a branch states its opening cash and its purchase fund';
    END IF;
    IF opening_cash < 0 OR purchase_fund < 0 THEN
        RAISE EXCEPTION USING ERRCODE='LF001',
            MESSAGE='The opening of a branch is never negative';
    END IF;
    branch_id := create_branch(branch_name);
    -- The provenance of the two openings, set before both inserts and cleared after them: the
    -- marker is what admits an aporte signed by an account that belongs to no branch, and the
    -- guards refuse one for a branch this transaction did not create.
    PERFORM set_config('luson.branch_founding', branch_id::text, true);
    IF opening_cash > 0 THEN
        INSERT INTO branch_cash_movements(branch_location_id,kind,amount,description,
            created_by_account_id)
        VALUES(branch_id,'aporte',opening_cash,'Fondo inicial de caja de la sucursal',
            creator_account_id);
    END IF;
    IF purchase_fund > 0 THEN
        INSERT INTO branch_fund_movements(branch_location_id,kind,amount,description,
            created_by_account_id)
        VALUES(branch_id,'aporte',purchase_fund,'Fondo inicial de compras de la sucursal',
            creator_account_id);
    END IF;
    PERFORM set_config('luson.branch_founding','',true);
    RETURN branch_id;
END;
$$;
-- The founding is the administrator's act: it creates a location and writes money, so it is not
-- callable by everybody, exactly as create_branch(text) is not (014).
REVOKE ALL ON FUNCTION create_branch_funded(text,numeric,numeric,integer) FROM PUBLIC;

-- The backfill of S12: the branches that already exist start with the fund their last closed
-- settlement left behind, and with the instant that settlement closed. A branch that never closed
-- a settlement, or whose last settlement declared no fund, gets no row: an unstated fund is zero
-- (S7), and zero is the empty sum of a book, not a movement somebody would have to read.
--
-- "Its last closed settlement" is read by `closed_at` and never searched for by a positive fund: a
-- branch whose last closure left nothing keeps that answer instead of walking back to an earlier
-- settlement whose instant the admission below refuses, which aborted this version.
--
-- The marker lets the stamp skip exactly these rows, and the admission refuses any other row that
-- claims it, so what the marker opens is the backfill's own numbers and nothing else.
SELECT set_config('luson.fund_backfill','on',true);
INSERT INTO branch_fund_movements(branch_location_id,kind,amount,description,occurred_at,
    created_by_account_id)
SELECT DISTINCT ON (settlement.branch_location_id)
       settlement.branch_location_id,'aporte',settlement.purchase_fund_cash,
       'Fondo inicial de compras de la sucursal',settlement.closed_at,
       settlement.opened_by_account_id
  FROM branch_closings settlement
  JOIN locations branch ON branch.id = settlement.branch_location_id
 WHERE settlement.status = 'closed'
   AND settlement.branch_location_id > 1
   AND branch.deleted_at IS NULL
   AND settlement.purchase_fund_cash IS NOT NULL
   AND settlement.purchase_fund_cash > 0
   AND settlement.closed_at = (
       SELECT max(last.closed_at) FROM branch_closings last
       WHERE last.branch_location_id = settlement.branch_location_id
         AND last.status = 'closed')
 ORDER BY settlement.branch_location_id, settlement.closed_at DESC;
SELECT set_config('luson.fund_backfill','',true);

COMMENT ON TABLE branch_fund_movements IS
    'The signed ledger of a branch purchase fund. Its balance is sum(effective) of purchase_fund_ledger and is computed nowhere else.';
COMMENT ON COLUMN branch_fund_movements.occurred_at IS
    'The instant the fact was written, stamped by stamp_branch_fund_movement. Only the backfill of 048 states one, and it states the closing instant the fund comes from.';
COMMENT ON COLUMN branch_fund_movements.corrects_id IS
    'The movement a correction answers. Set by a correccion and by nothing else.';
COMMENT ON FUNCTION create_branch_funded(text,numeric,numeric,integer) IS
    'Creates a branch with its opening cash and its purchase fund as the two opening aportes of their ledgers, signed by the administrator that creates it.';
