-- Materials rendered (T3): what the period bought against what the warehouse counted at the
-- cut, used batteries in whole units per model and scrap in kilograms per material, each with
-- its difference and with the quantity that goes to the warehouse (S7, S8, S9, S11). The
-- settlement already publishes the purchase fund beside the drawer (044); this version adds the
-- register of what that money bought, which is the third account of the same document and a
-- sheet of its own, exactly like the count sheet of the branch stock (034, 043).
--
-- Why the expected is a fact of the opening and not something the warehouse types. The previous
-- closure took everything to the warehouse, so the shelf starts at zero by construction and what
-- must be on it at this cut is exactly what the period bought (S7): the sum of the used lines per
-- model and of the scrap lines per material of the branch purchases inside
-- [period_start, cut_at), with the counter-documents included as they are stored -- their negated
-- quantity and kg subtract by themselves, so a reversal inside the period subtracts from the
-- units and the kilos bought (S11) and no document is ever filtered out. That sum is read by the
-- opener from the purchases of its own window and written once; from then on it is the snapshot
-- the warehouse counts against, never a number the client states and never a live read.
--
-- Why only a non-zero sum is seeded. A model the period bought and returned whole nets zero, and
-- a material the period only returned nets a negative weight: neither is anything the shelf can
-- hold, so neither gets a line and the sheet states only what is expected to be there. The
-- warehouse that finds something of a key the period did not buy still counts it: the admission
-- below writes that line with an expected quantity of zero, because the fact of the opening for
-- that key is that the period bought none of it, and the difference it reports is the whole
-- quantity found.
--
-- Why the counted quantity is nullable and blocks nothing. Used batteries and scrap are not
-- inventory: the closure of the stock sheet never applies them, so a pending line of this sheet
-- is not the gate the count sheet is (034, LC019). The warehouse counts what it can, an uncounted
-- line is published as null, and its difference -- counted minus expected, signed -- is informed
-- exactly like the cash difference and the difference of the purchase envelope, and blocks
-- nothing (S8). "Everything counted goes to the warehouse at the closure" (S9) is therefore a
-- derivation and not a column: the delivered quantity is the counted one, nothing is left behind
-- and there is no remnant field to state.
--
-- Why this file replaces nothing. 001-044 are applied and their checksums recorded, so no
-- statement of them is edited and no function of theirs is redefined: this version has no reason
-- to, because everything it needs is a table, a trigger of its own on branch_closings and the
-- guards of that table.
--
-- Why one table with a kind instead of two. A used line and a scrap line are the same fact of one
-- settlement -- a key, an expected quantity, a counted quantity -- and differ only in the unit
-- they are measured in, so the unit is the kind: `used` counts models in units and `scrap` counts
-- materials in kilograms. The quantities share numeric(12,3), the scale of the weight 032 already
-- stores, and the whole-unit rule of a used line is a constraint of the row: a fractional unit is
-- not a battery. No column of this table is money, so the purchase fund and the drawer cannot
-- read it by mistake.
--
-- Why the guards are shaped like the count sheet's. The sheet belongs to the warehouse while it
-- holds the settlement: it is writable while the settlement is open and again after a rejection,
-- frozen while the branch decides and forever once closed, only the counted quantity ever moves,
-- and a line is never removed -- TRUNCATE bypasses row triggers, so it has its own guard. The
-- expected quantity of a line the caller adds is the database's zero and never the caller's
-- promise: the seeding of this very settlement sets the transaction-local marker
-- 'luson.closing_material_seed' to its own id immediately before it inserts and requires the
-- trigger depth the marker can only be set from, exactly as the closure's ledger rows prove their
-- provenance in 035 (LC020). A client statement runs at depth 1, so a manual expected quantity is
-- refused even if the client sets the marker itself.
--
-- Trigger order: PostgreSQL fires the AFTER row triggers of a table in name order, so
-- seed_closing_count_lines (043) runs before seed_closing_material_lines, and the stock sheet is
-- seeded before this one. Nothing here replaces a function of an applied migration, because
-- nothing here has to: the opener of 034/039 is not rewritten, and this is a second AFTER INSERT
-- trigger of its own on branch_closings.
--
-- Writing nothing to the past: this file adds a table, two indexes, three functions and four
-- triggers, and it inserts no row, updates no row and deletes no row of any table. A settlement
-- that is already open keeps the material sheet it has -- an empty one, since nothing seeded it
-- before this version -- and the warehouse counts it line by line; a settlement that is already
-- closed keeps publishing an empty sheet, which is the truth of its history.
CREATE TABLE closing_material_lines (
    closing_id bigint NOT NULL REFERENCES branch_closings(id),
    -- The unit of the row: used batteries in whole units per model, scrap in kilograms per
    -- material. The kind decides the key, the unit and the scale of both quantities.
    kind text NOT NULL CHECK (kind IN ('used','scrap')),
    -- The key of a used line: the model code 032 stores on a purchase, with the same frozen
    -- pattern (033 widened it for the comma of the catalogue).
    model text CHECK (model ~ '^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$'),
    -- The key of a scrap line: one of the four materials the branch buys by the kilogram.
    material_id smallint REFERENCES materials(id),
    -- What the period bought of this key: seeded by the opener from the purchases of its own
    -- window, and frozen from then on.
    expected_quantity numeric(12,3) NOT NULL CHECK (expected_quantity >= 0),
    -- What the warehouse counted at the cut: null while it has not counted the line, and a line
    -- left pending blocks nothing (S8).
    counted_quantity numeric(12,3) CHECK (counted_quantity >= 0),
    -- Exactly one key, and the key the kind names: a used line names a model and no material, a
    -- scrap line names a material and no model.
    CHECK ((kind = 'used' AND model IS NOT NULL AND material_id IS NULL)
        OR (kind = 'scrap' AND model IS NULL AND material_id IS NOT NULL)),
    -- A battery is a whole thing: neither what the period bought nor what was counted of a used
    -- line is a fraction. Scrap is weighed, so a scrap line keeps the three decimals of the
    -- column.
    CHECK (kind <> 'used' OR expected_quantity = trunc(expected_quantity)),
    CHECK (kind <> 'used' OR counted_quantity IS NULL
        OR counted_quantity = trunc(counted_quantity))
);

