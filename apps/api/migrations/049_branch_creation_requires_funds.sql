-- A branch is never born without funds (S1-S3, S12). 048 installed
-- `create_branch_funded` on top of the `create_branch(text)` of 014, and that was a
-- wrapper, not a rule: the old seam stayed callable, so anything holding it -- the
-- service of that version, a maintenance script, a fixture -- could still create a
-- branch with no money at all. This version closes that door for good. The amount
-- of a founding is mandatory because the only way to create a branch states both
-- amounts, and `0,00` is stated as `0.00` and never as silence.
--
-- Three things, and they only make sense together:
--
--   1. `create_branch_funded` is restated whole. What 014 stated as
--      `create_branch(text)` -- the initialization serialization lock, the
--      requirement of an initialized catalogue, the allocation of the next
--      identity and the insert that the zero-stock and audience triggers watch --
--      is now the first half of the founding, statement by statement and with the
--      same lock, so the branch a caller creates is the same branch it always was:
--      same next id, same 190 zero balances, same realtime audience, same grant
--      revoked from PUBLIC;
--   2. its money is untouched: the two `aporte` rows of the two ledgers, signed by
--      the administrator that creates the branch, written in the same transaction
--      under the marker 048 installed (S4). An amount of `0.00` writes no row,
--      because a zero is the empty sum of a book and not a movement to explain;
--   3. `create_branch(text)` is dropped. Nothing may create a branch without funds
--      any more, and a seam that exists is a seam somebody calls. The drop comes
--      after the restatement, so no function of this schema is left calling it.
--
-- Writing: this file replaces one function, revokes it from PUBLIC again -- a
-- replaced function keeps its ACL, and the founding is the administrator's act --
-- and drops one function. No table, no view, no trigger, no ledger row and no
-- settlement is written: the branches that already exist keep exactly the money
-- 048 gave them.
--
-- Why the allocation is restated instead of kept behind a private helper. The
-- helper would be the same seam under another name: a body someone can call where
-- the money is missing, with the initialization lock and the fanout triggers still
-- at its disposal. What S1 asks for is that no such body exists, so the one
-- function that creates a branch is the one function that requires its two amounts.
CREATE OR REPLACE FUNCTION create_branch_funded(branch_name text, opening_cash numeric,
    purchase_fund numeric, creator_account_id integer) RETURNS smallint LANGUAGE plpgsql AS $$
DECLARE
    branch_id smallint;
BEGIN
    -- The two amounts come first: a founding that does not state them is refused
    -- before anything is allocated, so a rejected call leaves no identity consumed
    -- and no location behind (S1, S3, S12).
    IF opening_cash IS NULL OR purchase_fund IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='LF001',
            MESSAGE='The founding of a branch states its opening cash and its purchase fund';
    END IF;
    IF opening_cash < 0 OR purchase_fund < 0 THEN
        RAISE EXCEPTION USING ERRCODE='LF001',
            MESSAGE='The opening of a branch is never negative';
    END IF;
    -- The allocation 014 stated, unchanged: reuse the initialization serialization
    -- instead of competing with it, require an initialized catalogue, and let the
    -- insert triggers fan out the zero balances and the realtime audience.
    PERFORM pg_advisory_xact_lock(21485914531180593);
    IF NOT EXISTS (SELECT 1 FROM initialization_metadata) THEN
        RAISE EXCEPTION 'catalog initialization is required';
    END IF;
    SELECT (max(id)::integer + 1)::smallint INTO branch_id FROM locations;
    INSERT INTO locations(id,name) VALUES(branch_id,branch_name);
    -- The provenance of the two openings, set before both inserts and cleared after
    -- them: the marker is what admits an aporte signed by an account that belongs to
    -- no branch, and the guards of 048 refuse one for a branch this transaction did
    -- not create. The branch's own `locations` row carries this transaction's xmin,
    -- which is the proof a bare set_config cannot state.
    PERFORM set_config('luson.branch_founding', branch_id::text, true);
    IF opening_cash > 0 THEN
        INSERT INTO branch_cash_movements(branch_location_id,kind,amount,description,
            created_by_account_id)
        VALUES(branch_id,'aporte',opening_cash,'Fondo inicial de caja de la sucursal',
            creator_account_id);
    END IF;
    IF purchase_fund > 0 THEN
        INSERT INTO branch_fund_movements(branch_location_id,kind,amount,description,
            created_by_account_id)
        VALUES(branch_id,'aporte',purchase_fund,'Fondo inicial de compras de la sucursal',
            creator_account_id);
    END IF;
    PERFORM set_config('luson.branch_founding','',true);
    RETURN branch_id;
END;
$$;
-- The founding is the administrator's act: it creates a location and writes money,
-- so it is not callable by everybody. 048 revoked this and a replaced function
-- keeps its ACL; it is stated here because this version is where the function
-- became the only way to create a branch.
REVOKE ALL ON FUNCTION create_branch_funded(text,numeric,numeric,integer) FROM PUBLIC;

-- The old seam is gone. Every caller -- the administration service, the fixtures,
-- the maintenance scripts -- reaches the founding and therefore states its two
-- amounts. Nothing else in this schema references it: 048's wrapper was its only
-- caller and the restatement above took that call into itself.
DROP FUNCTION create_branch(text);

COMMENT ON FUNCTION create_branch_funded(text,numeric,numeric,integer) IS
    'The only way to create a branch (S1): allocates the next location identity with the initialized-catalogue lock and the zero-stock fanout of 014, and writes the opening cash and the purchase fund as the two opening aportes of their ledgers, signed by the administrator that creates it. Both amounts are mandatory and 0,00 is stated as 0.00.';
