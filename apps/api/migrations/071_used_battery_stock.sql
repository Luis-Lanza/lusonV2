-- The used battery has a real stock per location and per model, and it is derived from the facts
-- already registered (S24). This version states that read, corrects the one term of the settlement
-- seed that attributed a factory return to the wrong location (S27), and closes the hole the user
-- found when the counter lent a battery out of a branch that held none (S25, L29).
--
-- Why a read and not a table. The user asked for "el stock de baterias usadas de cada sucursal y de
-- almacen" (L30), and the answer is the flow already recorded: 032 registers what the branch bought,
-- 045/047/066 registered what its closed settlements delivered and what a loan took out or brought
-- back, and 065 registered what the factory returned to the pool. A balance row would be a fifth
-- number beside those four facts, and the moment a loan is inserted without it the fifth number is
-- wrong and the facts are right. So the stock is a sum, stated once, in one function: no table, no
-- column, no stored total and no second inventory (S18).
--
-- The two formulas of S24, term by term, and where each term comes from:
--
--   branch    = bought + factory returns + loans returned - delivered in closed settlements
--               - loans given
--   warehouse = delivered by branches in closed settlements + factory returns - loans given
--
-- Every term is a signed row of one UNION ALL and the sum is one GROUP BY per location and model, so
-- the arithmetic is stated once and no reader can mistake a term for a second rule. A line a
-- settlement counted as zero delivered nothing and states no row: a location has a position of a
-- model because a document moved units of it, and never because zero was written down. A term that a
-- location has no fact of is a zero row of the union: the branch of a battery is `purchases`
-- .`location_id`, a delivery is the closed settlement's branch subtracting and the warehouse adding
-- the same counted quantity, a loan is its `source_location_id` (S6), and a return is the same
-- location that lent it -- the branch the client walks into is the branch that gets the battery back.
-- A returned loan is therefore added back for whichever location lent it, which is the same rule 066
-- already applies to the branch and the only attribution that counts every unit exactly once.
--
-- Why a factory return is the warehouse's and never the branch of the case (S27). The warehouse ships
-- the battery to the factory and the warehouse receives it back: the branch that opened the case never
-- sees it again unless it is a repaired unit its client comes to collect. 066 appended those units to
-- the sheet of the branch of the case, and that was wrong on two counts -- the branch does not hold
-- them, and if it delivered its sheet whole the unit would be counted a second time at the warehouse.
-- The seed of the pool is therefore redefined below without that term, and this function states it as
-- the warehouse's. The settlement's expectation and this stock are the same number at the same cut: a
-- branch's expectation is bought + loans returned - loans given - delivered, which is exactly its
-- available quantity (S29).
--
-- The model is a text compared without case and without surrounding spaces (S26), exactly like the
-- purchases compare it (032, 033): every term is grouped by `upper(btrim(...))`, so "ns60zl" and
-- " NS60ZL " are one battery. The catalogue's model is the only key that does not already arrive
-- canonical -- it is the user's catalogue -- and a catalogue model the sheet cannot hold as a key is
-- not a key of the stock either.
--
-- The whole file writes no row: it replaces one function of the seed and installs two functions and
-- one trigger of its own, and no statement here inserts, updates or deletes anything. A settlement
-- that already stored its sheet keeps it byte for byte (that is the truth of its own opening) and
-- every settlement from this version on states the pool of its own cut. No money moves, no fund and
-- no cash row is written, and no sale document is added (S12, S28); no transfer is written either,
-- because a loan records where the battery came from and moves no stock between locations (S6).
CREATE OR REPLACE FUNCTION seed_closing_material_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('luson.closing_material_seed', NEW.id::text, true);
    -- The used pool of this branch, per model: the flows of 066 that are the branch's, as one signed
    -- sum, and only a pool that holds something is a line of the sheet. The factory return is not one
    -- of them any more (S27): it is the warehouse's, and it is stated by used_battery_stock() below.
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
        -- Minus the used batteries this branch lent before this cut: they left the pool in the
        -- hands of a client, and the loan states where it came from (S6, S17).
        SELECT loan.model AS model, -sum(loan.quantity) AS units
        FROM warranty_case_loans loan
        WHERE loan.source_location_id = NEW.branch_location_id
          AND loan.given_at < NEW.cut_at
        GROUP BY loan.model
        UNION ALL
        -- Plus the ones that came back to this branch before the same cut: a battery returned to
        -- the branch is in the pool again, so its own outflow is undone by the instant 065 stamped
        -- on the fate -- a loan kept by the client, failed or lost has no such instant to read.
        SELECT loan.model AS model, sum(loan.quantity) AS units
        FROM warranty_case_loans loan
        WHERE loan.source_location_id = NEW.branch_location_id
          AND loan.fate = 'returned'
          AND loan.fate_decided_at < NEW.cut_at
        GROUP BY loan.model
    ) flow
    GROUP BY flow.model
    HAVING sum(flow.units) > 0;
    -- The same rule for scrap, in kilograms per material, exactly as 047 and 066 state it: the
    -- weighed materials are not the pool of used batteries and this version does not touch them.
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

