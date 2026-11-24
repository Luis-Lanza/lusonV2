-- The finding on the shelf writes its stock off (S16). 021 and 022 state the repository's rule about
-- branch stock: only the warehouse registers ingress and only the warehouse adjusts, and every branch
-- is refused there with LS005. That rule is right -- a branch does not count itself into stock -- but
-- it left one fact with nowhere to go: a branch discovers a battery that is finished before selling
-- it, and there is no document that takes it off the branch's shelf. The branch could fake a transfer
-- to the warehouse, which would credit a movement that never happened, or it could say nothing and
-- meet the loss at the next settlement as an unexplained shortage. The case is the document of that
-- battery (065), and this version teaches it the one write of stock a branch is allowed to make.
--
-- Why the exception exists and exactly how narrow it is. It is the single exception (la excepción) to
-- LS005 in this repository, and it is a trigger on the admission of a case and on nothing else:
--
--   * it fires only on INSERT of `warranty_cases`, only for `origin = 'stock_defect'`, and only once
--     per case, because a case is written once; a `warranty_claim` returns before naming a balance,
--     so the claim of a sold unit never moves stock (S11, S16);
--   * the location it names is the case's own branch and the variant is the case's own variant, read
--     from the persisted row under its lock: no caller states either, so this path cannot be pointed
--     at another branch, at the warehouse or at a battery the case is not about;
--   * the account that opens the case must be the account of that branch, which 065 already refuses
--     otherwise (LW001), and the branch can never be location 1 (also 065): the actor and the
--     location of the exception are the actor and the location of the case;
--   * the decrement is the admission's own statement inside the admission's transaction -- there is
--     no second call, no confirmation step and no document of its own to forget -- so a case is
--     either stored with its stock written off or not stored at all;
--   * it decrements `existing` and never `reserved`, and it refuses a write-off that would leave
--     `existing` below `reserved`, exactly as 021, 022, 025 and 026 apply a signed quantity to a
--     balance (S16);
--   * it writes no document of the warehouse: no `stock_entries`, no `stock_adjustments`, no line,
--     no operation key and no reversal, because a branch ingress or adjustment is precisely what
--     LS005 forbids. The exception is this one UPDATE, and the audit of it is the case itself.
--
-- The reason travels with the case as a text of its own (S16). `reason` is stated here in the shape
-- 022 already uses for the motive of an adjustment -- one to five hundred characters, trimmed
-- non-empty -- and it is required exactly on a stock defect and forbidden on a claim, because a claim
-- writes nothing off and has no shelf in play. It is a fact of its own and not a reuse of
-- `declared_failure`: the one says what failed in the battery, the other says why the branch took it
-- off its books. The actor and the instant of the write-off are the case's own evidence --
-- `created_by_account_id` and `created_at` -- because the write-off is the admission: the same
-- transaction, the same row, the same instant, and no second actor to reconcile.
-- `guard_warranty_case_writeoff` freezes the reason once written, like the rest of what a case is
-- about (LW010): the motive of stock that left the branch is evidence and is never rewritten.
--
-- What is refused, with codes of this vertical and never a reused number (S23). 065 states LW001 to
-- LW015, so this file states the next ones:
--
--   * LW016 -- the branch does not have that many batteries: it holds no balance row for the variant,
--     or the quantity exceeds its `existing`. A write-off never invents a balance row and never writes
--     negative stock;
--   * LW017 -- the write-off would leave `existing` below `reserved`, so it would take stock the
--     branch already promised to a transfer or to a sale;
--   * LW018 -- the reason of a write-off is frozen once the case states it.
--
-- A refused write-off stores no case either, because the balance is written by the trigger of the
-- same row: the row is inserted, its trigger refuses, and the transaction that carried both is gone.
--
-- What this file does not decide, and where the settlement (la rendición de cuentas) reads it. The
-- stock difference of a branch settlement is not derived from documents: `seed_closing_count_lines`
-- (035) reads `inventory_balances.existing` live when the settlement opens and freezes it in
-- `closing_count_lines.expected_quantity`, and the closure (`apply_branch_closing_closure`, 035)
-- applies `counted_quantity` and refuses a variant whose live `existing` moved since that snapshot
-- (LC018). So a write-off that happens before a settlement opens is already inside its expectation
-- -- the branch counted less because it has less -- and the settlement charges no shortage for that
-- unit, which is what S16 asks of it; and a write-off attempted while a settlement of the branch is
-- open is not silently charged either, because that closure refuses to close at all. Teaching the
-- sheet of an open settlement to absorb a write-off registered after the snapshot is a change of
-- 035 and of the settlement's own contract, not of this file.
--
-- No realtime code is required here: 004 already installs `invalidate_balance_change` on
-- `inventory_balances`, so the difference this trigger applies invalidates the 'inventory' scope
-- inside the same transaction. Nothing of an applied migration is edited or redefined: this file adds
-- one column, its two checks, one guard trigger and one trigger that writes the balance.

