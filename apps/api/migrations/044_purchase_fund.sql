-- The purchase fund ("fondo de compras") is a branch's second envelope of physical money
-- (S1): it is counted apart from the operating drawer, it buys used batteries and scrap and
-- nothing else, and no money of a sale ever feeds it (S2, S12). This version installs it
-- twice over: as data of the settlement, and as the rule that a purchase is paid in cash
-- from it and can never spend more than it holds (S3, S4).
--
-- Why two nullable columns and not a new required fact. The settlement states the envelope
-- the warehouse counted (purchase_fund_counted) and the amount the warehouse leaves in it,
-- which is the balance that opens the next period (purchase_fund_cash). Both are nullable on
-- purpose: every settlement already stored has no envelope, and the screen that states one
-- lands with the next version, so a settlement that closes today still closes without one and
-- no row of this database has to be invented to satisfy a constraint.
--
-- Why the transition guard of 034 is replaced whole instead of edited: 001-043 are applied
-- and their checksums recorded, so no statement of 034 is rewritten. It is redefined with
-- CREATE OR REPLACE, exactly as 039 redefines the opener and 037 the offer, and its trigger is
-- not recreated: the trigger of 034 keeps calling the function it already names, and a second
-- trigger on the same event would run the guard twice. The body is 034's, statement by
-- statement, with one difference: the envelope joins the drawer in the comparison the branch
-- decides against, so a proposed settlement cannot be closed or rejected with an amount other
-- than the one it was offered (LC005).
--
-- Why the envelope is a draft. While the settlement is open or rejected the two columns belong
-- with cash_sales, cash_expenses, counted_cash, contributed_cash, closing_cash and
-- observation: they are the admin's own reading of the branch until the warehouse proposes
-- them, and from the proposal on they are part of the offer the branch decides. They are
-- deliberately not required at the closure yet, because the screen that states them is not
-- part of this version: the closure check of 034 keeps naming only counted_cash and
-- closing_cash.
--
-- Why the purchase rule is a trigger on purchases and not a check of the settlement. A
-- purchase can never exceed what the envelope holds (S4), and that has to be refused where the
-- money is spent, not when the branch is settled: by then the banknote already left the drawer
-- and the only correction is the counter-document the document itself provides. The rule reads
-- the envelope of the latest closed settlement, and it writes no ledger row and no settlement
-- field, so the commission and the three cash equalities of the drawer keep their semantics
-- and this fund participates in none of them (S12).
--
-- Trigger order: PostgreSQL fires the BEFORE row triggers of a table in name order, so
-- admit_purchase_against_fund runs after admit_frozen_branch_purchase (035) and after
-- admit_purchase (032). A document that those rules already refuse is refused with their own
-- code, and only a document that is otherwise admissible is measured against the envelope.
--
-- Writing nothing: this file adds two columns to a table, replaces two functions and creates
-- one trigger. Adding a column fires no row trigger and writes no row, and no row of any table
-- is inserted, updated or deleted here. What it installs is the wall the next purchase hits;
-- the purchases already stored stay exactly as they are, and a branch corrects one with the
-- counter-document of the document itself.
--
-- The lock: the balance is read under the per-branch advisory lock 340252, the one this
-- envelope owns, while 034 and 035 take 340251 for the settlement of the same branch. It is
-- taken before anything is read, so two purchases of one branch can never both fit in the same
-- remaining amount.
--
-- The one case the balance cannot measure: a settlement that closed before this version, or
-- one that closes before the screen that states the envelope, holds NULL in
-- purchase_fund_cash. An unstated envelope is not zero: zero would refuse every purchase of a
-- branch whose last closure predates this version, and the amount is a fact only the closure
-- that states it owns. The comparison then yields NULL and the document is admitted exactly as
-- every purchase of that period was admitted before this version. Once the envelope is a fact
-- of the closure, that case has no rows left to describe.
ALTER TABLE branch_closings
    -- The envelope the warehouse counted at the closing.
    ADD COLUMN purchase_fund_counted numeric(12,2) CHECK (purchase_fund_counted >= 0),
    -- The amount the warehouse leaves in it, which is what opens the next period.
    ADD COLUMN purchase_fund_cash numeric(12,2) CHECK (purchase_fund_cash >= 0);

