-- An expense is recorded when it happens (S12): the branch spends the money and writes it
-- down. Until now occurred_at was a caller's column with a default, so a hand-written row
-- could be dated inside the window of a settlement that is already closed. The total of that
-- settlement is frozen, but the list of expenses it publishes is read from the ledger, so a
-- backdated row would change the history a branch has already signed while the total stayed
-- still — the worst of both.
--
-- The trigger states the rule in the database's own terms: a gasto is stamped with the
-- instant it is written. The settlement transfers keep the instant their closure writes,
-- because those are the closure's facts and not the branch's.
CREATE FUNCTION stamp_branch_expense() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Only the branch's own expenses: the settlement transfer is written by the closure,
    -- which is a different fact and already carries its own instant.
    IF NEW.kind = 'gasto' THEN
        NEW.occurred_at := now();
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER stamp_branch_expense_before_insert BEFORE INSERT ON branch_cash_movements
FOR EACH ROW EXECUTE FUNCTION stamp_branch_expense();

-- The ledger is append-only (035), so no later statement can move the instant either. State
-- it again here so that this migration is the place that owns the rule: an update of the
-- ledger is refused by 035's guard, and this trigger is what makes the insert honest.
COMMENT ON COLUMN branch_cash_movements.occurred_at IS
    'The instant the fact was written. An expense is stamped by stamp_branch_expense; a settlement transfer by its closure.';