-- The stock of used batteries of the whole installation (S24): one row per location and model, the
-- five terms and their signed sum. It is one aggregate and never a query per model, because a screen
-- that lists a branch and a warehouse cannot pay a round trip per row.
--
-- It is VOLATILE on purpose. The loan trigger below reads it under a lock it took after the calling
-- statement began, and a STABLE function would answer with the snapshot of that statement -- the
-- loans of a transaction that committed while this one waited would be invisible and two loans would
-- consume one unit. As a volatile function every query it runs takes its own snapshot.
CREATE FUNCTION used_battery_stock()
RETURNS TABLE (
    location_id smallint,
    model text,
    purchased bigint,
    factory_returns bigint,
    loans_returned bigint,
    delivered bigint,
    loans_given bigint,
    available bigint
) LANGUAGE sql AS $$
    SELECT flow.loc AS location_id, flow.code AS model,
           sum(flow.bought)::bigint AS purchased,
           sum(flow.returned)::bigint AS factory_returns,
           sum(flow.back)::bigint AS loans_returned,
           (sum(flow.out) + sum(flow.into))::bigint AS delivered,
           sum(flow.lent)::bigint AS loans_given,
           (sum(flow.bought) + sum(flow.returned) + sum(flow.back) + sum(flow.into)
             - sum(flow.out) - sum(flow.lent))::bigint AS available
    FROM (
        -- What each location bought of a model, counter-documents included as they are stored: their
        -- quantity is negated, so a reversal subtracts by itself and no document is filtered out.
        SELECT purchase.location_id AS loc, upper(btrim(line.model)) AS code,
               line.quantity AS bought, 0::bigint AS returned, 0::bigint AS back,
               0::bigint AS out, 0::bigint AS into, 0::bigint AS lent
        FROM purchase_used_lines line
        JOIN purchases purchase ON purchase.id = line.purchase_id
        UNION ALL
        -- What the factory refused and sent back to the used pool: the warehouse's, because the
        -- warehouse shipped the battery and the warehouse receives it (S11, S27). A claim states no
        -- quantity and is the one battery it is about (065), exactly as 066 reads it.
        SELECT 1::smallint AS loc, upper(btrim(entry.model)) AS code,
               0::bigint AS bought, coalesce(case_row.quantity, 1)::bigint AS returned,
               0::bigint AS back, 0::bigint AS out, 0::bigint AS into, 0::bigint AS lent
        FROM warranty_cases case_row
        JOIN catalog_variants variant ON variant.id = case_row.variant_id
        JOIN catalog_entries entry ON entry.id = variant.catalog_entry_id
        WHERE case_row.verdict = 'not_covered'
          AND case_row.reported_destination = 'stock'
          AND upper(btrim(entry.model)) ~ '^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$'
        UNION ALL
        -- What each closed settlement counted of a used line: the branch delivered it, so it leaves
        -- the branch...
        SELECT closing.branch_location_id AS loc, upper(btrim(sheet.model)) AS code,
               0::bigint AS bought, 0::bigint AS returned, 0::bigint AS back,
               sheet.counted_quantity::bigint AS out, 0::bigint AS into, 0::bigint AS lent
        FROM closing_material_lines sheet
        JOIN branch_closings closing ON closing.id = sheet.closing_id
        WHERE closing.status = 'closed' AND sheet.kind = 'used'
          AND sheet.counted_quantity > 0
        UNION ALL
        -- ...and enters the warehouse, with the same counted quantity: one delivery moves the units
        -- between the two rows and never states two different numbers (S24).
        SELECT 1::smallint AS loc, upper(btrim(sheet.model)) AS code,
               0::bigint AS bought, 0::bigint AS returned, 0::bigint AS back,
               0::bigint AS out, sheet.counted_quantity::bigint AS into, 0::bigint AS lent
        FROM closing_material_lines sheet
        JOIN branch_closings closing ON closing.id = sheet.closing_id
        WHERE closing.status = 'closed' AND sheet.kind = 'used'
          AND sheet.counted_quantity > 0
        UNION ALL
        -- What each location lent, and what came back to it: the same battery crosses the sum twice,
        -- and only the fate 065 dates as `returned` is a battery in the location again (S17).
        SELECT loan.source_location_id AS loc, upper(btrim(loan.model)) AS code,
               0::bigint AS bought, 0::bigint AS returned, 0::bigint AS back,
               0::bigint AS out, 0::bigint AS into, loan.quantity AS lent
        FROM warranty_case_loans loan
        UNION ALL
        SELECT loan.source_location_id AS loc, upper(btrim(loan.model)) AS code,
               0::bigint AS bought, 0::bigint AS returned, loan.quantity AS back,
               0::bigint AS out, 0::bigint AS into, 0::bigint AS lent
        FROM warranty_case_loans loan
        WHERE loan.fate = 'returned'
    ) flow
    GROUP BY flow.loc, flow.code
