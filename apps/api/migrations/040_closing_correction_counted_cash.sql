-- The drawer, corrected: the fourth value an accepted correction of a closed settlement can
-- touch, and the way the published numbers follow the journal instead of the signed row.
--
-- 036 applies a correction as a journal of deltas (closing_correction_effects) and refuses to
-- rewrite anything the branch signed. Its payload reads counted_quantities, commission_amount
-- and closing_cash, so a correction covers the count sheet, the commission and the fund. S16
-- lists one more value -- "se puede corregir todo (conteo, comisión, fondo, caja)" -- and this
-- migration is that fourth field: the cash the branch counted at the cut.
--
-- The payload gains one field and keeps the shape of 036, which is still the whole contract:
--
--   {
--     "counted_quantities": [{"variant_id": 1, "counted_quantity": 8}],
--     "counted_cash":       "120.00",
--     "commission_amount":  "516.27",
--     "closing_cash":       "60.00"
--   }
--
--   counted_cash -- the corrected cash the branch counted when its drawer was cut, as the
--     canonical two-decimal amount every money of this vertical is (S20). The delta is taken
--     against the settlement's counted cash as its accepted corrections have already amended
--     it, exactly like the stock delta of 036, so successive corrections converge on the number
--     the branch counted instead of applying the same difference twice. It is journaled as an
--     effect of kind 'counted_cash', the unit of money, and it is the one effect that changes a
--     number without moving anything.
--
-- Why a counted-cash correction writes no ledger row. The counted cash is what the drawer held
-- at the cut, and the money that left it is one movement of the branch's cash ledger, written
-- when the settlement closed and immutable since (035). Correcting the count does not put money
-- into the till or take it out: the drawer holds what it holds, so the accepted correction
-- records the difference and stops there. There is also no coherent ledger row to write: the
-- recaudación of a settlement is one movement, admitted only from the closure of a settlement
-- that still reads 'proposed' (LC011, LC020), and appending a second one to a closed settlement
-- is precisely the rewrite S16 forbids.
--
-- What a reader sees instead. The settlement keeps the values the branch signed, and the
-- difference it recorded, the drawer it published and the amount the warehouse took are derived
-- from the closed number plus the deltas of the journal -- the same mechanism 034 uses for the
-- expected cash and 036 for the fund. A stored copy of a corrected number could disagree with
-- the journal that produced it, so there is none. The journal is published with the settlement
-- (store `loadCorrections`), reason included, so a number that is the result of a correction is
-- legible as one and a client can always tell which delta produced it.
--
-- Why the fund bound of 036 is not re-read against the corrected count. 036 refuses a corrected
-- fund above the cash counted plus the contribution the warehouse made, and that bound stays
-- the drawer the branch signed. A counted-cash correction is published over the signed row, so
-- the bound a later fund correction is judged against is still the signed one: it can only
-- refuse a fund the closure itself would have refused, and it never admits money the branch did
-- not count. Correcting the drawer upwards and the fund in the same correction is admitted,
-- because the fund is compared with the drawer the closure stated -- the one the branch signed.
--
-- Nothing else moves. The stock delta of 036 still applies to inventory in both directions and
-- still refuses to leave the existence under the reservation (LC007); the commission is still
-- informational, paid outside the system, and participates in no cash identity (S9); the fund
-- delta still folds into the next opening exactly once, and is still refused with LC022 once
-- that period started; and no ledger row is written here at all. Nothing freezes or unfreezes a
-- branch either: this migration never writes branch_closings.
--
-- How the fourth field is applied. The application of 036 is left exactly as it is and the new
-- kind gets its own trigger function, named to fire after it on the same acceptance. A correction
-- is one acceptance, so the two functions apply the same decision to different facts, and the
-- three rules of 036 keep their single owner instead of being restated here. The one function
-- that had to be restated is the payload guard: the shape of a correction is validated when it is
-- proposed, so a fourth field cannot be admitted by anything but the guard itself.
--
-- Additive only: 001-039 are applied and checksummed and nothing of theirs is rewritten,
-- replaced or dropped, except the one CHECK of 036's own journal, widened to admit the fourth
-- unit of a delta. That table, its once-per-delta index, its optional variant and its provenance
-- trigger all keep their shape; the new kind carries money only, which the existing unit split
-- already states.
--
-- Codes: LC021 the payload is not a correction this domain reads, LC012 only a closed settlement
-- is corrected, LC013 a decided correction is final, LC014 only an enabled account of the branch
-- decides, LC022 the fund of a settlement is corrected before the next period starts, LC023 a
-- correction effect is written by the acceptance of its own correction. LC006 and LC007 keep the
-- meaning 036 gave them.

-- The journal's unit CHECK of 036 admitted the three deltas it applied. The drawer is the fourth
-- and it is money, so the check is widened and nothing else about the table moves: the unit
-- split below it (a stock effect carries a variant and a quantity, every other kind carries an
-- amount) is what makes the new kind read as money and never as a count.
ALTER TABLE closing_correction_effects
    DROP CONSTRAINT closing_correction_effects_kind_check;