-- One row per key and settlement, one index per kind: the primary key cannot hold both, because
-- each kind names its key in a different column and the other one is null.
CREATE UNIQUE INDEX closing_material_lines_used ON closing_material_lines(closing_id, model)
WHERE kind = 'used';
CREATE UNIQUE INDEX closing_material_lines_scrap
ON closing_material_lines(closing_id, material_id) WHERE kind = 'scrap';
-- The sheet of one settlement is read whole, once per document and once per row of a history.
CREATE INDEX closing_material_lines_by_closing ON closing_material_lines(closing_id);

-- The seed: what the period bought, from the purchases of this very window (S7, S11).
--
-- The window is [period_start, cut_at) of the settlement, which the opener of 034/039 has
-- already written on NEW when this AFTER trigger runs, and the branch is its own: a purchase of
-- another branch is never part of this sheet. Every line is summed per key and the
-- counter-documents are included as they are stored -- their quantity and kg are negated, so they
-- subtract by construction and a reversal inside the period returns what its original bought.
-- Only a positive sum is seeded: a key that nets zero or less is not something the shelf can
-- hold, and the warehouse that finds some of it anyway counts it with an expected of zero.
--
-- The marker this function sets is the provenance of the expected quantity: it is transaction
-- local, it names this settlement, and admit_closing_material_line requires it together with the
-- trigger depth that only a trigger of the opener can reach.
CREATE FUNCTION seed_closing_material_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('luson.closing_material_seed', NEW.id::text, true);
    -- Used batteries, in whole units per model.
    INSERT INTO closing_material_lines(closing_id,kind,model,expected_quantity)
    SELECT NEW.id, 'used', used.model, sum(used.quantity)
    FROM purchases purchase
    JOIN purchase_used_lines used ON used.purchase_id = purchase.id
    WHERE purchase.location_id = NEW.branch_location_id
      AND purchase.created_at >= NEW.period_start AND purchase.created_at < NEW.cut_at
    GROUP BY used.model
    HAVING sum(used.quantity) > 0;
    -- Scrap, in kilograms per material.
    INSERT INTO closing_material_lines(closing_id,kind,material_id,expected_quantity)
    SELECT NEW.id, 'scrap', scrap.material_id, sum(scrap.kg)
    FROM purchases purchase
    JOIN purchase_scrap_lines scrap ON scrap.purchase_id = purchase.id
    WHERE purchase.location_id = NEW.branch_location_id
      AND purchase.created_at >= NEW.period_start AND purchase.created_at < NEW.cut_at
    GROUP BY scrap.material_id
    HAVING sum(scrap.kg) > 0;
    PERFORM set_config('luson.closing_material_seed', '', true);
    RETURN NULL;
