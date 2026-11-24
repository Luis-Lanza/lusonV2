-- 072_used_loan_requires_known_model.sql
--
-- The loan of a used battery states a model code and nothing else about the battery, so the only way
-- its code can be right is by being one the installation already knows (S30). Until now the origin had
-- to hold stock of that model (071), which implied it was known, but that judgement answers a
-- different question and its refusal names the shelf, so a typo read as an empty shelf instead of as a
-- model nobody ever bought.
--
-- The known models are learned from the flows that bring a battery into the pool, and never from the
-- loans that take one out: a loan is the case's own act, and a model that could enter the system by
-- being lent would turn every typo into a canonical model the first time it was read back. A model the
-- pool never saw is refused, and no row is written.
CREATE FUNCTION used_battery_models() RETURNS TABLE (model text) LANGUAGE sql STABLE AS $$
    SELECT DISTINCT flow.code
    FROM (
        -- Every model the counter ever bought as a used battery, counter-documents included: a
        -- reversal is a quantity that negates itself and not a model that stops being known.
        SELECT upper(btrim(line.model)) AS code
        FROM purchase_used_lines line
        UNION
        -- Every model a branch counted in a closed settlement: what the warehouse received is a
        -- battery somebody put on the counter, and a sheet that is still open has delivered nothing.
        SELECT upper(btrim(sheet.model))
        FROM closing_material_lines sheet
        JOIN branch_closings closing ON closing.id = sheet.closing_id
        WHERE closing.status = 'closed' AND sheet.kind = 'used' AND sheet.counted_quantity > 0
        UNION
        -- Every model the factory refused and sent back to the pool: the catalogue's model of the
        -- battery the claim is about, read exactly as 066 and 071 read it.
        SELECT upper(btrim(entry.model))
        FROM warranty_cases case_row
        JOIN catalog_variants variant ON variant.id = case_row.variant_id
        JOIN catalog_entries entry ON entry.id = variant.catalog_entry_id
        WHERE case_row.verdict = 'not_covered'
          AND case_row.reported_destination = 'stock'
    ) flow
    WHERE flow.code <> ''
$$;

-- Judged before the stock of the origin (071), because the alphabetical order of the trigger names
-- puts this judgement first: an unknown model is refused for being unknown even when the shelf it
-- names is empty too, and the refusal the counter reads is the one about the model.
CREATE FUNCTION admit_warranty_case_loan_model() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM used_battery_models() known
        WHERE known.model = upper(btrim(NEW.model))
    ) THEN
        RAISE EXCEPTION USING ERRCODE='LW034',
            MESSAGE='A loan of a used battery requires a model the used pool already knows',
            DETAIL=upper(btrim(NEW.model));
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER admit_warranty_case_loan_model BEFORE INSERT ON warranty_case_loans
FOR EACH ROW EXECUTE FUNCTION admit_warranty_case_loan_model();
