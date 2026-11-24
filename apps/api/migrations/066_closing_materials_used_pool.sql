-- The used pool feeds the settlement (S17, S18). 045 seeded the used sheet from the purchases of
-- the window and 047 restated that as the pending backlog at the cut -- what the branch bought
-- before the cut minus what its closed settlements already delivered -- because a used battery is
-- not stock anywhere in this repository and the pool only exists as a flow. That second version was
-- still a lie the moment a used battery was lent: the counter hands one to the client of a warranty
-- case (065) and the pool shrinks with nothing writing a purchase, and the factory refuses a claim
-- and sends the damaged battery back (S11), so the pool grows with nothing writing a purchase
-- either. This version teaches the seed those two facts, and only them.
--
-- The four flows of one model, which is the whole rule of this file:
--
--   what the branch bought of it before the cut (047, kept)
-- + the units the factory returned as not covered and destined to the used pool (065)
-- - the units this branch lent of it before the cut (065)
-- - the units its closed settlements already delivered of it (047, kept)
--
-- and only a positive sum is a line of the sheet, exactly as 045 and 047 seed: a model the branch
-- bought and lent whole, or bought and delivered whole, is not a position the pool holds and gets no
-- row, and nothing negative is ever stated because an expectation is a quantity that exists. The
-- four terms are one signed UNION ALL per model and one GROUP BY, so the arithmetic of the pool is
-- stated once, in the same expression, and a reader cannot mistake one of them for a second rule.
--
-- Which columns of 065 are the two facts, and why. A factory return is a `warranty_cases` row whose
-- `verdict` is `not_covered` and whose `reported_destination` is `stock`: the reported battery is
-- the one the factory refused, and `stock` is where the vertical sends a unit that re-enters the
-- used pool (S11, S23 froze both vocabularies). A unit destined to `customer` went back to its
-- client, one destined to `scrap` left the pool to be weighed, one `retained_by_factory` never came
-- back, and a verdict that is not `not_covered` is a battery the factory repaired or replaced --
-- none of those is an inflow, so the term states both conditions and nothing else. The units are
-- `quantity` on a `stock_defect` -- the shelf's batteries, a positive whole number by constraint --
-- and one battery on a `warranty_claim`, which states no quantity at all (065 S1): the coalesce to
-- 1 is the case's own shape, not an assumption. The key is the model code of the catalogue the
-- variant belongs to, canonicalised exactly as a purchase's is (upper and trimmed, the frozen
-- pattern of 032/033): a purchase line and a battery case name the same battery the same way, and a
-- catalogue model the sheet cannot hold as a key is not a key of the sheet -- the alternative is a
-- settlement that cannot open because a catalogue row it never mentions has a character the sheet
-- refuses.
--
-- A loan is a `warranty_case_loans` row of 065 and its date is `given_at`, the instant the counter
-- handed the battery over. It reduces the sheet of the location it came from, which is
-- `source_location_id`: a loan taken from the warehouse or from another branch is that location's
-- outflow and never this branch's (S6), and the sheet of a settlement is the pool of its own branch.
-- The loan's fate is not part of this arithmetic on purpose: 065 records the fate but not when it
-- was decided, so a returned loan cannot be put back in the window it belongs to, and inventing a
-- date would be inventing a column. S17 names the loans given, and that is the fact this file reads.
--
-- What this file cannot state. S17's formula also subtracts the used batteries liquidated to scrap
-- -- "menos liquidaciones a chatarra" -- and this repository records no such document: there is no
-- table of a scrap sale or of a liquidation (materials only appear as an inflow,
-- `purchase_scrap_lines` of 032, and as a weighed line of this same sheet), and no cash category of
-- the drawer sells anything (046, 048). A loan or a factory return is subtracted or added here
-- because 065 records it with its date; a liquidation has no row to read, and this migration refuses
-- to invent a column, a table or a motive to make one up. The term is therefore absent, not zero by
-- assumption: when a document of the liquidation exists, it joins the same signed sum with its own
-- sign and its own date.
--
-- What this version keeps, unchanged. The provenance of the expected quantity is untouched (LC020):
-- the transaction-local marker 'luson.closing_material_seed' still names this settlement
-- immediately before every insert of the seed and is cleared after them, and
-- admit_closing_material_line still requires it together with the trigger depth only the opener's
-- trigger can reach, so no caller can promise an expectation. The scrap half of the seed is copied
-- term for term from 047 -- bought before the cut minus delivered by closed settlements, in
-- kilograms per material, counter-documents included as they are stored -- because S17 changes the
-- pool of used batteries and says nothing about the weighed materials: this file adds two terms to
-- one of the two inserts and no statement of the other. The trigger of 045 still calls this function
-- by name, so nothing here creates a trigger; the guards of the sheet, its two partial keys, its
-- nullable counted quantity that blocks nothing (S8) and the freeze of the live settlement (LC025)
-- are the schema's own and are not touched. No money moves and no cash row is written (S12): the
-- whole file is the seed of a sheet whose columns are quantities, and the balances of
-- `inventory_balances` stay the only stock of this installation (S18) -- the pool is derived, never
-- stored.
--
-- Why CREATE OR REPLACE, and why no row of the past moves. 045 and 047 are applied and their
-- checksums recorded, so no statement of either is edited and no table, column or index is installed
-- a second time: this version replaces the one function that reads the flows of the pool. The file
-- writes no row of its own -- the inserts below are the seed's, run when a settlement opens -- so a
-- settlement that already stored its sheet keeps it byte for byte, which is the truth of its own
-- opening, and no backfill rewrites a signed settlement. Every settlement from this version on
-- states the pool of its own cut.
CREATE OR REPLACE FUNCTION seed_closing_material_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('luson.closing_material_seed', NEW.id::text, true);
    -- The used pool of this branch, per model: the four flows as one signed sum, and only a pool
    -- that holds something is a line of the sheet.
    INSERT INTO closing_material_lines(closing_id,kind,model,expected_quantity)
    SELECT NEW.id, 'used', flow.model, sum(flow.units)
    FROM (
        -- What the branch bought before this cut, counter-documents included as they are stored:
        -- their quantity is negated, so a reversal subtracts by itself (045, 047).
        SELECT line.model AS model, sum(line.quantity) AS units
        FROM purchase_used_lines line
        JOIN purchases purchase ON purchase.id = line.purchase_id
        WHERE purchase.location_id = NEW.branch_location_id
          AND purchase.created_at < NEW.cut_at
        GROUP BY line.model
        UNION ALL
        -- Minus what its closed settlements already delivered of that model: what a closed
        -- settlement counted is in the warehouse, and a line nobody counted delivered nothing.
        SELECT sheet.model AS model, -sum(sheet.counted_quantity) AS units
        FROM closing_material_lines sheet
        JOIN branch_closings closing ON closing.id = sheet.closing_id
        WHERE closing.branch_location_id = NEW.branch_location_id
          AND closing.status = 'closed'
          AND sheet.kind = 'used'
          AND sheet.counted_quantity IS NOT NULL
        GROUP BY sheet.model
        UNION ALL
        -- Plus the batteries the factory returned as not covered and destined to the used pool of
        -- this branch (S11): the model code is the catalogue's, canonicalised like a purchase's,
        -- and a claim, which states no quantity, is the one battery it is about.
        SELECT upper(btrim(entry.model)) AS model,
               sum(coalesce(case_row.quantity, 1)) AS units
        FROM warranty_cases case_row
        JOIN catalog_variants variant ON variant.id = case_row.variant_id
        JOIN catalog_entries entry ON entry.id = variant.catalog_entry_id
        WHERE case_row.branch_location_id = NEW.branch_location_id
          AND case_row.verdict = 'not_covered'
          AND case_row.reported_destination = 'stock'
          AND upper(btrim(entry.model)) ~ '^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$'
        GROUP BY upper(btrim(entry.model))
        UNION ALL
        -- Minus the used batteries this branch lent before this cut: they left the pool in the
        -- hands of a client, and the loan states where it came from (S6, S17).
        SELECT loan.model AS model, -sum(loan.quantity) AS units
        FROM warranty_case_loans loan
        WHERE loan.source_location_id = NEW.branch_location_id
          AND loan.given_at < NEW.cut_at
        GROUP BY loan.model
    ) flow
    GROUP BY flow.model
    HAVING sum(flow.units) > 0;
    -- The same rule for scrap, in kilograms per material, exactly as 047 states it: the weighed
    -- materials are not the pool of used batteries and this version does not touch them.
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
