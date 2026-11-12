-- Closing corrections, applied: what an accepted correction of a closed settlement does.
--
-- 034 gives the correction its shape -- append only, a mandatory reason, one pending at a
-- time, the warehouse proposes and the branch decides -- but nothing applies it. This
-- migration is that application, and it is the whole of it: the correction workflow is
-- proposal and decision (034), the effect of the decision is here.
--
-- A closed settlement is never reopened or rewritten (S16, LC005). The accepted correction
-- therefore records what changed and by how much, and the deltas are applied as the
-- settlement's own journal entries: its row, its count sheet, its commission, its fund,
-- its totals and its ledger stay exactly as the branch signed them. A reader derives the
-- corrected value as the closed number plus the deltas, the way 034 derives the cash of a
-- period from the facts that produce it; a stored copy could disagree with them.
--
-- The payload (jsonb) is this domain's, so its shape is fixed here and nowhere else. Every
-- field is optional and at least one is required:
--
--   {
--     "counted_quantities": [{"variant_id": 1, "counted_quantity": 8}],
--     "commission_amount":  "516.27",
--     "closing_cash":       "60.00"
--   }
--
--   counted_quantities -- the corrected counted quantity of the named variant. The delta
--     against the settlement's own closing_count_lines.counted_quantity -- as its accepted
--     corrections have already amended it -- is applied to inventory_balances of the
--     branch in both directions, and refused (LC007, naming the variant) when the result
--     would fall below the reserved stock: the existence of a variant never ends up under
--     what the branch already promised (S5). A variant absent from the payload is not
--     touched, and a variant whose count line the settlement does not have is refused
--     (LC021): there is no recorded count to take a difference against.
--   commission_amount: the corrected commission of the period. The commission is
--     informational money settled outside the system and it participates in no cash
--     identity (S9), so the correction moves no till, appends no ledger row and touches no
--     balance. Its delta is recorded in closing_correction_effects, which is where the
--     corrected value is visible and auditable next to the reason the branch accepted.
--   closing_cash: the corrected fund of the settlement. That number is the opening cash
--     of the next period (S10), so a fund error is a drawer error and the mechanism below
--     is the one design decision of this migration.
--
-- Why the fund delta is not a ledger row. The ledger of a closed settlement is its
-- history: 035 refuses any aporte or recaudacion that does not come from the closure of a
-- settlement that still reads 'proposed' (LC011, LC020), and 034 refuses appending to a
-- row it has closed. Rewriting the settlement or its transfer is the one thing S16
-- forbids, so the delta cannot be a movement of the closed settlement's own ledger.
--
-- Why it is not a movement of the open period either. When a correction is decided there
-- usually is no open period at all: a period only opens when the warehouse visits the
-- branch again (S2), which is exactly the moment the next settlement is created. So the
-- coherent place to apply the fund delta is the only place the drawer chain is still
-- extensible: the opening cash of the settlement that has not been created yet.
--
-- The mechanism, then: an accepted fund delta is recorded in closing_correction_effects
-- and apply_closing_correction_fund below folds the deltas of the branch's most recent
-- closed settlement into the opening_cash that 034's admit_branch_closing just inherited
-- from it, so the identity of the drawer chain stays exactly
--
--   opening_cash(n+1) = closing_cash(n) + sum of the fund deltas accepted for n
--
-- and the delta is applied once: it is inherited by the next opening and from then on the
-- next closure's fund is the basis of the following one. A fund delta accepted when a
-- later settlement already exists -- open, proposed, rejected or closed -- is refused with
-- LC022, because that period already started from the recorded fund and its opening cash
-- is frozen by 034: there is no coherent place left to apply it, and silently leaving the
-- drawer wrong is the corruption this refusal exists to prevent.
--
-- The invariants of the ledger survive untouched, because no ledger row is written here at
-- all: the cash ledger stays append-only, one transfer of each kind per settlement, and no
-- settlement is ever reopened or rewritten. Nothing here freezes or unfreezes a branch
-- either: it does not write branch_closings at all, so a closed settlement stays closed and
-- the branch stays as free as it was.
--
-- The settlement of a branch is written by one writer at a time (034), and the fund delta
-- has to serialise with the opener that reads it: apply_closing_correction takes the same
-- per-branch advisory lock the opener, the closure and the freeze guards take, before it
-- reads or writes anything.
--
-- Codes: LC021 the payload is not a correction this domain reads, LC022 the fund of a
-- settlement is corrected before the next period starts, LC023 a correction effect is
-- written by the acceptance of its own correction. LC006 and LC007 are the ones the
-- closure of 034/035 already uses for the same two facts: the fund never exceeds the
-- drawer, and a counted variant never leaves the stock under its reservation.
--
-- Additive only: 001-035 are applied and checksummed, so nothing of theirs is rewritten,
-- replaced or dropped; every rule below is a new table, a new function or a new trigger.

