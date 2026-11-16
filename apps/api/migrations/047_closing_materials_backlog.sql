-- The pending backlog of the material sheet (S7, S8, S11), which is 045's sheet read the way the
-- purchases screen already publishes it.
--
-- What 045 installed, and the one case its window was wrong for. 045 seeded the sheet from the
-- purchases of [period_start, cut_at): every closed settlement takes everything to the warehouse,
-- so the shelf starts at zero after it and what must be on it at this cut is what the period
-- bought. That is right for every settlement but the first. The first period of a branch starts at
-- the earliest activity the database records for it -- its first sale or its first movement of the
-- till, and only a branch with neither opens at its cut instant (039) -- and a purchase is not part
-- of that least, so a branch that bought used batteries or scrap before it ever sold got a first
-- period that starts after those purchases. No later sheet covers them either, because the branch
-- is frozen while a settlement is live and its next period starts at that closure. The backlog
-- stayed "pendiente" in the purchases screen forever, silently: the screen derives the balance of a
-- branch from every document it ever wrote and every quantity its CLOSED settlements delivered,
-- while the sheet of the settlement looked at a window its own document happens not to cover.
--
-- The rule this file states once: the sheet is the pending backlog at the cut, not the window. For
-- each key, the material the branch bought before NEW.cut_at minus the quantity its CLOSED
-- settlements already delivered, which is exactly the balance the purchases screen publishes as
-- "el saldo es lo que la sucursal todavía no entregó al almacén". The subtraction is the delivered
-- quantity of 045 read back, and it is a derivation and never a column: what a closed settlement
-- delivered of a key is the sum of the counted quantities of its lines (S9), so a line nobody
-- counted delivered nothing and stays pending. Only a pending amount above zero is seeded, exactly
-- as 045 seeds only a positive sum: a key the branch bought and returned whole, or bought and
-- already delivered whole, is not a position the shelf can hold and gets no line; a key its closed
-- settlements delivered more of than it ever bought (the warehouse counted more than the branch
-- had) has no pending amount either, and nothing negative is stated because the expected quantity
-- is a quantity the shelf holds.
--
-- What this version keeps, unchanged. The counter-document handling of 045 is kept exactly as it
-- is: a reversal is stored with its negated quantity and weight, so it subtracts from the bought
-- side by construction, no document is ever filtered out by its sign or by being a reversal, and a
-- reversal returns what its original bought (S11). The provenance of the expected quantity is kept
-- (LC020): the transaction-local marker 'luson.closing_material_seed' still names this settlement
-- immediately before every insert, and admit_closing_material_line still requires it together with
-- the trigger depth only the opener's trigger can reach. The trigger of 045 still calls this
-- function by name, so nothing here creates a trigger; the guards of the sheet, its two partial
-- keys, its nullable counted quantity that blocks nothing (S8) and the freeze of the live
-- settlement (LC001, 035) are the schema's own and are not touched. A purchase attempted while a
-- settlement is live keeps being refused, and that refusal is what makes the backlog of a cut grow
-- only between closures.
--
-- Why CREATE OR REPLACE and nothing else. 045 is applied and its checksum is recorded, so no
-- statement of it is edited and no table, no column and no index of it is installed a second time:
-- this version replaces the one function that read the window. This file writes no row of its own
-- -- the inserts below are the seed's, run when a settlement opens -- so a settlement that is
-- already open keeps the sheet it was seeded with, which is the truth of its own opening, and every
-- settlement from this version on states the backlog pending at its own cut.
CREATE OR REPLACE FUNCTION seed_closing_material_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('luson.closing_material_seed', NEW.id::text, true);
    -- What the branch bought before this cut, per model, minus what its closed settlements already
    -- delivered of that model: only a model with something pending is a line of this sheet.
    INSERT INTO closing_material_lines(closing_id,kind,model,expected_quantity)
    SELECT NEW.id, 'used', pending.model, pending.quantity
    FROM (
        SELECT coalesce(bought.model, delivered.model) AS model,
               coalesce(bought.units, 0) - coalesce(delivered.units, 0) AS quantity
        FROM (
            SELECT line.model AS model, sum(line.quantity) AS units
            FROM purchase_used_lines line
            JOIN purchases purchase ON purchase.id = line.purchase_id
            WHERE purchase.location_id = NEW.branch_location_id
              AND purchase.created_at < NEW.cut_at
            GROUP BY line.model
        ) bought
        FULL OUTER JOIN (
            SELECT sheet.model AS model, sum(sheet.counted_quantity) AS units
            FROM closing_material_lines sheet
            JOIN branch_closings closing ON closing.id = sheet.closing_id
            WHERE closing.branch_location_id = NEW.branch_location_id
              AND closing.status = 'closed'
              AND sheet.kind = 'used'
              AND sheet.counted_quantity IS NOT NULL
            GROUP BY sheet.model
        ) delivered ON delivered.model = bought.model
    ) pending
    WHERE pending.quantity > 0;
    -- The same rule for scrap, in kilograms per material.
    INSERT INTO closing_material_lines(closing_id,kind,material_id,expected_quantity)
    SELECT NEW.id, 'scrap', pending.material_id, pending.quantity
    FROM (
        SELECT coalesce(bought.material_id, delivered.material_id) AS material_id,
               coalesce(bought.kg, 0) - coalesce(delivered.kg, 0) AS quantity
        FROM (
            SELECT line.material_id AS material_id, sum(line.kg) AS kg
            FROM purchase_scrap_lines line
            JOIN purchases purchase ON purchase.id = line.purchase_id
            WHERE purchase.location_id = NEW.branch_location_id
              AND purchase.created_at < NEW.cut_at
            GROUP BY line.material_id
        ) bought
        FULL OUTER JOIN (
            SELECT sheet.material_id AS material_id, sum(sheet.counted_quantity) AS kg
            FROM closing_material_lines sheet
            JOIN branch_closings closing ON closing.id = sheet.closing_id
            WHERE closing.branch_location_id = NEW.branch_location_id
              AND closing.status = 'closed'
              AND sheet.kind = 'scrap'
              AND sheet.counted_quantity IS NOT NULL
            GROUP BY sheet.material_id
        ) delivered ON delivered.material_id = bought.material_id
    ) pending
    WHERE pending.quantity > 0;
    PERFORM set_config('luson.closing_material_seed', '', true);
    RETURN NULL;
END;
$$;