-- The motive of a write-off, in the shape 022 states for an adjustment: a required text of one to
-- five hundred characters, stated by a stock defect and by nothing else.
ALTER TABLE warranty_cases
    ADD COLUMN reason text,
    ADD CONSTRAINT warranty_cases_reason_shape CHECK (reason IS NULL
        OR char_length(btrim(reason)) BETWEEN 1 AND 500),
    -- A claim never had a shelf in play, so it states no write-off reason at all (S11, S16).
    ADD CONSTRAINT warranty_cases_writeoff_reason CHECK ((origin = 'stock_defect') = (reason IS NOT NULL));

-- The write-off runs after the case is stored, still inside the transaction that admits it, and it
-- follows the order 021, 022, 025 and 026 use to apply a signed quantity: lock the document's row,
-- lock the balance row, compute the total in numeric so the bound is exact before any bigint cast,
-- refuse what the branch does not have and what its reserve covers, then write `existing` alone.
CREATE FUNCTION write_off_stock_defect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header warranty_cases%ROWTYPE;
    balance inventory_balances%ROWTYPE;
    total numeric;
BEGIN
    -- A claim writes nothing: the battery it is about was sold, it never belonged to the branch's
    -- shelf, and the writable stock of this vertical is the shelf of a stock defect and nothing else.
    IF NEW.origin <> 'stock_defect' THEN
        RETURN NULL;
    END IF;
    -- The case is the authority of the write-off, so it is read under its lock: the branch, the
    -- variant and the quantity are the persisted row's and never a parameter of this call.
    SELECT * INTO header FROM warranty_cases WHERE id=NEW.id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LW016',
            MESSAGE='A stock write-off requires a persisted case';
    END IF;
    SELECT * INTO balance FROM inventory_balances
    WHERE location_id=header.branch_location_id AND variant_id=header.variant_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LW016',
            MESSAGE='The branch holds none of that battery: there is no stock to write off',
            DETAIL=header.case_number;
    END IF;
    -- numeric arithmetic keeps the bound check exact before any bigint cast, exactly like 021, 022,
    -- 025 and 026; reserved is never written by a write-off.
    total := balance.existing::numeric - header.quantity::numeric;
    IF total < 0 THEN
        RAISE EXCEPTION USING ERRCODE='LW016',
            MESSAGE='The write-off exceeds the stock of this branch',
            DETAIL=header.case_number;
    END IF;
    -- A unit the branch already promised is not a unit it may write off (S16).
    IF total < balance.reserved THEN
        RAISE EXCEPTION USING ERRCODE='LW017',
            MESSAGE='A write-off requires stock the branch has not already reserved',
            DETAIL=header.case_number;
    END IF;
    UPDATE inventory_balances SET existing=total::bigint
    WHERE location_id=header.branch_location_id AND variant_id=header.variant_id;
    RETURN NULL;
END;
$$;
CREATE TRIGGER write_off_stock_defect AFTER INSERT ON warranty_cases
FOR EACH ROW EXECUTE FUNCTION write_off_stock_defect();

-- The reason of a write-off is the evidence of stock that left the branch, so it is frozen with the
-- rest of what a case is about: a closed case is the answer the client may ask for, and its motive is
-- never rewritten afterwards (S16, LW010).
CREATE FUNCTION guard_warranty_case_writeoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.reason IS DISTINCT FROM OLD.reason THEN
        RAISE EXCEPTION USING ERRCODE='LW018',
            MESSAGE='The reason of a write-off is frozen: it is the evidence of the stock it took',
            DETAIL=OLD.case_number;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER guard_warranty_case_writeoff BEFORE UPDATE ON warranty_cases
FOR EACH ROW EXECUTE FUNCTION guard_warranty_case_writeoff();