-- The settlement state machine of 034, redefined whole with the envelope in the freeze the
-- branch decides against. Nothing else of it changes: the identity stays frozen at open, a
-- live settlement is still drafted through its own money fields, the offer is still recorded
-- when it is proposed, only an accepted round still closes it, and the closure instant is
-- still the database's.
CREATE OR REPLACE FUNCTION admit_branch_closing_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    configured numeric(5,2);
    latest record;
    pending integer;
    excess numeric(12,2);
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='Account settlements are never deleted';
    END IF;
    IF OLD.status = 'closed' THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='A closed account settlement is not reopened; correct it';
    END IF;
    -- The identity is frozen at open: where and when the settlement settled, who opened
    -- it and the cash it inherited. (Its own id is an always-generated identity column,
    -- which PostgreSQL refuses to rewrite before any guard runs.)
    IF NEW.branch_location_id <> OLD.branch_location_id
       OR NEW.period_start <> OLD.period_start
       OR NEW.cut_at <> OLD.cut_at
       OR NEW.opened_by_account_id <> OLD.opened_by_account_id
       OR NEW.opening_cash <> OLD.opening_cash THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='The identity of an account settlement is frozen at open';
    END IF;
    -- The closure instant is taken by this guard below, never by a caller.
    IF NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='The closure instant belongs to the closure';
    END IF;
    -- The fund never exceeds the drawer the admin declares: the cash counted plus the
    -- contribution. Checked on every live write, so the admin gets this message while
    -- typing instead of a bare constraint violation from the row CHECK.
    IF NEW.counted_cash IS NOT NULL AND NEW.closing_cash IS NOT NULL
       AND NEW.closing_cash - NEW.counted_cash - NEW.contributed_cash > 0 THEN
        RAISE EXCEPTION USING ERRCODE='LC006',
            MESSAGE='The fund left behind exceeds the cash counted plus the contribution by '
                || (NEW.closing_cash - NEW.counted_cash - NEW.contributed_cash);
    END IF;
    -- "Guardar y salir": while the settlement is open or rejected the admin may persist
    -- a draft of the money it typed and of its observation, and nothing else. The
    -- draftable fields are exactly cash_sales, cash_expenses, counted_cash,
    -- contributed_cash, closing_cash and observation: they are drafts because until the
    -- closure they are the admin's own reading of the branch, not a fact of the period.
    -- cash_sales is the only one that stops being a draft: 035 overwrites it at the
    -- proposal with the sum of the sale payments of the window, and from then on the
    -- offer rule below freezes it (R1-001).
    -- A proposed settlement is not editable at all, because the branch is deciding that
    -- very offer; the period totals and the commission rate are never drafts.
    IF NEW.status = OLD.status THEN
        IF OLD.status NOT IN ('open','rejected') THEN
            RAISE EXCEPTION USING ERRCODE='LC005',
                MESSAGE='Only an open or a rejected settlement is drafted';
        END IF;
        IF NEW.sales_total <> OLD.sales_total
           OR NEW.commission_amount <> OLD.commission_amount
           OR NEW.card_total <> OLD.card_total
           OR NEW.transfer_total <> OLD.transfer_total
           OR NEW.qr_total <> OLD.qr_total
           OR NEW.commission_rate_percent IS DISTINCT FROM OLD.commission_rate_percent THEN
            RAISE EXCEPTION USING ERRCODE='LC005',
                MESSAGE='The period totals and the commission rate are not drafts';
        END IF;
        RETURN NEW;
    END IF;
    IF NOT (
        (OLD.status = 'open' AND NEW.status = 'proposed')
        OR (OLD.status = 'proposed' AND NEW.status = 'rejected')
        OR (OLD.status = 'rejected' AND NEW.status = 'proposed')
        OR (OLD.status = 'proposed' AND NEW.status = 'closed')
    ) THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='Unsupported account settlement transition';
    END IF;
    -- R1-001: the offer -- the five totals and the commission they pay -- is recorded
    -- when the settlement is proposed (035 computes it) and never rewritten afterwards.
    -- Neither a rejection nor the closure touches it: the branch is shown, decides and
    -- closes exactly the numbers the database recorded.
    IF NEW.status <> 'proposed'
       AND (NEW.sales_total <> OLD.sales_total
            OR NEW.cash_sales <> OLD.cash_sales
            OR NEW.commission_amount <> OLD.commission_amount
            OR NEW.card_total <> OLD.card_total
            OR NEW.transfer_total <> OLD.transfer_total
            OR NEW.qr_total <> OLD.qr_total) THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='The offer of a settlement is recorded when it is proposed';
    END IF;
    IF NEW.status = 'proposed' THEN
        -- The rate is a fact of the proposal (S6): it is read from branch_settings when
        -- the warehouse proposes, and frozen from then on, so changing the configured
        -- rate never alters a proposed or a closed settlement.
        SELECT commission_rate_percent INTO configured FROM branch_settings
        WHERE branch_location_id = NEW.branch_location_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LC003',
                MESSAGE='The branch has no commission rate configured';
        END IF;
        NEW.commission_rate_percent := configured;
        -- R3-001: a branch can never be offered a settlement whose count is incomplete.
        -- The refusal names the pending variant, exactly like the closure one does, so
        -- the admin knows which line of the count sheet is missing.
        SELECT variant_id INTO pending FROM closing_count_lines
        WHERE closing_id = OLD.id AND counted_quantity IS NULL ORDER BY variant_id LIMIT 1;
        IF pending IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='LC019',
                MESSAGE='Variant ' || pending || ' has no counted quantity';
        END IF;
        -- The offer is a round of the proposal (S14, S15): proposing opens one, so a
        -- settlement is never offered without the version that states it, and it can
        -- always be rejected because there is always a round to reject (R4-003).
        SELECT round, decision INTO latest FROM closing_proposals
        WHERE closing_id = OLD.id ORDER BY round DESC LIMIT 1;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='The settlement has no proposal round to offer';
        END IF;
        IF latest.decision IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='Proposal round ' || latest.round || ' is already decided';
        END IF;
    ELSIF NEW.commission_rate_percent IS DISTINCT FROM OLD.commission_rate_percent THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='The commission rate is frozen when the settlement is proposed';
    END IF;
    -- The branch decides on the numbers it was shown: once proposed, the drawer fields
    -- are the offer, and closing or rejecting must apply exactly that offer. They are
    -- draftable only while the warehouse holds the settlement.
    IF OLD.status = 'proposed' AND NEW.status IN ('rejected','closed') THEN
        IF NEW.cash_sales IS DISTINCT FROM OLD.cash_sales
           OR NEW.cash_expenses IS DISTINCT FROM OLD.cash_expenses
           OR NEW.counted_cash IS DISTINCT FROM OLD.counted_cash
           OR NEW.contributed_cash IS DISTINCT FROM OLD.contributed_cash
           OR NEW.closing_cash IS DISTINCT FROM OLD.closing_cash
           OR NEW.purchase_fund_counted IS DISTINCT FROM OLD.purchase_fund_counted
           OR NEW.purchase_fund_cash IS DISTINCT FROM OLD.purchase_fund_cash
           OR NEW.observation IS DISTINCT FROM OLD.observation THEN
            RAISE EXCEPTION USING ERRCODE='LC005',
                MESSAGE='The drawer of a proposed settlement is the offer the branch decides';
        END IF;
    END IF;
    -- R4-003: a rejection is the branch's answer to a round, so the latest round must
    -- itself be rejected. A header-only update can never bypass an accepted round, and
    -- it can never return a settlement to the warehouse that the branch did not refuse.
    IF NEW.status = 'rejected' THEN
        SELECT round, decision INTO latest FROM closing_proposals
        WHERE closing_id = OLD.id ORDER BY round DESC LIMIT 1;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='The settlement has no proposal round to reject';
        END IF;
        IF latest.decision IS DISTINCT FROM 'rejected' THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='Proposal round ' || latest.round || ' is not rejected';
        END IF;
    END IF;
    -- Only an accepted round closes a settlement (S14): nothing is applied by an offer
    -- the branch has not accepted, and nothing closes over an undecided one.
    IF NEW.status = 'closed' THEN
        IF EXISTS (SELECT 1 FROM closing_proposals
            WHERE closing_id=OLD.id AND decision IS NULL) THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='A proposal round is still undecided';
        END IF;
        SELECT round, decision INTO latest FROM closing_proposals
        WHERE closing_id=OLD.id ORDER BY round DESC LIMIT 1;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='The settlement has no proposal round to accept';
        END IF;
        IF latest.decision <> 'accepted' THEN
            RAISE EXCEPTION USING ERRCODE='LC016',
                MESSAGE='Proposal round ' || latest.round || ' was rejected, not accepted';
        END IF;
    END IF;
    -- The closure instant is the database's, taken by this BEFORE trigger: an AFTER
    -- trigger writes it too late, and re-writing the row it watches re-enters this
    -- very guard with a closed OLD row and refuses every closure. The ledger rows of
    -- the closure are written by 035, which applies them under this same lock.
    IF NEW.status = 'closed' THEN
        -- A closure always states the money it counted, the contribution the warehouse
        -- made and the fund it leaves, and the fund never exceeds the drawer: the cash
        -- counted plus the contribution.
        IF NEW.counted_cash IS NULL OR NEW.closing_cash IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='LC006',
                MESSAGE='A closure states the cash counted and the fund left behind';
        END IF;
        excess := NEW.closing_cash - NEW.counted_cash - NEW.contributed_cash;
        IF excess > 0 THEN
            RAISE EXCEPTION USING ERRCODE='LC006',
                MESSAGE='The fund left behind exceeds the cash counted plus the contribution by '
                    || excess;
        END IF;
        PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);
        NEW.closed_at := now();
    END IF;
    RETURN NEW;
