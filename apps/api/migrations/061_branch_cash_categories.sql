-- 061 -- the closed list of motives of a branch expense (S2, S3, S5, S7, S8, S9)
--
-- Until now the motive of an expense was the free text of `description`, so a branch could write
-- down any reason at all for the money it took out of the till. The product asks for a closed
-- list: the screen offers the motives the database states and no path to type one, and the note
-- becomes the optional explanation beside the chosen motive.
--
-- This migration states that list once, seeds it, and reads it back through the book:
--
--   S2 the list starts with the eleven fixed motives, in this order, and "Otros gastos" is the
--      last of them: it is the only escape valve and it does not reopen free text.
--   S3 the motive of an expense is mandatory and the note beside it is optional: a pay-out is
--      refused when it names no motive, and its note may be empty exactly when it names one.
--   S5 the list is one table of the database, global to every branch: there is no branch column,
--      because the same motives are offered at every counter.
--   S7 nothing is rewritten: the rows already recorded keep their free text and no statement here
--      touches them, and the immutability guard of 034 is untouched.
--   S8 every expense keeps, beside the reference to its motive, a copy of the label that motive
--      had when the row was written, so renaming or archiving a motive never rewrites the past.
--   S9 the arithmetic of the drawer does not change: the signed effect of a row is still the
--      direction of its kind, and `branch_cash_effective`, `branch_drawer_expected` and
--      `assert_branch_drawer_holds` are not restated here.
--
-- The rule is enforced where this codebase enforces the invariants of the ledger, in the database,
-- and it is enforced by its own BEFORE INSERT trigger named to fire after the three the table
-- already carries, so the refusals that already exist answer first and keep their precedence:
--
--   LC001 (frozen branch) -> LC030 -> LC031 -> LC032 -> LC033
--
-- The three triggers of the table are `admit_branch_cash_movement` (035, restated by 046, 048, 054
-- and 060), `admit_branch_expense` (038) and `stamp_branch_expense_before_insert` (042); PostgreSQL
-- fires the BEFORE ROW triggers of a table in name order, so this file's
-- `verify_branch_expense_category_before_insert` answers last by construction and not by luck.

