-- A branch expense belongs to a branch, and the warehouse has no till to pay it from.
--
-- 035 admits a 'gasto' by comparing the account that records it with the branch the row names
-- (admit_branch_cash_movement, LC011): the branch records its own expense and nobody records
-- another branch's. That comparison is necessary and it is not sufficient, because a hand
-- written row that names the warehouse and is signed by a warehouse account agrees with itself
-- -- and then the ledger states money out of a till that does not exist. The store refuses the
-- warehouse before it inserts (Store.RecordExpense), so no caller reaches this today; the
-- database, which is where the invariants of the ledger are enforced, accepted the row. This is
-- the hole L26 recorded and S12 asks to close.
--
-- The missing half of the same fact is stated here in the schema's own terms, the way the rest
-- of the schema states it: a movement of kind 'gasto' names a branch, and the warehouse is
-- location 1. That is the same identity 034 uses to refuse to settle the warehouse (LC002) and
-- to configure a commission for it (LC015), and the one 025 and 032 use to refuse a sale from
-- it and a purchase at it (LV001, LP001).
--
-- 035 is already applied and its checksum recorded, so it is not edited: this version adds one
-- more row-level trigger on branch_cash_movements, named to fire after that admission, exactly
-- like 017 added admit_active_participants beside the creation guards instead of rewriting them.
-- The ordering is what keeps every refusal that 035 already produces exactly as it was: the
-- branch's own expense, another branch's row and a frozen branch keep their codes and their
-- messages, and only the row no existing rule answered is refused here.
--
-- The settlement's own transfers -- 'aporte' and 'recaudacion' -- deliberately get no such
-- refusal, and the reason is that they are not an expense of a branch at all: they are the money
-- of a settlement, written by the closure of that settlement and by nothing else. 035 requires a
-- settlement of the same branch in state 'proposed' (LC011) and the transaction-local provenance
-- only the closure sets (LC020), so a transfer has to name a settlement that exists. No
-- settlement of the warehouse can exist, because 034 refuses to open one for location 1 (LC002),
-- so a transfer naming the warehouse has nothing to belong to and is refused by those two rules
-- before it could state money of a till that is not there -- with an answer that names the real
-- fact (it belongs to no settlement of its own branch) instead of a second code for one thing.
-- A branch's till never holds a transfer of its own either: the same guard refuses it.
CREATE FUNCTION admit_branch_expense() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind = 'gasto' AND NEW.branch_location_id = 1 THEN
        RAISE EXCEPTION USING ERRCODE='LC024',
            MESSAGE='Location ' || NEW.branch_location_id
                || ' is the warehouse: an expense belongs to a branch';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER admit_branch_expense BEFORE INSERT ON branch_cash_movements
FOR EACH ROW EXECUTE FUNCTION admit_branch_expense();