END;
$$;

-- The envelope as a purchase rule (S2, S3, S4). A branch purchase is paid in cash from the
-- purchase fund, and it can never spend more than the fund holds since the last closing: the
-- balance is the amount that closure left, minus the cash of every document of the branch
-- since then, net of the counter-documents that return money.
CREATE FUNCTION admit_purchase_against_fund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    opening numeric(12,2);
    since timestamptz;
    spent numeric(12,2);
    available numeric(12,2);
BEGIN
    -- S2: the envelope is cash, so no part of a purchase is paid by transfer. The refusal is
    -- the document's own and it is raised before any balance is read: a document that is not
    -- paid in cash from the fund is refused whatever the fund holds.
    IF NEW.paid_transfer <> 0 THEN
        RAISE EXCEPTION USING ERRCODE='LP006',
            MESSAGE='A branch purchase is paid in cash from the purchase fund';
    END IF;
    -- A counter-document returns the money of its original: it charges no envelope and needs
    -- no balance to be admitted. It is read as a spend of the period by the sum below, where
    -- its negative amounts subtract what its original charged.
    IF NEW.reverses_purchase_id IS NOT NULL THEN
        RETURN NEW;
    END IF;
    -- The balance is read under the per-branch lock of this envelope, so two purchases of one
    -- branch cannot both pass against the same remaining amount.
    PERFORM pg_advisory_xact_lock(340252, NEW.location_id::integer);
    -- The envelope that opens the period is the amount the last closure left behind, and the
    -- period is everything the branch spent since that closure (S3). An envelope that was never
    -- declared is not enforced: a branch whose last closure predates this version, or that has
    -- never closed, is not charged against money nobody stated, because the amount becomes a
    -- fact of the closure the day the warehouse writes it. From that moment the ceiling is on
    -- for every document of the branch and there is no way back.
    SELECT settlement.purchase_fund_cash, settlement.closed_at INTO opening, since
    FROM branch_closings settlement
    WHERE settlement.branch_location_id = NEW.location_id AND settlement.status = 'closed'
    ORDER BY settlement.closed_at DESC LIMIT 1;
    IF NOT FOUND OR opening IS NULL THEN
        RETURN NEW;
    END IF;
    -- The cash of every document of the branch since then, counter-documents included: they
    -- are stored with their negative amounts, so a reversal inside the period gives the money
    -- back to the envelope.
    SELECT coalesce(sum(purchase.paid_cash),0) INTO spent FROM purchases purchase
    WHERE purchase.location_id = NEW.location_id AND purchase.created_at >= since;
    available := opening - spent;
    -- S4: the envelope pays what it holds and nothing more, and the refusal states how much is
    -- left so the branch knows what it can still buy.
    IF NEW.paid_cash > available THEN
        RAISE EXCEPTION USING ERRCODE='LP006',
            MESSAGE='A purchase cannot exceed the purchase fund: ' || available || ' available';
    END IF;
    RETURN NEW;
END;
$$;
-- The rule is a named trigger, so the document never depends on an implicit side effect of a
-- column, and its name keeps it after the rules of 032 and 035.
CREATE TRIGGER admit_purchase_against_fund BEFORE INSERT ON purchases
FOR EACH ROW EXECUTE FUNCTION admit_purchase_against_fund();