-- The journal of the deltas an accepted correction applied. One row per applied delta and
-- not one per correction: a correction that touches two variants writes two rows, so a
-- reader never has to parse a payload to know what moved, and the same row is what the
-- next opening reads for the fund. amount_delta is money (commission and fund),
-- quantity_delta is a count (stock), and exactly one of them is set for each kind, so an
-- effect can never be read as the wrong unit.
CREATE TABLE closing_correction_effects (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    correction_id bigint NOT NULL REFERENCES closing_corrections(id),
    -- The settlement the correction corrects. The database copies it from the correction
    -- instead of trusting the writer, so an effect can never be attributed elsewhere.
    closing_id bigint NOT NULL REFERENCES branch_closings(id),
    kind text NOT NULL CHECK (kind IN ('stock','commission','fund')),
    variant_id integer REFERENCES catalog_variants(id),
    quantity_delta bigint CHECK (quantity_delta <> 0),
    amount_delta numeric(12,2) CHECK (amount_delta <> 0),
    CHECK (kind <> 'stock'
        OR (variant_id IS NOT NULL AND quantity_delta IS NOT NULL AND amount_delta IS NULL)),
    CHECK (kind = 'stock'
        OR (variant_id IS NULL AND quantity_delta IS NULL AND amount_delta IS NOT NULL))
);
-- A correction states each delta once: a second row for the same variant or for the same
-- amount would apply the same difference twice.
CREATE UNIQUE INDEX closing_correction_effects_once
    ON closing_correction_effects(correction_id, kind, coalesce(variant_id, 0));
-- The next opening reads the fund deltas of one settlement: this is that lookup.
CREATE INDEX closing_correction_effects_by_settlement
    ON closing_correction_effects(closing_id, kind);

-- An effect exists because the branch accepted its correction, and for no other reason.
-- The acceptance of the correction sets the transaction-local marker
-- 'luson.closing_correction' to the correction it is applying and inserts from inside its
-- own trigger; a client statement runs at trigger depth 1, so a hand written effect is
-- refused even if the caller sets the marker itself. This is the provenance rule of 035's
-- cash ledger (R3-003) applied to the one table that can move a drawer: a forged fund
-- effect would rewrite the opening cash of the next period.
CREATE FUNCTION admit_closing_correction_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE correction closing_corrections%ROWTYPE;
BEGIN
    SELECT * INTO correction FROM closing_corrections WHERE id = NEW.correction_id;
    IF NOT FOUND OR correction.status <> 'accepted' THEN
        RAISE EXCEPTION USING ERRCODE='LC023',
            MESSAGE='An effect belongs to an accepted correction';
    END IF;
    NEW.closing_id := correction.closing_id;
    IF current_setting('luson.closing_correction', true) IS DISTINCT FROM NEW.correction_id::text
       OR pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION USING ERRCODE='LC023',
            MESSAGE='A correction effect is written when its correction is accepted';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_closing_correction_effect BEFORE INSERT ON closing_correction_effects
FOR EACH ROW EXECUTE FUNCTION admit_closing_correction_effect();

-- The journal is append only, like every other ledger of this vertical: a delta that was
-- applied is a fact of the drawer and of the stock, and it is undone by its opposite, never
-- by editing it.
CREATE TRIGGER protect_closing_correction_effects BEFORE UPDATE OR DELETE ON closing_correction_effects
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_closing_correction_effects_truncate BEFORE TRUNCATE ON closing_correction_effects
EXECUTE FUNCTION protect_pending_request();

-- One amount, one reader: every money correction is a canonical two-decimal amount written
-- as a JSON string, never a binary float (S20). A JSON number is refused instead of being
-- rounded by PostgreSQL on the way in, because the value the branch accepted has to be the
-- value that was applied, digit for digit.
CREATE FUNCTION closing_correction_amount(raw jsonb, field text) RETURNS numeric(12,2)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE text_value text;
BEGIN
    IF raw IS NULL OR jsonb_typeof(raw) <> 'string' THEN
        RAISE EXCEPTION USING ERRCODE='LC021',
            MESSAGE='The corrected ' || field || ' is a two-decimal amount, not a number';
    END IF;
    text_value := raw #>> '{}';
    IF text_value !~ '^[0-9]{1,10}\.[0-9]{2}$' THEN
        RAISE EXCEPTION USING ERRCODE='LC021',
            MESSAGE='The corrected ' || field || ' must be a two-decimal amount, got ' || text_value;
    END IF;
    RETURN text_value::numeric(12,2);
