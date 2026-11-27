-- 077_release_requires_the_unit_to_come_back.sql
--
-- The release returns the single unit a claim got back from the factory as a sellable battery (S11,
-- S13, S14). Whether there is such a unit is the verdict's fact: the factory returned it `repaired` or
-- `replaced`, or it never came back as something the branch may sell. The destination states where a
-- unit went and never in what condition it came back, which is the pair 073 names in its own header and
-- reads in `warranty_case_unit_bound_for_stock()` for the unit bound for stock.
--
-- The defect this version narrows forward. 069's release guard let a claim through whenever its
-- `reported_destination` was `customer`, whatever the verdict was, and then ran the balance update of
-- 068: a claim the factory answered `lost` -- the unit never came back -- or `unrepairable`, declared to
-- the client, was "released" and added one unit to the branch's sellable stock. One battery of stock
-- that never existed, written by the one act of the vertical that had stopped reading the verdict.
--
-- What the rule is, and where it stops (S11, S13, S14, S31). A release returns a unit that is in
-- custody, and the two facts that name it are the same two 073 names from the other side:
--
--   * the verdict is `repaired` or `replaced` -- the factory gave a usable battery back -- and
--   * the destination is `customer` or `stock` -- the unit came back to the branch, either for the
--     client who will collect it or for the branch's own shelf.
--
-- A claim whose battery never came back as a usable unit holds nothing to release and is refused with
-- LW025, exactly as 069 and 073 already refused a `not_covered` unit and a finding's units: `lost` is
-- the unit the factory kept, `unrepairable` is a battery nobody can sell, `refused_at_warehouse` is a
-- unit the factory never saw, `not_covered` is the pool de usadas of 071, and `scrap` with
-- `retained_by_factory` are the two destinations that state the unit did not come back to the branch.
--
-- What this version does not move. The release of a case whose unit is bound for stock still states the
-- `closed` it writes (LW035, 073); it still requires the recorded notice (LW020), the factory's answer
-- (LW021), the warehouse actor (LW023), happens once (LW019) and refuses to close while a loan is
-- undecided (LW036, 074); and it writes exactly what 068 installed and 069 narrowed -- `existing` of the
-- case's own branch and the case's own variant, plus the one unit the case holds, never `reserved`. The
-- unit a client-declared claim got back repaired or replaced is still released into that same sellable
-- stock and the case still closes with its delivery: that is the path 068 stated and 073 kept.
--
-- Codes (S23). 065 states LW001 to LW015, 067 LW016 to LW018, 068 LW019 to LW026, 069 LW027 to LW032,
-- 071 LW033, 072 LW034, 073 LW035 and 074 LW036. This version states no number of its own: it narrows a
-- guard forward and the refusal keeps the code the act already had.
--
-- Nothing of an applied migration is edited in place: the release is restated whole, so the fact keeps
-- exactly one authority, the trigger that calls it stays where 068 installed it, and no table, no column
-- and no row of any document is added or rewritten. The pair that decides the destination of a sellable
-- unit stays 073's, named once there and read here: this file declares no function of its own.

-- 074's release, narrowed forward: the unit it returns is the one the factory gave back as a sellable
-- battery, and the verdict is the fact that says so.
CREATE OR REPLACE FUNCTION release_case_unit_to_stock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header warranty_cases%ROWTYPE;
BEGIN
    -- Only a release moves a balance: a tramo of the journey and a notice write nothing.
    IF NEW.kind <> 'release' THEN
        RETURN NULL;
    END IF;
    SELECT * INTO header FROM warranty_cases WHERE id=NEW.case_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LW024',
            MESSAGE='A release requires a persisted case';
    END IF;
    -- The unit a release returns is in custody, and it takes both facts to say so (S11, S13, S14): the
    -- verdict states that the factory gave a usable battery back, and the destination states that the
    -- unit came back to the branch instead of leaving as scrap or staying with the factory. A claim
    -- whose battery never came back as a usable unit holds nothing to release, and the two doors that
    -- never hold one -- a finding on the shelf, whose units returned at its resolution, and an
    -- unresolved case, whose verdict is still null -- are refused here too, so the guard fails closed.
    IF header.origin <> 'warranty_claim'
       OR header.verdict IS NULL
       OR header.verdict NOT IN ('repaired','replaced')
       OR header.reported_destination IS NULL
       OR header.reported_destination NOT IN ('customer','stock') THEN
        RAISE EXCEPTION USING ERRCODE='LW025',
            MESSAGE='The case holds no unit to release: its battery never came back',
            DETAIL=header.case_number;
    END IF;
    -- The fate of every loan is the branch's own fact (S7, S32), and the used pool is derived from it
    -- (S17, S24). The release that closes the case is its last act, so it refuses to close while one of
    -- its loans is undecided: it never decides the fate itself, it only asks for it by refusing.
    IF warranty_case_unit_bound_for_stock(header)
       AND EXISTS (SELECT 1 FROM warranty_case_loans loan
            WHERE loan.case_id=header.id AND loan.fate='open') THEN
        RAISE EXCEPTION USING ERRCODE='LW036',
            MESSAGE='A case does not close with an undecided loan',
            DETAIL=header.case_number;
    END IF;
    UPDATE inventory_balances SET existing=existing+1
    WHERE location_id=header.branch_location_id AND variant_id=header.variant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LW024',
            MESSAGE='The branch holds no balance row for the released battery',
            DETAIL=header.case_number;
    END IF;
    RETURN NULL;
END;
$$;
