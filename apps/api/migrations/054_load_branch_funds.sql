-- The two funds of a branch that already exists (S1-S6, S9). 048-053 gave a branch its money only
-- while it was being founded, so a branch that already operates has no door for the two amounts: the
-- purchase fund is loaded by opening a settlement -- which freezes the branch exactly when the
-- warehouse wants to enable it (S5) -- and the operational drawer only admits an `aporte` the branch
-- signs for itself, that is, a branch declaring money to itself. This version adds the missing door:
-- **desde Administración, el Almacén carga el fondo de caja operativa y el fondo de compras de una
-- sucursal viva**, as the two `aporte` rows of the two books, signed by the warehouse, and nothing is
-- edited.
--
-- Three things are installed here and they only make sense together:
--
--   1. `branch_fund_load`, the shape of the act: one row of a view -- the branch, the two amounts and
--      the warehouse account that states them -- that stores nothing and is written by its own
--      trigger. La carga no tiene columna que leer después: los hechos que quedan son los dos
--      movimientos, que ya dicen el importe, el autor y el instante;
--   2. `write_branch_fund_load()`, the act itself: both amounts mandatory and never negative, the
--      warehouse as the actor, a live branch that is not the warehouse, the guard of the freeze, and
--      no row at all when the two amounts are 0,00 (S9);
--   3. the two admissions restated whole -- the drawer's from 048 and the fund's from 053 -- with the
--      load's path in them, so every code and every message the branch and the warehouse already read
--      is unchanged. `load_branch_funds(...)` is the name the administration calls.
--
-- **Why the act is written by a trigger, and not by a session marker a caller sets.** The founding of
-- 048/049 proves itself with a marker plus one fact a bare set_config cannot state: the branch's own
-- `locations` row carries this transaction's id, porque una sucursal se funda una sola vez y en la
-- transacción que la crea. Una carga pasa sobre una sucursal que **ya existe**, así que ese hecho no
-- existe para verificarlo, y reutilizar la marca del alta significaría borrar exactamente la
-- comprobación que la hace segura: 048 admite el `aporte` del alta sólo cuando la sucursal nació en
-- esta transacción, y un `aporte` del Almacén admitido para una sucursal vieja es el hueco que ese
-- guard cierra. La marca del cierre tampoco sirve: `luson.closing_fund` prueba una rendición -- nombra
-- una rendición propuesta, la firma su abridor y la fila corre desde dentro de un trigger (052) -- y
-- una carga no es una rendición: no hay acta que la respalde.
--
-- Lo que sí puede probarla es lo que la casa ya usa para el movimiento de un cierre (035, 036, 045,
-- 052): **la marca nombra el hecho y la fila corre desde dentro de un trigger**, porque una sentencia
-- de un cliente corre a profundidad 1 y no llega a ninguna de las dos. Por eso el acto tiene la forma
-- de una vista con su propio trigger: `load_branch_funds` no puede escribir los dos movimientos por
-- sí misma -- una función corre a profundidad 1, tal como 048 midió para el alta -- así que los
-- escribe el trigger de `branch_fund_load`, y son esos inserts los que la admisión de cada libro ve a
-- profundidad 2. Un `INSERT` suelto en un libro con la marca puesta a mano -- `SELECT
-- set_config('luson.branch_funds','2',true); INSERT INTO branch_cash_movements ...` -- se rechaza con
-- el mensaje del guard. La única puerta del acto es la vista, y su trigger es el que aplica todas las
-- reglas: actor, sucursal viva, congelación e importes.
--
-- Escribiendo: este archivo agrega una vista, un trigger y tres funciones -- la guardia compartida, el
-- acto y el nombre que la administración llama -- y reemplaza dos admisiones, cuyos triggers siguen
-- llamando a los nombres que ya tienen. No reescribe ninguna fila de ningún libro, no agrega ninguna
-- tabla y no toca ninguna rendición ni ninguna compra: 048, 052 y 053 se usan tal como están.