END;
$$;

-- The payload is the warehouse's offer of a correction, so it is validated when it is
-- proposed -- while the warehouse still holds it -- and not when the branch has already
-- accepted a shape this domain cannot apply. Everything it refuses is refused before a row
-- exists, which is why the guard is BEFORE INSERT and why it does not write anything.
--
-- The guard owns the shape and the facts it can read from the closed settlement: the
-- variant is on its count sheet, the corrected fund does not exceed the drawer that was
-- counted plus the contribution the warehouse made (LC006, the same bound the closure
-- enforces), and nothing else is carried along. The arithmetic of the stock is not its
-- business: the reservation a corrected quantity has to respect is the reservation at the
-- moment the branch accepts, so it is answered by the application below.
CREATE FUNCTION guard_closing_correction_payload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header branch_closings%ROWTYPE;
    field text;
    entry record;
    variant integer;
    corrected bigint;
    corrected_fund numeric(12,2);
    seen integer[] := '{}';
    excess numeric(12,2);
BEGIN
    IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION USING ERRCODE='LC021', MESSAGE='A correction payload is an object';
    END IF;
    -- Every field is one this domain applies: a correction that quietly carried a value
    -- nobody reads would be a correction the branch believed it accepted.
    FOR field IN SELECT jsonb_object_keys(NEW.payload) LOOP
        IF field NOT IN ('counted_quantities','commission_amount','closing_cash') THEN
            RAISE EXCEPTION USING ERRCODE='LC021',
                MESSAGE='A correction has no field ' || field;
        END IF;
    END LOOP;
    IF NOT (NEW.payload ? 'counted_quantities' OR NEW.payload ? 'commission_amount'
            OR NEW.payload ? 'closing_cash') THEN
        RAISE EXCEPTION USING ERRCODE='LC021',
            MESSAGE='A correction states counted_quantities, commission_amount or closing_cash';
    END IF;
    SELECT * INTO header FROM branch_closings WHERE id = NEW.closing_id;
    IF NEW.payload ? 'counted_quantities' THEN
        IF jsonb_typeof(NEW.payload->'counted_quantities') <> 'array' THEN
            RAISE EXCEPTION USING ERRCODE='LC021',
                MESSAGE='The corrected quantities are an array of counted quantities';
        END IF;
        FOR entry IN SELECT jsonb_array_elements(NEW.payload->'counted_quantities') AS item LOOP
            IF jsonb_typeof(entry.item) <> 'object' THEN
                RAISE EXCEPTION USING ERRCODE='LC021',
                    MESSAGE='A corrected quantity states variant_id and counted_quantity';
            END IF;
            IF (SELECT count(*) FROM jsonb_object_keys(entry.item) AS key
                WHERE key NOT IN ('variant_id','counted_quantity')) <> 0 THEN
                RAISE EXCEPTION USING ERRCODE='LC021',
                    MESSAGE='A corrected quantity states variant_id and counted_quantity and nothing else';
            END IF;
            IF coalesce(entry.item->>'variant_id','') !~ '^[1-9][0-9]{0,8}$' THEN
                RAISE EXCEPTION USING ERRCODE='LC021',
                    MESSAGE='A corrected quantity names its variant by id';
            END IF;
            -- Shape first, cast second: the quantity is only turned into a number once the
            -- text is proven to be digits, so a refused payload can never surface as a
            -- cast error instead of the domain code the surface maps.
            IF coalesce(entry.item->>'counted_quantity','') !~ '^[0-9]{1,7}$' THEN
                RAISE EXCEPTION USING ERRCODE='LC021',
                    MESSAGE='A corrected quantity is a whole quantity between 0 and 1000000';
            END IF;
            variant := (entry.item->>'variant_id')::integer;
            corrected := (entry.item->>'counted_quantity')::bigint;
            IF corrected > 1000000 THEN
                RAISE EXCEPTION USING ERRCODE='LC021',
                    MESSAGE='A corrected quantity is a whole quantity between 0 and 1000000';
            END IF;
            IF variant = ANY(seen) THEN
                RAISE EXCEPTION USING ERRCODE='LC021',
                    MESSAGE='Variant ' || variant || ' is corrected once';
            END IF;
            seen := seen || variant;
            -- A variant the closed settlement never counted has no recorded quantity to
            -- take a difference against, so correcting it would invent stock.
            IF NOT EXISTS (SELECT 1 FROM closing_count_lines line
                WHERE line.closing_id = NEW.closing_id AND line.variant_id = variant) THEN
                RAISE EXCEPTION USING ERRCODE='LC021',
                    MESSAGE='Variant ' || variant || ' is not on the count sheet of this settlement';
            END IF;
        END LOOP;
    END IF;
    IF NEW.payload ? 'commission_amount' THEN
        PERFORM closing_correction_amount(NEW.payload->'commission_amount', 'commission');
    END IF;
    -- The fund is money that stays in the branch, so it never exceeds what the drawer held
    -- at the cut: the cash counted plus the contribution the warehouse made. The same bound
    -- the closure of 034 enforces, with the same code and the same sentence.
    IF NEW.payload ? 'closing_cash' THEN
        corrected_fund := closing_correction_amount(NEW.payload->'closing_cash', 'fund');
        excess := corrected_fund - header.counted_cash - header.contributed_cash;
        IF excess > 0 THEN
            RAISE EXCEPTION USING ERRCODE='LC006',
                MESSAGE='The corrected fund exceeds the cash counted plus the contribution by '
                    || excess;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
