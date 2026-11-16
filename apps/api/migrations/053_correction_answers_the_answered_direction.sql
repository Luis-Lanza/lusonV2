-- A correction answers the row it answers: its own amount takes the opposite direction of the effect of that
-- row, so the answered row's own amount and direction decide and not its kind alone (R3-001, S5, S6). 052
-- took the direction of a correction from the answered kind alone, which states one only while the kind is
-- the only fact that states it. A row written before 052 may carry a direction its kind no longer implies --
-- 051 admitted a negative `reposicion`, money out of the fund, which the `NOT VALID` amount check of 052
-- keeps and the book reads as money out -- and 052 turned the correction of that row back to money out:
-- answering it either failed the balance guard or drained the fund instead of restoring what it took.
-- This file writes the one expression that says it (`branch_fund_effective`, now told the answered amount
-- too), the view that publishes it and the admission that measures with it; no row is written here, and 052
-- is left as it is, because its checksum is recorded and this version upgrades a database that applied it.

-- The signed effect of one row, told the answered row's amount as well as its kind (S5, S6). A row that is
-- not a correction carries the direction of its kind, as 048 and 052 read it. A correction carries its own
-- amount with the opposite direction of the effect of the row it answers -- which is what the legacy negative
-- `reposicion` needs to be answered with money in -- and it is total for every kind: a correction that names
-- no answered kind answers with its own amount, exactly as 052 did.
CREATE OR REPLACE FUNCTION branch_fund_effective(
    kind text, amount numeric, answered_kind text, answered_amount numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
        WHEN kind <> 'correccion' AND kind IN ('aporte','reposicion') THEN amount
        WHEN kind <> 'correccion' THEN -amount
        WHEN answered_kind IS NULL THEN amount
        -- The direction is the answered effect's; the magnitude is this row's own amount.
        ELSE amount * -sign(CASE WHEN answered_kind IN ('aporte','reposicion') THEN answered_amount
                                 ELSE -answered_amount END) END
$$;

-- The ledger as money (S5, S7), restated from 052 with the answered row's amount in the one expression.
CREATE OR REPLACE VIEW purchase_fund_ledger AS
SELECT movement.id, movement.branch_location_id, movement.kind, movement.amount,
       movement.description, movement.occurred_at, movement.created_by_account_id,
       movement.corrects_id,
       CASE WHEN movement.kind = 'correccion' THEN corrected.kind ELSE movement.kind END
           AS effect_kind,
       branch_fund_effective(movement.kind, movement.amount,
           CASE WHEN movement.kind = 'correccion' THEN corrected.kind END,
           CASE WHEN movement.kind = 'correccion' THEN corrected.amount END) AS effective
  FROM branch_fund_movements movement
  LEFT JOIN branch_fund_movements corrected ON corrected.id = movement.corrects_id;

-- The expression of 052 took no answered amount, so a caller reaching it by name gets the withdrawn answer.
DROP FUNCTION branch_fund_effective(text,numeric,text);

-- The admission of the fund's ledger, restated from 052 with one statement changed -- the effect it
-- measures is told the answered row's amount -- and everything else statement by statement: the actor, the
-- founding, the backfill, the movement of the period, the shape of a correction and its tope, the freeze,
-- the provenance of a closure's row and the balance that never goes negative under the lock (340251), with
-- every code and message unchanged.
CREATE OR REPLACE FUNCTION admit_branch_fund_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    actor auth_accounts%ROWTYPE; corrected branch_fund_movements%ROWTYPE;
    funded branch_closings%ROWTYPE; -- named apart from the `settlement` alias of 048's backfill
    used numeric(12,2); balance numeric(12,2); effect numeric(12,2); by_closing boolean := false;
    founding text := nullif(current_setting('luson.branch_founding', true), ''); closing text := nullif(current_setting('luson.closing_fund', true), '');
BEGIN
    SELECT * INTO actor FROM auth_accounts WHERE id=NEW.created_by_account_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='A fund movement requires a known account'; END IF;
    -- The fund of a settlement (051, 052, S9): the marker names it and the row is read back from it.
    IF closing IS NOT NULL THEN
        IF closing !~ '^[0-9]{1,18}$' THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='The closing of a settlement states the fund it leaves'; END IF;
        IF NEW.kind NOT IN ('reposicion','devolucion') OR NEW.corrects_id IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='The closing of a settlement states only the fund it leaves'; END IF;
        SELECT * INTO funded FROM branch_closings WHERE id=closing::bigint;
        IF NOT FOUND OR funded.branch_location_id <> NEW.branch_location_id OR funded.status <> 'proposed' THEN
            RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='The closing states the fund of a settlement it is closing of its own branch'; END IF;
        IF pg_trigger_depth() < 2 THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='The fund of a settlement is written by its closure'; END IF;
        IF NEW.created_by_account_id <> funded.opened_by_account_id THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='The fund of a settlement is stated by the settlement''s own opener'; END IF;
        IF NEW.closing_id IS DISTINCT FROM funded.id THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='The fund of a settlement names the settlement it is closing'; END IF;
        by_closing := true;
    END IF;
    IF NOT by_closing THEN
        IF NEW.kind = 'devolucion' THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='Only the closing of a settlement takes money out of the fund'; END IF;
        IF NEW.closing_id IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='A movement of the period belongs to no settlement'; END IF;
        IF NEW.kind = 'aporte' AND NEW.corrects_id IS NULL THEN
            IF founding IS NOT NULL AND founding <> NEW.branch_location_id::text THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='The founding of a branch writes no movement of another branch'; END IF;
            IF founding = NEW.branch_location_id::text THEN
                IF NOT EXISTS (SELECT 1 FROM locations WHERE id = NEW.branch_location_id AND xmin = pg_current_xact_id()::xid) THEN
                    RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='The opening of a fund is written by the transaction that creates its branch'; END IF;
                PERFORM assert_branch_not_frozen(NEW.branch_location_id);
                RETURN NEW;
            END IF;
            IF current_setting('luson.fund_backfill', true) = 'on' THEN
                -- This admission is restated by later versions, so the backfill predicates must travel with it.
                IF NOT EXISTS (SELECT 1 FROM branch_closings settlement
                    JOIN locations branch ON branch.id = settlement.branch_location_id
                    WHERE settlement.branch_location_id = NEW.branch_location_id AND settlement.branch_location_id > 1
                      AND branch.deleted_at IS NULL AND settlement.status = 'closed'
                      AND settlement.purchase_fund_cash IS NOT NULL AND settlement.purchase_fund_cash > 0
                      AND settlement.purchase_fund_cash = NEW.amount AND settlement.closed_at = NEW.occurred_at
                      AND settlement.opened_by_account_id = NEW.created_by_account_id
                      AND settlement.closed_at = (SELECT max(later.closed_at) FROM branch_closings later
                          WHERE later.branch_location_id = NEW.branch_location_id AND later.status = 'closed')) THEN
                    RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='The opening of a fund states its last closed settlement';
                END IF;
                IF EXISTS (SELECT 1 FROM branch_fund_movements WHERE branch_location_id = NEW.branch_location_id) THEN
                    RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='A branch receives the opening of its fund once'; END IF;
                PERFORM assert_branch_not_frozen(NEW.branch_location_id);
                RETURN NEW;
            END IF;
        END IF;
        IF actor.location_id <> NEW.branch_location_id THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='Only the branch records its own fund movements'; END IF;
        PERFORM assert_branch_not_frozen(NEW.branch_location_id);
        IF NEW.kind = 'correccion' THEN
            SELECT * INTO corrected FROM branch_fund_movements WHERE id=NEW.corrects_id FOR UPDATE;
            IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='A correction names a movement of the fund ledger'; END IF;
            IF corrected.branch_location_id <> NEW.branch_location_id THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='A correction names a movement of its own branch'; END IF;
            IF corrected.kind = 'correccion' THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='A correction is not corrected'; END IF;
            SELECT coalesce(sum(amount),0) INTO used FROM branch_fund_movements WHERE corrects_id = corrected.id;
            IF used + NEW.amount > abs(corrected.amount) THEN RAISE EXCEPTION USING ERRCODE='LF002', MESSAGE='A correction never exceeds the movement it corrects'; END IF;
        END IF;
    END IF;
    -- The effect of this row, from the one expression the view publishes: a correction is its own amount in the
    -- opposite direction of the effect of the row it answers, so that row's amount travels with its kind.
    effect := branch_fund_effective(NEW.kind, NEW.amount, CASE WHEN NEW.kind = 'correccion' THEN corrected.kind END,
        CASE WHEN NEW.kind = 'correccion' THEN corrected.amount END);
    -- "El fondo de compras nunca queda negativo" lives here and nowhere else (S6, S7): the balance is the
    -- signed sum of this ledger, under the key of 044 and of the closure of this branch (340251), so no
    -- movement reads a fund the closure is replacing in the same instant.
    PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);
    SELECT coalesce(sum(effective),0) INTO balance FROM purchase_fund_ledger WHERE branch_location_id = NEW.branch_location_id;
    IF balance + effect < 0 THEN
        RAISE EXCEPTION USING ERRCODE='LF003', MESSAGE='The purchase fund never goes negative: ' || balance
            || ' in it, ' || NEW.amount || ' requested';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION branch_fund_effective(text,numeric,text,numeric) IS
    'The signed effect of one movement of the fund: the direction of its kind (money in for aporte and reposicion, out for compra and devolucion) and, for a correccion, its own amount in the opposite direction of the effect of the row it answers, which that row''s own amount and direction decide. purchase_fund_ledger publishes it as effective and admit_branch_fund_movement measures with it, so the guard and the book cannot disagree (S5, S6, R3-001).';