-- The shape of the act (S3, S4): one row, the branch, the two amounts and the account that states
-- them. It is a view and not a table because a load leaves no document of its own to read afterwards:
-- the two movements are the fact, and they already state the amount, the author and the instant. What
-- the view adds is the one statement of the act and the trigger that performs it, which is the depth
-- the two admissions below need and a caller cannot reach.
CREATE VIEW branch_fund_load AS
SELECT null::smallint AS branch_location_id,
       null::numeric(12,2) AS opening_cash,
       null::numeric(12,2) AS purchase_fund,
       null::integer AS actor_account_id
 WHERE false;

-- The rules the act and the two books share, in one place (S4, S5): the actor is the warehouse -- and
-- never an account of a branch, so a branch does not load money into itself nor into another branch --,
-- the branch exists, is alive and is not the warehouse, and the branch is not frozen. The freeze is the
-- guard of 035, so its refusal is the settlement's own (LC001) and not a second freeze rule.
CREATE FUNCTION assert_load_of_branch_funds(branch smallint, account integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    actor auth_accounts%ROWTYPE;
    target locations%ROWTYPE;
BEGIN
    SELECT * INTO actor FROM auth_accounts WHERE id = account;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LG001',
            MESSAGE='A fund movement requires a known account';
    END IF;
    IF actor.id <> 1 OR actor.location_id <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='LG001',
            MESSAGE='Only the warehouse loads the funds of a branch';
    END IF;
    SELECT * INTO target FROM locations WHERE id = branch;
    IF NOT FOUND OR branch < 2 OR target.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='LG002', MESSAGE='The load of funds states a live branch';
    END IF;
    PERFORM assert_branch_not_frozen(branch);
END;
$$;

-- The act (S1-S6, S9): one statement that either writes the two movements it states or writes nothing.
-- Both amounts are required and neither is negative; `0,00` is a valid and explicit answer that writes
-- no row at all, because a load of nothing is not an act (S9). Loading does not freeze anything (S6):
-- no settlement is opened and no row of a settlement is written.
CREATE FUNCTION write_branch_fund_load() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.opening_cash IS NULL OR NEW.purchase_fund IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='LG001',
            MESSAGE='The load of the funds of a branch states its opening cash and its purchase fund';
    END IF;
    IF NEW.opening_cash < 0 OR NEW.purchase_fund < 0 THEN
        RAISE EXCEPTION USING ERRCODE='LG001',
            MESSAGE='The load of the funds of a branch is never negative';
    END IF;
    PERFORM assert_load_of_branch_funds(NEW.branch_location_id, NEW.actor_account_id);
    -- 0,00 on both sides is the explicit answer of a load that states nothing (S9): no movement and
    -- no error.
    IF NEW.opening_cash = 0 AND NEW.purchase_fund = 0 THEN
        RETURN NULL;
    END IF;
    -- The provenance of the two rows, set before both inserts and cleared after them: the marker
    -- names the branch and the two admissions require it together with the depth only this trigger
    -- reaches.
    PERFORM set_config('luson.branch_funds', NEW.branch_location_id::text, true);
    IF NEW.opening_cash > 0 THEN
        INSERT INTO branch_cash_movements(branch_location_id, kind, amount, description,
            created_by_account_id)
        VALUES (NEW.branch_location_id, 'aporte', NEW.opening_cash,
            'Fondo de caja operativa de la sucursal', NEW.actor_account_id);
    END IF;
    IF NEW.purchase_fund > 0 THEN
        INSERT INTO branch_fund_movements(branch_location_id, kind, amount, description,
            created_by_account_id)
        VALUES (NEW.branch_location_id, 'aporte', NEW.purchase_fund,
            'Fondo de compras de la sucursal', NEW.actor_account_id);
    END IF;
    PERFORM set_config('luson.branch_funds', '', true);
    RETURN NULL;
END;
$$;
CREATE TRIGGER write_branch_fund_load INSTEAD OF INSERT ON branch_fund_load
FOR EACH ROW EXECUTE FUNCTION write_branch_fund_load();

-- The name the administration calls (S1, S3): the act as one statement. It states no rule of its own
-- -- the trigger above is the one place -- and it exists so the façade has one name to reach and one
-- name to revoke, exactly as the founding has.
CREATE FUNCTION load_branch_funds(branch_location_id smallint, opening_cash numeric,
    purchase_fund numeric, actor_account_id integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO branch_fund_load(branch_location_id, opening_cash, purchase_fund, actor_account_id)
    VALUES (branch_location_id, opening_cash, purchase_fund, actor_account_id);
END;
$$;
-- The load is the administrator's act -- it writes money into a branch that did not ask for it -- so
-- it is not callable by everybody, exactly as the founding is not (049).
REVOKE ALL ON FUNCTION load_branch_funds(smallint,numeric,numeric,integer) FROM PUBLIC;

-- The drawer's admission, restated whole from 048 with one path added: the load of the two funds of a
-- branch that already exists. Everything of 048 is here statement by statement -- the settlement
-- transfer of 035, the founding of a branch, the actor of a movement of the period, the freeze and the
-- four refusals of a correction -- so every code and every message the branch and the warehouse
-- already read is unchanged.
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

-- The admission of the fund's ledger, restated whole from 053 with the load's path in it, and
-- everything else statement by statement: the closure's statement, the devolucion only a closure
-- writes, the movement of the period that names no settlement, the founding, the backfill, the actor
-- of a movement of the period, the freeze, the shape of a correction and its tope, the one expression
-- of the sign and the balance that never goes negative under the lock (340251), with every code and
-- message unchanged.
CREATE OR REPLACE FUNCTION admit_branch_fund_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    actor auth_accounts%ROWTYPE; corrected branch_fund_movements%ROWTYPE;
    funded branch_closings%ROWTYPE; -- named apart from the `settlement` alias of 048's backfill
    used numeric(12,2); balance numeric(12,2); effect numeric(12,2); by_closing boolean := false;
    founding text := nullif(current_setting('luson.branch_founding', true), ''); closing text := nullif(current_setting('luson.closing_fund', true), '');
    load_funds text := nullif(current_setting('luson.branch_funds', true), '');
BEGIN
    SELECT * INTO actor FROM auth_accounts WHERE id=NEW.created_by_account_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='A fund movement requires a known account'; END IF;
    -- The load of the funds of a branch that already exists (054, S1-S6): the warehouse states the fund
    -- of a branch it did not found, and the act that states it -- its marker and its depth -- is the proof.
    IF load_funds IS NOT NULL AND NEW.kind = 'aporte' AND NEW.corrects_id IS NULL
       AND NEW.closing_id IS NULL THEN
        IF load_funds <> NEW.branch_location_id::text THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='The load of funds writes no movement of another branch'; END IF;
        IF pg_trigger_depth() < 2 THEN RAISE EXCEPTION USING ERRCODE='LF001', MESSAGE='A load of funds is written by the act that states it'; END IF;
        PERFORM assert_load_of_branch_funds(NEW.branch_location_id, NEW.created_by_account_id);
        RETURN NEW;
    END IF;
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
                IF NOT EXISTS (
                    SELECT 1 FROM branch_closings settlement
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

COMMENT ON VIEW branch_fund_load IS
    'The shape of the act of loading the two funds of a branch that already exists (S1-S6): the branch, the two amounts and the warehouse account that states them. It stores nothing; its trigger writes the two aportes of the books.';
COMMENT ON FUNCTION assert_load_of_branch_funds(smallint,integer) IS
    'The rules the act of a load and the two books share: the actor is the warehouse, the branch exists, is alive and is not the warehouse, and the branch is not frozen (S4, S5).';
COMMENT ON FUNCTION write_branch_fund_load() IS
    'The act of loading the two funds of a branch: both amounts mandatory and never negative, 0,00 on both sides writes nothing, and the two aportes of the books are written under the provenance marker luson.branch_funds, which the two admissions honour only at the depth a trigger reaches (S1-S6, S9).';
COMMENT ON FUNCTION load_branch_funds(smallint,numeric,numeric,integer) IS
    'Loads the operating cash and the purchase fund of a branch that already exists as the two aportes of their books, signed by the warehouse, only when an amount is positive and only on a live, unfrozen branch that is not the warehouse (S1-S6, S9).';