-- Named to fire after admit_closing_correction (034), which normalizes the row: PostgreSQL
-- runs the BEFORE ROW triggers of one table in name order, and 'admit' sorts before 'guard'.
CREATE TRIGGER guard_closing_correction_payload BEFORE INSERT ON closing_corrections
FOR EACH ROW EXECUTE FUNCTION guard_closing_correction_payload();

-- Acceptance is the only thing that applies a correction, and this is the only place that
-- does it. Rejection applies nothing -- this function only runs on proposed -> accepted --
-- and a correction that is already decided can never reach it again, because 034 refuses
-- every later update of a decided correction (LC013).
CREATE FUNCTION apply_closing_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header branch_closings%ROWTYPE;
    entry record;
    variant integer;
    recorded_quantity bigint;
    amended_quantity bigint;
    delta_quantity bigint;
    balance inventory_balances%ROWTYPE;
    recorded_amount numeric(12,2);
    amended_amount numeric(12,2);
    delta_amount numeric(12,2);
BEGIN
    IF OLD.status <> 'proposed' OR NEW.status <> 'accepted' THEN
        RETURN NULL;
    END IF;
    SELECT * INTO header FROM branch_closings WHERE id = NEW.closing_id;
    IF NOT FOUND OR header.status <> 'closed' THEN
        RAISE EXCEPTION USING ERRCODE='LC012',
            MESSAGE='Only a closed settlement is corrected';
    END IF;
    -- One writer per branch at a time (034), for the same reason the opener takes it: the
    -- sums below are read while a concurrent opener could be inheriting the fund this very
    -- correction changes.
    PERFORM pg_advisory_xact_lock(340251, header.branch_location_id::integer);
    -- Every effect written from here until the marker is cleared is this correction's.
    PERFORM set_config('luson.closing_correction', NEW.id::text, true);
    -- Stock: the corrected counted quantity, as a difference against the sheet as the
    -- accepted corrections have amended it, applied to the balance in both directions. The
    -- base is the settlement's own counted quantity, never today's balance: the branch may
    -- have traded since the closure, and the correction states what it counted, not what
    -- the balance should be rewritten to.
    FOR entry IN SELECT jsonb_array_elements(
        coalesce(NEW.payload->'counted_quantities', '[]'::jsonb)) AS item LOOP
        variant := (entry.item->>'variant_id')::integer;
        SELECT line.counted_quantity INTO recorded_quantity FROM closing_count_lines line
        WHERE line.closing_id = NEW.closing_id AND line.variant_id = variant;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LC021',
                MESSAGE='Variant ' || variant || ' is not on the count sheet of this settlement';
        END IF;
        SELECT coalesce(sum(effect.quantity_delta),0) INTO amended_quantity
        FROM closing_correction_effects effect
        WHERE effect.closing_id = NEW.closing_id AND effect.kind = 'stock'
          AND effect.variant_id = variant;
        delta_quantity := (entry.item->>'counted_quantity')::bigint
            - recorded_quantity - amended_quantity;
        CONTINUE WHEN delta_quantity = 0;
        SELECT * INTO balance FROM inventory_balances
        WHERE location_id = header.branch_location_id AND variant_id = variant FOR UPDATE;
        -- The existence never ends up under what the branch already promised (S5), and it
        -- never ends up negative: the refusal names the variant that blocks it.
        IF coalesce(balance.existing,0) + delta_quantity < coalesce(balance.reserved,0) THEN
            RAISE EXCEPTION USING ERRCODE='LC007',
                MESSAGE='Variant ' || variant || ' would fall below the reserved stock';
        END IF;
        -- Only `existing` is written, exactly like the closure of 035: the reservation is
        -- never the database's to move. A variant counted above its expected quantity may
        -- have no balance row at all, and then the correction creates it.
        INSERT INTO inventory_balances(location_id, variant_id, existing, reserved)
        VALUES (header.branch_location_id, variant,
            coalesce(balance.existing,0) + delta_quantity, 0)
        ON CONFLICT (location_id, variant_id)
        DO UPDATE SET existing = EXCLUDED.existing;
        INSERT INTO closing_correction_effects(correction_id, closing_id, kind, variant_id,
            quantity_delta)
        VALUES (NEW.id, NEW.closing_id, 'stock', variant, delta_quantity);
    END LOOP;
    -- Commission: informational money, settled outside the system (S9). The delta is
    -- recorded in the journal and goes no further: no till, no ledger row, no balance.
    IF NEW.payload ? 'commission_amount' THEN
        SELECT coalesce(sum(effect.amount_delta),0) INTO amended_amount
        FROM closing_correction_effects effect
        WHERE effect.closing_id = NEW.closing_id AND effect.kind = 'commission';
        delta_amount := closing_correction_amount(NEW.payload->'commission_amount', 'commission')
            - (header.commission_amount + amended_amount);
        IF delta_amount <> 0 THEN
            INSERT INTO closing_correction_effects(correction_id, closing_id, kind, amount_delta)
            VALUES (NEW.id, NEW.closing_id, 'commission', delta_amount);
        END IF;
    END IF;
    -- Fund: the corrected fund is the opening cash of the next period, so it is recorded as
    -- a delta the next opening reads (apply_closing_correction_fund). It is only coherent
    -- while that period has not started: once a later settlement exists, its opening cash is
    -- frozen by 034 and the drawer chain cannot be corrected in place any more.
    IF NEW.payload ? 'closing_cash' THEN
        IF EXISTS (SELECT 1 FROM branch_closings later
            WHERE later.branch_location_id = header.branch_location_id
              AND later.id <> header.id
              AND (later.status <> 'closed' OR later.closed_at > header.closed_at)) THEN
            RAISE EXCEPTION USING ERRCODE='LC022',
                MESSAGE='The fund of a settlement is corrected before the next period starts';
        END IF;
        SELECT coalesce(sum(effect.amount_delta),0) INTO amended_amount
        FROM closing_correction_effects effect
        WHERE effect.closing_id = NEW.closing_id AND effect.kind = 'fund';
        delta_amount := closing_correction_amount(NEW.payload->'closing_cash', 'fund')
            - (header.closing_cash + amended_amount);
        IF delta_amount <> 0 THEN
            INSERT INTO closing_correction_effects(correction_id, closing_id, kind, amount_delta)
            VALUES (NEW.id, NEW.closing_id, 'fund', delta_amount);
        END IF;
    END IF;
    PERFORM set_config('luson.closing_correction', '', true);
    RETURN NULL;