-- The catalogue of motives (S2, S5). It is global: no branch column, because every counter offers
-- the same list, and the vertical that administers it (S6, out of this delivery) is only CRUD over
-- these columns.
CREATE TABLE branch_cash_categories (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- The label the branch reads. It is stored exactly as it is offered, so it is trimmed and it
    -- always says something; the bound is the one a note of an expense has.
    label text NOT NULL UNIQUE CHECK (char_length(btrim(label)) BETWEEN 1 AND 500 AND label = btrim(label)),
    -- The place the motive takes in the closed list. It is stated, never derived from the id: the
    -- administrator's vertical may add, rename or reorder an option, and the order of the list is a
    -- fact of the list itself.
    sort_order smallint NOT NULL UNIQUE CHECK (sort_order >= 1),
    -- A motive that is archived stops being offered and stops being admissible, and it is never
    -- deleted: the rows already recorded point at it and keep their own copy of its label (S8).
    retired_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
-- The read of the screen is the active motives in the order of the list: this is that lookup.
CREATE INDEX branch_cash_categories_active ON branch_cash_categories(sort_order, label)
WHERE retired_at IS NULL;

COMMENT ON TABLE branch_cash_categories IS
    'The closed list of motives a branch expense is recorded with. Global to every branch: there is no branch column.';
COMMENT ON COLUMN branch_cash_categories.sort_order IS
    'The place the motive takes in the closed list the screen offers, stated by the seed and by the administration.';
COMMENT ON COLUMN branch_cash_categories.retired_at IS
    'The instant the motive stopped being offered. An archived motive is never deleted and never admissible again.';

-- The seed of this delivery (S2), exactly the eleven motives of the document in their order.
-- "Otros gastos" goes last: it is the escape valve, and the clarification of what it paid for goes
-- in the note, never in a reopened free-text motive.
INSERT INTO branch_cash_categories(label, sort_order) VALUES
    ('Alquiler', 1),
    ('Internet', 2),
    ('Energía eléctrica', 3),
    ('Agua', 4),
    ('Limpieza', 5),
    ('Sueldos', 6),
    ('Transporte', 7),
    ('Insumos de tienda', 8),
    ('Mantenimiento', 9),
    ('Impuestos', 10),
    ('Otros gastos', 11);

-- The motive of a row, and its copy of the label the motive had when the row was written (S8). Both
-- are null on a row that names no motive: the contribution and the collection of the drawer, the
-- correction of a movement and every row recorded before this migration (S7). The reference is
-- nullable on purpose: a historical row has none, and an aporte never has one.
ALTER TABLE branch_cash_movements
    ADD COLUMN category_id bigint REFERENCES branch_cash_categories(id),
    ADD COLUMN category_label text;

-- The shape of the pair, stated once: a reference and its copy of the label exist together or not
-- at all, so a reader of the book can never see a motive without the name it had.
ALTER TABLE branch_cash_movements
    ADD CONSTRAINT branch_cash_movements_category_shape
    CHECK ((category_id IS NULL) = (category_label IS NULL));

COMMENT ON COLUMN branch_cash_movements.category_id IS
    'The motive this expense was recorded with (S3). Null on every kind that is not a gasto and on every row recorded before 061.';
COMMENT ON COLUMN branch_cash_movements.category_label IS
    'The label the motive had when this row was written (S8). A copy, so renaming or archiving the motive never rewrites the past.';

-- The note of an expense is optional (S3), so the description constraint stops demanding one. What
-- replaces it is the same bound with one hole: at most 500 trimmed characters as before, and empty
-- only when the row names a motive -- an aporte, a recaudacion, a correction and the transfers of a
-- settlement still say what they are for. The constraint is dropped by the name the live schema
-- gives it (the inline CHECK of 034 on this column) and added again under the same name, so every
-- reader that already knows this constraint keeps reading it.
ALTER TABLE branch_cash_movements
    DROP CONSTRAINT IF EXISTS branch_cash_movements_description_check;
ALTER TABLE branch_cash_movements
    ADD CONSTRAINT branch_cash_movements_description_check
    CHECK (char_length(btrim(description)) <= 500
        AND (category_id IS NOT NULL OR char_length(btrim(description)) >= 1));

COMMENT ON COLUMN branch_cash_movements.description IS
    'What the movement was for. Mandatory on every kind that is not a gasto; on an expense it is the optional note of the chosen motive (061, S3).';

-- The one refusal of this migration (S3): an expense names a motive of the list, the motive exists
-- and is offered, and no other kind names one. It is a trigger of its own, named to fire after the
-- three the table already carries, so every refusal that already exists answers first and keeps its
-- code and its message (LC001, LC030, LC031, LC032) and this one, LC033, is the last word.
CREATE FUNCTION admit_branch_expense_category() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    motive branch_cash_categories%ROWTYPE;
BEGIN
    -- Only an expense states a motive (S3): a contribution, a collection and a correction never
    -- name one, and neither do the transfers a settlement writes.
    IF NEW.kind <> 'gasto' THEN
        IF NEW.category_id IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='LC033',
                MESSAGE='Only an expense states a motive of the drawer';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.category_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='LC033',
            MESSAGE='An expense states a motive of the drawer';
    END IF;
    -- The motive must be one the list offers: an unknown id and an archived one are the same answer
    -- for the branch, because neither is an option of the screen.
    SELECT * INTO motive FROM branch_cash_categories WHERE id = NEW.category_id;
    IF NOT FOUND OR motive.retired_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='LC033',
            MESSAGE='The motive of this expense is unknown or archived';
    END IF;
    -- The copy of the label is written here and nowhere else (S8): it is the label of the motive at
    -- the instant the row is recorded, and no caller can state a different one.
    NEW.category_label := motive.label;
    RETURN NEW;
END;
$$;
-- `verify_` sorts after `stamp_branch_expense_before_insert`, which is the last of the three
-- triggers the table already carries, so PostgreSQL runs this guard last and LC033 is never the
-- answer where an older rule already refused the row.
CREATE TRIGGER verify_branch_expense_category_before_insert BEFORE INSERT ON branch_cash_movements
FOR EACH ROW EXECUTE FUNCTION admit_branch_expense_category();

-- The book of the drawer, restated from 060 with the two facts of this migration appended: the
-- motive of the row and the label it had. Every column 060 published keeps its name, its order and
-- its type, and the signed `effective` is the same expression, statement by statement (S9): a
-- reader of the view cannot tell this migration happened except for the two new columns.
CREATE OR REPLACE VIEW branch_cash_ledger AS
SELECT movement.id,
       movement.branch_location_id,
       movement.closing_id,
       movement.kind,
       movement.amount,
       movement.description,
       movement.occurred_at,
       movement.created_by_account_id,
       movement.corrects_id,
       CASE WHEN movement.kind = 'correccion' THEN corrected.kind ELSE movement.kind END
           AS effect_kind,
       branch_cash_effective(movement.kind, corrected.kind, movement.amount) AS effective,
       movement.category_id,
       movement.category_label
  FROM branch_cash_movements movement
  LEFT JOIN branch_cash_movements corrected ON corrected.id = movement.corrects_id;
