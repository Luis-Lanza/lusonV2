-- 074_release_requires_decided_loans.sql
--
-- The release that closes a case states nothing about the fate of the loans of that case (S32). The used
-- pool of 071 is derived from the fates the loans state: a loan still `open` is a unit the branch gave
-- to its client and has not accounted for yet. Closing the case while one is open leaves that unit
-- counted in the wrong place for ever, and nobody is ever asked about it, because the act that would
-- have asked -- the delivery -- never happens on a case whose unit is bound for stock.
--
-- What this version does, and what it deliberately does not do. `release_case_unit_to_stock` only
-- refuses to close: it raises LW036 and writes nothing. The fate is the branch's own fact (S7, S23), it
-- becomes final the instant it is stated (LW012), and a release that guessed it would be a warehouse act
-- deciding what became of a battery the counter handed over. So the release never touches
-- `warranty_case_loans`: it asks the branch to decide by refusing the close, and nothing else.
--
-- Why the refusal is the case that closes and not every release. A case whose unit is destined to the
-- client is not closed by its release (S13, S31): it keeps closing with the delivery, and the delivery
-- is the act that settles every open loan of the case (S23). There the fate is asked for and recorded in
-- the same act, so a release with an open loan strands nothing and stays exactly as 073 stated it. The
-- case whose unit is bound for stock has no delivery left: its release is its last act, and it is the
-- only act that can be refused.
--
-- Where the rule lives and exactly how narrow it is (S23). 073 restates the two functions of 068 and 069
-- whole; this file restates the same two once more, so each fact keeps exactly one authority. Nothing
-- else of the vertical is touched:
--
--   * `admit_warranty_case_event` is restated verbatim, so the notice, the release, the actor split of
--     S14 and S19, the file number of the factory shipment and the close of the case bound for stock
--     (LW035) state exactly what 073 states -- the two directions of LW035 included;
--   * `release_case_unit_to_stock` keeps its parameters, its return type and its two guards: the case
--     that holds no unit to release is still refused with LW025, and the missing balance row of the
--     branch is still refused with LW024;
--   * the one refusal this version adds (LW036) reads the loans of the case and is judged after LW025,
--     so "the case holds no unit" keeps its own answer;
--   * the only write is still the mirror of 067 that 068 installed: `existing` of the case's own branch
--     and the case's own variant, plus the one unit the case holds, and never `reserved`;
--   * the pool de usadas of 071 is not touched at all: it reads the fates of the loans exactly as it
--     read them before, and this version never writes one.
--
-- Codes (S23). 065 states LW001 to LW015, 067 LW016 to LW018, 068 LW019 to LW026, 069 LW027 to LW032,
-- 071 LW033, 072 LW034 and 073 LW035, so this file states the next one and repeats none of the numbers
-- it merely restates:
--
--   * LW036 -- a case does not close with an undecided loan.
--
-- Nothing of an applied migration is edited in place: the two functions are narrowed forward by
-- restating them whole, and no table, no column and no row of any document is added or rewritten.

-- The pair that decides whether the branch may sell the unit is 073's, named once there and read here:
-- a claim, whose battery the factory returned repaired or replaced, and whose destination is the
-- branch's own shelf. This version does not restate it, because the fact has exactly one owner.


-- 069's guard, narrowed forward: the close of the case bound for stock is its release's (S31), and the
-- release states the close it writes. Everything 065, 068 and 069 state about a tramo, a notice and a
-- release is restated unchanged.
CREATE OR REPLACE FUNCTION admit_warranty_case_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header warranty_cases%ROWTYPE;
    next_ordinal integer;
    actor_location smallint;
    actor_enabled boolean;