END;
$$;
-- AFTER UPDATE, so the effects are written once the decision is the row's final state and
-- 034's decision guard has already validated actor and shape.
CREATE TRIGGER apply_closing_correction AFTER UPDATE ON closing_corrections
FOR EACH ROW EXECUTE FUNCTION apply_closing_correction();

-- The drawer chain: the fund of the previous closed settlement is the opening cash of the
-- next one (S10), so a corrected fund has to reach that opening. 034's admit_branch_closing
-- already wrote the inherited fund into NEW.opening_cash, and this trigger adds the deltas
-- the branch accepted for that same settlement.
--
-- It is named to fire after admit_branch_closing ('admit' sorts before 'apply'), which is
-- also what makes it safe: the opener has taken the per-branch advisory lock and has
-- already decided which settlement the fund comes from. There is nothing to read when the
-- branch has no closed settlement yet, so the first settlement of a branch is untouched.
CREATE FUNCTION apply_closing_correction_fund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    previous bigint;
    delta numeric(12,2);
BEGIN
    SELECT settlement.id INTO previous FROM branch_closings settlement
    WHERE settlement.branch_location_id = NEW.branch_location_id AND settlement.status = 'closed'
    ORDER BY settlement.closed_at DESC LIMIT 1;
    IF previous IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT coalesce(sum(effect.amount_delta),0) INTO delta
    FROM closing_correction_effects effect
    WHERE effect.closing_id = previous AND effect.kind = 'fund';
    NEW.opening_cash := NEW.opening_cash + delta;
    RETURN NEW;
END;
$$;
CREATE TRIGGER apply_closing_correction_fund BEFORE INSERT ON branch_closings
FOR EACH ROW EXECUTE FUNCTION apply_closing_correction_fund();