$$;

-- A loan hands a used battery over, so the location it comes from has to hold it (S25). The user
-- found the hole in front of a branch with a zero balance (L29): the loan stated its origin and
-- nobody checked it, so a battery that did not exist was handed to a client and the pool went
-- negative in silence. The refusal is a fact of the row, not a screen's opinion, and it has its own
-- code, LW033, which this repository uses nowhere else.
--
-- The lock is what makes "two loans cannot consume one unit" true rather than probable. The stock is
-- the sum of the facts, so two concurrent loans of the same model from the same location would both
-- read the same positive quantity and both pass: the advisory lock serialises the writers of one
-- origin and model for the rest of their transactions, and the volatile read above then sees the one
-- that committed first. The lock is taken after the case row (065) and keyed by the origin and the
-- model, so two loans on different cases from one origin cannot cross either.
CREATE FUNCTION admit_warranty_case_loan_stock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    held bigint;
BEGIN
    PERFORM pg_advisory_xact_lock(340252,
        hashtext(NEW.source_location_id::text || ':' || upper(btrim(NEW.model))));
    SELECT stock.available INTO held
    FROM used_battery_stock() stock
    WHERE stock.location_id = NEW.source_location_id
      AND stock.model = upper(btrim(NEW.model));
    IF coalesce(held, 0) < NEW.quantity THEN
        RAISE EXCEPTION USING ERRCODE='LW033',
            MESSAGE='A loan of a used battery requires stock of its model in its origin',
            DETAIL=NEW.source_location_id::text;
    END IF;
    RETURN NEW;
END;
$$;
-- The alphabetical order of the two admission triggers of this table puts the numbering of 065 first
-- and this judgement second, so the row the caller wrote is judged as the row the database numbers.
CREATE TRIGGER admit_warranty_case_loan_stock BEFORE INSERT ON warranty_case_loans
FOR EACH ROW EXECUTE FUNCTION admit_warranty_case_loan_stock();