BEGIN
    SELECT * INTO header FROM warranty_cases WHERE id=NEW.case_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LW008',
            MESSAGE='A case event requires a persisted case';
    END IF;
    SELECT coalesce(max(event.event_ordinal),0)+1 INTO next_ordinal
    FROM warranty_case_events event WHERE event.case_id=NEW.case_id;
    IF next_ordinal > 1000 THEN
        RAISE EXCEPTION USING ERRCODE='LW008',
            MESSAGE='A battery case admits at most one thousand events';
    END IF;
    NEW.event_ordinal := next_ordinal;
    -- One rule with three directions (LW006, LW035): a tramo of the journey enters a phase the case was
    -- not in, a notice states the phase the case already holds, and a release states the phase the case
    -- already holds unless its unit is bound for stock, where the release is the act that closes it.
    IF NEW.kind='phase' THEN
        IF NEW.phase = header.phase THEN
            RAISE EXCEPTION USING ERRCODE='LW006',
                MESSAGE='A case event enters a phase the case is not already in',
                DETAIL=NEW.phase;
        END IF;
    ELSIF NEW.kind='release' AND warranty_case_unit_bound_for_stock(header) THEN
        IF NEW.phase <> 'closed' THEN
            RAISE EXCEPTION USING ERRCODE='LW035',
                MESSAGE='The unit of this case is bound for stock: its release closes it',
                DETAIL=NEW.phase;
        END IF;
    ELSIF NEW.phase <> header.phase THEN
        RAISE EXCEPTION USING ERRCODE='LW006',
            MESSAGE='A notice and a release state the phase the case already holds',
            DETAIL=NEW.phase;
    END IF;
    -- The factory file number travels with the factory shipment and with nothing else (S9, S10).
    IF (NEW.kind='phase' AND NEW.phase='at_factory') <> (btrim(NEW.factory_case_number) <> '') THEN
        RAISE EXCEPTION USING ERRCODE='LW007',
            MESSAGE='The factory shipment carries its file number, and only it',
            DETAIL=NEW.phase;
    END IF;
    -- The usable unit of a claim whose destination is the shelf never leaves with a client (S31): the
    -- tramo that closes the case is the delivery's statement, and this battery is the branch's stock.
    IF NEW.kind='phase' AND NEW.phase='closed' AND warranty_case_unit_bound_for_stock(header) THEN
        RAISE EXCEPTION USING ERRCODE='LW035',
            MESSAGE='The unit of this case is bound for stock: its release closes it, the delivery never does',
            DETAIL=header.case_number;
    END IF;
    -- The notice is the branch's fact (S19).
    IF NEW.kind='notice' THEN
        SELECT location_id,enabled INTO actor_location,actor_enabled
        FROM auth_accounts WHERE id=NEW.actor_account_id;
        IF NOT FOUND OR NOT actor_enabled THEN
            RAISE EXCEPTION USING ERRCODE='LW022',
                MESSAGE='The notice of a case is registered by an enabled account',
                DETAIL=NEW.case_id::text;
        END IF;
        IF actor_location IS DISTINCT FROM header.branch_location_id THEN
            RAISE EXCEPTION USING ERRCODE='LW022',
                MESSAGE='The notice of a case is registered by the branch that owns it',
                DETAIL=header.case_number;
        END IF;
        -- A finding on the shelf has no client to call: the notice belongs to a claim (S14, S19).
        IF header.origin = 'stock_defect' THEN
            RAISE EXCEPTION USING ERRCODE='LW030',
                MESSAGE='A finding on the shelf has no client to notify',
                DETAIL=header.case_number;
        END IF;
        IF header.phase NOT IN ('resolved','closed') THEN
            RAISE EXCEPTION USING ERRCODE='LW021',
                MESSAGE='A case notifies its client once the factory has answered it',
                DETAIL=header.phase;
        END IF;
        IF EXISTS (SELECT 1 FROM warranty_case_events earlier
            WHERE earlier.case_id=NEW.case_id AND earlier.kind='notice') THEN
            RAISE EXCEPTION USING ERRCODE='LW019',
                MESSAGE='A case registers its notice once',
                DETAIL=header.case_number;
        END IF;
    END IF;
    -- The release is the warehouse's decision (S14, S19).
    IF NEW.kind='release' THEN
        SELECT location_id,enabled INTO actor_location,actor_enabled
        FROM auth_accounts WHERE id=NEW.actor_account_id;
        IF NOT FOUND OR NOT actor_enabled THEN
            RAISE EXCEPTION USING ERRCODE='LW023',
                MESSAGE='The release of a case is authorised by an enabled account',
                DETAIL=NEW.case_id::text;
        END IF;
        IF actor_location <> 1 THEN
            RAISE EXCEPTION USING ERRCODE='LW023',
                MESSAGE='The release of a case is authorised by the warehouse',
                DETAIL=header.case_number;
        END IF;
        -- The units of a finding never wait in custody: they came back at the resolution (S11, S13).
        IF header.origin = 'stock_defect' THEN
            RAISE EXCEPTION USING ERRCODE='LW031',
                MESSAGE='A finding on the shelf has no unit in custody to release',
                DETAIL=header.case_number;
        END IF;
        IF header.phase NOT IN ('resolved','closed') THEN
            RAISE EXCEPTION USING ERRCODE='LW021',
                MESSAGE='A case releases its unit once the factory has answered it',
                DETAIL=header.phase;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM warranty_case_events notice_row
            WHERE notice_row.case_id=NEW.case_id AND notice_row.kind='notice') THEN
            RAISE EXCEPTION USING ERRCODE='LW020',
                MESSAGE='A release requires a recorded notice',
                DETAIL=header.case_number;
        END IF;
        IF EXISTS (SELECT 1 FROM warranty_case_events released
            WHERE released.case_id=NEW.case_id AND released.kind='release') THEN
            RAISE EXCEPTION USING ERRCODE='LW019',
                MESSAGE='A case authorises its release once',
                DETAIL=header.case_number;
        END IF;
    END IF;
    -- The warehouse moves the battery and never closes the case that answers to a client (S19). The one
    -- close it writes is the release of the unit bound for stock, which the rule above already judged.
    IF NEW.kind='phase' AND NEW.phase='closed' THEN
        SELECT location_id,enabled INTO actor_location,actor_enabled
        FROM auth_accounts WHERE id=NEW.actor_account_id;
        IF NOT FOUND OR NOT actor_enabled THEN
            RAISE EXCEPTION USING ERRCODE='LW026',
                MESSAGE='The close of a case is written by an enabled account',
                DETAIL=NEW.case_id::text;
        END IF;
        IF actor_location IS DISTINCT FROM header.branch_location_id THEN
            RAISE EXCEPTION USING ERRCODE='LW026',
                MESSAGE='The close of a case is written by the branch that owns it',
                DETAIL=header.case_number;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- 069's release, narrowed forward: the units it returns are a claim's, and a claim whose unit is bound
-- for stock is the one whose release also closes the case (S31).
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
    -- The single unit a claim holds for its client (S13) and the usable unit whose destination is the
    -- branch's shelf (S31): either way one battery came back to the branch and becomes sellable stock. A
    -- battery the factory kept, scrapped or sent to the pool de usadas never came back as a sellable
    -- unit, so there is nothing to release (S11).
    IF header.reported_destination IS DISTINCT FROM 'customer'
       AND NOT warranty_case_unit_bound_for_stock(header) THEN
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
