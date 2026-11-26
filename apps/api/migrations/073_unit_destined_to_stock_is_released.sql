-- 073_unit_destined_to_stock_is_released.sql
--
-- The unit of a case whose destination is `stock` is no longer delivered to a client (T11, S31): it is
-- the branch's sellable stock, the release the warehouse authorises is the act that enters it into that
-- stock, and that same release is the act that closes the case.
--
-- Why the destination alone never answers this question. `reported_destination` states where a unit went
-- and `verdict` states in what condition it came back from the factory, and it takes both facts to say
-- whether the branch may sell the battery (S11, S23):
--
--   * `repaired` or `replaced` with destination `stock` is a usable battery the factory gave back to the
--     branch that the client never came to collect. It is the branch's sellable stock, it never leaves
--     with a client, and the release is what enters it into `inventory_balances` -- once;
--   * `not_covered` with the same destination is the damaged battery the factory refused, which is the
--     pool de usadas of 071 and not a sellable unit at all. Its release stays refused with LW025, as 068
--     and 069 state today, it writes no balance, and its case keeps closing with the tramo of its
--     journey exactly as before this version.
--
-- So the pair is named once, in warranty_case_unit_bound_for_stock(), and the two triggers of this
-- vertical that read it read that pair and never the destination column alone.
--
-- The operation that raised this file (case C-2-000002). A case whose unit was bound for the shelf was
-- closed with the delivery, an act that states the battery left the branch with the client. No notice
-- and no release were ever recorded, so a battery the factory had repaired ended up in no stock at all
-- and the case asserted a handover that never happened. The delivery belongs to the battery the client
-- collects and to nothing else (S19); the unit bound for stock is sold by the release.
--
-- Where the rule lives and exactly how narrow it is (S23). 068 installs the notice, the release and the
-- actor split of S14 and S19, and 069 narrows both forward; this file restates exactly those two
-- functions whole, as 068 and 069 restated what they narrowed, and adds one function besides. Nothing
-- else of the vertical is touched:
--
--   * the guard of the history refuses a `phase` tramo that enters `closed` on a case whose unit is
--     bound for stock (LW035), because closing it is the delivery's own statement and this case has no
--     delivery: the branch cannot reach `closed` behind the counter's back;
--   * the release of such a case must state `closed`, which is the phase it writes and the reason the
--     case ends at all (LW035 otherwise). A release that stated the phase the case already holds would
--     leave the case with no act left, so the rule is refused in both directions;
--   * the release still requires the recorded notice (LW020) and the factory's answer (LW021), it still
--     belongs to the warehouse (LW023) and happens once (LW019), and it is still refused on a finding
--     (LW031): nothing of S14 or of S19 moves;
--   * the only write is the mirror of 067 that 068 installed and 069 narrowed: `existing` of the case's
--     own branch and the case's own variant, plus the one unit the case holds, and never `reserved`;
--   * the pool de usadas of 071 is not touched at all: it reads `not_covered` with destination `stock`
--     exactly as it read it before, the damaged battery stays its own fact, and no used-battery balance
--     is created here.
--
-- Codes (S23). 065 states LW001 to LW015, 067 LW016 to LW018, 068 LW019 to LW026, 069 LW027 to LW032,
-- 071 LW033 and 072 LW034, so this file states the next one and repeats none of the numbers it merely
-- restates:
--
--   * LW035 -- the usable unit of a case whose destination is stock is sold by the release and never
--     delivered, and the release that closes that case is the one that states `closed`.
--
-- Nothing of an applied migration is edited in place: the two functions are narrowed forward by
-- restating them whole, so each fact keeps exactly one authority, the triggers that call them stay where
-- 068 installed them, and no table, no column and no row of any document is added or rewritten.

-- The pair that says whether the branch may sell the unit (S31): a claim, whose battery the factory
-- returned repaired or replaced, and whose destination is the branch's own shelf. It is stated once
-- because two triggers read it -- the guard of the history and the release -- and neither may answer the
-- question from the destination column alone.
CREATE FUNCTION warranty_case_unit_bound_for_stock(case_row warranty_cases) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT case_row.origin = 'warranty_claim'
       AND case_row.reported_destination = 'stock'
       AND case_row.verdict IN ('repaired','replaced')
$$;

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