ALTER TABLE closing_correction_effects
    ADD CONSTRAINT closing_correction_effects_kind_check
    CHECK (kind IN ('stock','commission','fund','counted_cash'));

-- The payload guard of 036, restated with the fourth field. It is the whole shape contract of a
-- correction and it is restated rather than extended because a BEFORE INSERT trigger is the only
-- place the shape of a correction is judged: the warehouse holds the correction while it is
-- proposed, and the branch decides a shape this domain has already admitted.
--
-- The facts it reads from the closed settlement are the ones 036 reads: the variant is on its
-- count sheet, the corrected fund does not exceed the drawer that was counted plus the
-- contribution (LC006), and nothing else is carried along. What a counted-cash correction states
-- is money and only money, so no arithmetic of the stock or of the drawer is its business: the
-- reservation a corrected quantity has to respect is the reservation at the moment the branch
-- accepts, and the difference the corrected count produces is what a reader derives.
CREATE OR REPLACE FUNCTION guard_closing_correction_payload() RETURNS trigger LANGUAGE plpgsql AS $$
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
        IF field NOT IN ('counted_quantities','counted_cash','commission_amount','closing_cash') THEN
            RAISE EXCEPTION USING ERRCODE='LC021',
                MESSAGE='A correction has no field ' || field;
        END IF;
    END LOOP;
    IF NOT (NEW.payload ? 'counted_quantities' OR NEW.payload ? 'counted_cash'
            OR NEW.payload ? 'commission_amount' OR NEW.payload ? 'closing_cash') THEN
        RAISE EXCEPTION USING ERRCODE='LC021',
            MESSAGE='A correction states counted_quantities, counted_cash, commission_amount or closing_cash';
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
    -- The counted cash is the drawer as the branch read it: one canonical amount and nothing
    -- else. It is not compared with the fund or with the expected cash here, because the
    -- difference of a settlement is free to be any number (S8) and the corrected difference is
    -- what a reader derives, not a value this guard could bound.
    IF NEW.payload ? 'counted_cash' THEN
        PERFORM closing_correction_amount(NEW.payload->'counted_cash', 'counted cash');
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

-- The counted-cash delta of an accepted correction. It runs on the same acceptance as
-- apply_closing_correction (036) and applies the one fact 036 has no field for; the three kinds
-- it owns are untouched and stay where they are.
--
-- An acceptance is decided once (034's decision guard) and a decided correction can never reach
-- an UPDATE again (LC013), so this function sees a proposed -> accepted transition at most once
-- per correction. The marker it sets is the provenance rule of 036's journal: the effect of a
-- correction is written while its acceptance is being applied, at the trigger depth only a
-- trigger reaches, and a hand-written effect is refused by admit_closing_correction_effect.
CREATE FUNCTION apply_closing_correction_counted_cash() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header branch_closings%ROWTYPE;
    amended_amount numeric(12,2);
    delta_amount numeric(12,2);
BEGIN
    IF OLD.status <> 'proposed' OR NEW.status <> 'accepted' THEN
        RETURN NULL;
    END IF;
    IF NOT (NEW.payload ? 'counted_cash') THEN
        RETURN NULL;
    END IF;
    -- apply_closing_correction already refused a correction of a settlement that is not closed
    -- and already took the per-branch advisory lock of the opener; this read only needs the
    -- drawer the settlement was signed with.
    SELECT * INTO header FROM branch_closings WHERE id = NEW.closing_id;
    IF NOT FOUND OR header.status <> 'closed' THEN
        RETURN NULL;
    END IF;
    PERFORM set_config('luson.closing_correction', NEW.id::text, true);
    -- The base is the signed count plus the deltas already accepted for this settlement, so a
    -- second correction states a difference against the drawer as it reads after the first one.
    SELECT coalesce(sum(effect.amount_delta),0) INTO amended_amount
    FROM closing_correction_effects effect
    WHERE effect.closing_id = NEW.closing_id AND effect.kind = 'counted_cash';
    delta_amount := closing_correction_amount(NEW.payload->'counted_cash', 'counted cash')
        - (coalesce(header.counted_cash,0) + amended_amount);
    -- A correction that states what the drawer already reads applies no delta: re-stating a
    -- corrected count cannot apply the same difference twice.
    IF delta_amount <> 0 THEN
        INSERT INTO closing_correction_effects(correction_id, closing_id, kind, amount_delta)
        VALUES (NEW.id, NEW.closing_id, 'counted_cash', delta_amount);
    END IF;
    PERFORM set_config('luson.closing_correction', '', true);
    RETURN NULL;
END;
$$;
-- Named to fire after apply_closing_correction, which is the function that decides the
-- acceptance: PostgreSQL runs the AFTER ROW triggers of one table in name order, and
-- 'apply_closing_correction' sorts before 'apply_closing_correction_counted_cash'.
CREATE TRIGGER apply_closing_correction_counted_cash AFTER UPDATE ON closing_corrections
FOR EACH ROW EXECUTE FUNCTION apply_closing_correction_counted_cash();