END;
$$;
CREATE TRIGGER seed_closing_material_lines AFTER INSERT ON branch_closings
FOR EACH ROW EXECUTE FUNCTION seed_closing_material_lines();

-- A material line belongs to the warehouse while the settlement is not being decided: writable
-- while it is open and again after a rejection, frozen while the branch decides and forever once
-- closed, exactly like the count sheet of the stock (LC004).
--
-- The expected quantity is the database's: the seeding of this settlement writes it from inside
-- the trigger of the opener, and nothing else does. A line the warehouse adds for a key the
-- period did not buy states an expected of zero, which is the fact of the opening for that key,
-- and the counted quantity it states is its count.
CREATE FUNCTION admit_closing_material_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE header branch_closings%ROWTYPE;
BEGIN
    SELECT * INTO header FROM branch_closings WHERE id=NEW.closing_id;
    IF NOT FOUND OR header.status NOT IN ('open','rejected') THEN
        RAISE EXCEPTION USING ERRCODE='LC025',
            MESSAGE='Material lines are written while the warehouse holds the settlement';
    END IF;
    -- Provenance, checked after the shape of the settlement: the expected quantity exists only
    -- because the seeding of this very settlement is writing it, right now, from inside its own
    -- trigger. A client statement runs at depth 1, so no caller can promise one.
    IF current_setting('luson.closing_material_seed', true) IS DISTINCT FROM NEW.closing_id::text
       OR pg_trigger_depth() < 2 THEN
        NEW.expected_quantity := 0;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_closing_material_line BEFORE INSERT ON closing_material_lines
FOR EACH ROW EXECUTE FUNCTION admit_closing_material_line();

-- While the warehouse holds the settlement, the only thing that can change on a material line is
-- what was counted: the expected quantity is the snapshot of the opening, the key of the line is
-- its identity, and a closed settlement's sheet never moves.
CREATE FUNCTION guard_closing_material_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE header branch_closings%ROWTYPE;
BEGIN
    SELECT * INTO header FROM branch_closings WHERE id=OLD.closing_id;
    IF NOT FOUND OR header.status NOT IN ('open','rejected') THEN
        RAISE EXCEPTION USING ERRCODE='LC025',
            MESSAGE='Material lines are written while the warehouse holds the settlement';
    END IF;
    IF NEW.closing_id <> OLD.closing_id OR NEW.kind <> OLD.kind
       OR NEW.model IS DISTINCT FROM OLD.model
       OR NEW.material_id IS DISTINCT FROM OLD.material_id
       OR NEW.expected_quantity <> OLD.expected_quantity THEN
        RAISE EXCEPTION USING ERRCODE='LC025',
            MESSAGE='Only the counted quantity can change on a material line';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER guard_closing_material_line BEFORE UPDATE ON closing_material_lines
FOR EACH ROW EXECUTE FUNCTION guard_closing_material_line();

-- A material line is never removed: it is what the period bought, and dropping it would hide a
-- difference the warehouse has to inform (S8). TRUNCATE bypasses row triggers and would erase the
-- sheets of every closed settlement at once, so it has its own guard.
CREATE FUNCTION guard_closing_material_line_removal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE='LC025',
        MESSAGE='A material line is counted, never removed';
END;
$$;
CREATE TRIGGER protect_closing_material_lines BEFORE DELETE ON closing_material_lines
FOR EACH ROW EXECUTE FUNCTION guard_closing_material_line_removal();
CREATE TRIGGER protect_closing_material_lines_truncate BEFORE TRUNCATE ON closing_material_lines
EXECUTE FUNCTION guard_closing_material_line_removal();
