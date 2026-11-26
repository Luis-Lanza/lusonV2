-- The stock door resolves its own shelf (S11): the fact that lets a branch finish the circuit it opened
-- when it found a battery dead on its own shelf, and the third and last stock write of this vertical.
--
-- Why the units come back here, and not at a release. 067 takes the units of a finding off the branch's
-- own balance in the transaction that admits the case, because a battery found failed is no longer
-- sellable. 068 releases the single unit a *claim* holds in custody back to that branch when the
-- warehouse authorises it, and the two are the same boundary crossed the other way. A finding has
-- neither a client to notify nor a custody to release: the battery was the branch's own from the first
-- instant, so the fact that returns it is the verdict the factory or the warehouse reached, stated by
-- the resolution of the case and by nothing else. That is what S11 asks -- "replaced de un stock_defect
-- ingresa la unidad nueva al stock de la sucursal" -- and it is the exact mirror of 067: down at the
-- admission, up at the resolution, in the transaction of the document that states each of them.
--
-- The matrix of the stock door, stated where it writes. The verdict says where the units of the shelf
-- end, and `stock_destination` is that fact as a column: it is `stock` exactly when the units return to
-- the branch's sellable stock, and null when they do not. The store judges the pair before it writes and
-- this file checks it again, because a balance must never move on a verdict the matrix does not state:
--
--   * `repaired` and `replaced` return the units: the repaired ones, or the replacement that enters in
--     their place, are sellable stock of the case's own branch, and the balance gains the case's own
--     quantity once;
--   * `not_covered` leaves the write-off of 067 standing: the factory refused the warranty, the damaged
--     units stay in the pool de usadas (or leave as scrap) and the branch is credited with nothing,
--     because the units it wrote off never came back sellable -- the same rule the claim's `not_covered`
--     states for the damaged unit of a sale;
--   * `unrepairable` and `lost` return nothing as well: no unit of this branch came back sellable, so no
--     balance moves and the write-off stands;
--   * `refused_at_warehouse` is the warehouse's gate before the factory (S10): it closes the case at the
--     warehouse and returns no unit to stock either.
--
-- How narrow it is, in the terms 067 uses for its own exception. This is a trigger on the append of the
-- `resolved` tramo of a case and on nothing else:
--
--   * it fires only on INSERT of `warranty_case_events`, only for a `phase` event that enters
--     `resolved`, which is the one tramo that resolves a case: a notice and a release move nothing and a
--     tramo of the journey never states a verdict;
--   * it acts only on a `stock_defect`; a `warranty_claim` returns before naming a balance, because the
--     claim's units are the release's (068) and its resolution writes no stock (S11);
--   * the branch, the variant and the quantity are the persisted case's own, read under its lock: no
--     caller states either, so this path cannot be pointed at another branch, at the warehouse or at a
--     battery the case is not about;
--   * the increment is the event's own statement inside the event's transaction, so a resolution is
--     either stored with its stock or not stored at all;
--   * it happens once per case, and a second attempt is refused rather than ignored: a case enters
--     `resolved` once (065 refuses a tramo that enters the phase the case already holds, LW006) and the
--     resolution of a case is final, so there is no second tramo for this file to see. What it does
--     refuse is a finding that resolves without a verdict (LW027) or with a shelf destination its
--     verdict does not state (LW028): a case that says nothing about its shelf never moves one;
--   * it writes `existing` and never `reserved`, and it writes no document of the warehouse: no
--     `stock_entries`, no `stock_adjustments`, no line, no operation key and no reversal. Together with
--     067 and 068 these are the three stock writes of this vertical, and each one is the case crossing
--     the boundary between the branch's stock and its custody.
--
-- Nothing of a finding waits in custody, so nothing of a finding is notified or released (S14, S19).
-- 068 states the notice the branch registers and the release the warehouse authorises; both belong to
-- the client of a claim, and both are narrowed forward here, restating 068's guard whole exactly as 068
-- restated 065's: a finding registers no notice (LW030) and authorises no release (LW031), because there
-- is no client to call and its units already returned at its resolution. The release function 068
-- installs is restated as well, so the units of a claim stay the only ones it moves.
--
-- Codes (S23). 065 states LW001 to LW015, 067 states LW016 to LW018 and 068 states LW019 to LW026, so
-- this file states the next ones and repeats none of the numbers it merely restates:
--
--   * LW027 -- a finding is resolved by its verdict, and the tramo that resolves it states none;
--   * LW028 -- the shelf destination of a finding is the verdict's own reading: `stock` when the units
--     return and null when the write-off stands;
--   * LW029 -- the branch holds no balance row to receive the units that return;
--   * LW030 -- a finding on the shelf registers no notice: there is no client to call;
--   * LW031 -- a finding on the shelf authorises no release: it holds no unit in custody;
--   * LW032 -- the units that return exceed bigint inventory, exactly the bound 021, 022, 025 and 026
--     check before every cast.
--
-- What this file does not decide. The journey is still 065's and the store still judges every tramo
-- before writing it: this file neither moves a phase nor opens an edge. It takes no decision about the
-- used pool -- which is what `not_covered` leaves the damaged units in -- because the pool is derived by
-- flow in the settlement (066) and has no stock of its own (S18). And it decides nothing about money:
-- no cash row, no transfer and no line of any document of this repository is written here.
--
-- Nothing of an applied migration is edited in place: 068's guard and release function are narrowed
-- forward by restating them whole, so each fact keeps exactly one authority, and the rest of this file
-- adds one function and one trigger.

-- 068's guard, narrowed forward: the two facts of S14 belong to a claim, whose client is waiting for an
-- answer, and a finding on the shelf answers to no one.
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
    -- One rule with two directions (LW006): a tramo enters a phase the case was not in, and a notice or
    -- a release states the phase the case already holds.
    IF NEW.kind='phase' THEN
        IF NEW.phase = header.phase THEN
            RAISE EXCEPTION USING ERRCODE='LW006',
                MESSAGE='A case event enters a phase the case is not already in',
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
        -- A finding on the shelf has no client to call: the notice belongs to a claim, whose client is
        -- waiting for the battery (S14, S19).
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
        -- The units of a finding never wait in custody: they are the branch's own and they came back at
        -- the resolution, so a release would move them a second time (S11, S13).
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
    -- The warehouse moves the battery and never closes the case that answers to a client (S19).
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

-- 068's release, narrowed forward: the units it returns are a claim's, because a finding's release is
-- refused above and a finding's units come back at its resolution, below.
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
    -- The single repaired unit a claim got back for its client (S13). A battery the factory kept,
    -- scrapped or that belongs to the used pool never came back, so there is nothing to release (S11).
    IF header.reported_destination IS DISTINCT FROM 'customer' THEN
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

-- The resolution of a finding returns its units to the branch that wrote them off (S11): the mirror of
-- 067, in the transaction of the tramo that resolves the case, with the case's own branch and the case's
-- own variant.
CREATE FUNCTION restock_stock_defect_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header warranty_cases%ROWTYPE;
    balance inventory_balances%ROWTYPE;
    total numeric;
BEGIN
    -- The resolution of a finding is a tramo of its journey and nothing else: a notice never writes a
    -- balance, a release belongs to a claim, and no other tramo states a verdict.
    IF NEW.kind <> 'phase' OR NEW.phase <> 'resolved' THEN
        RETURN NULL;
    END IF;
    -- The case is the authority of the movement, so it is read under its lock: the branch, the variant,
    -- the quantity and the verdict are the persisted row's and never a parameter of this call.
    SELECT * INTO header FROM warranty_cases WHERE id=NEW.case_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LW027',
            MESSAGE='A resolution requires a persisted case';
    END IF;
    -- A claim's units are the release's (068): its resolution moves no stock (S11).
    IF header.origin <> 'stock_defect' THEN
        RETURN NULL;
    END IF;
    -- The verdict is what states where the units of the shelf end, so a case that enters `resolved`
    -- without one has nothing this file could apply to its shelf (LW027).
    IF header.verdict IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='LW027',
            MESSAGE='A finding is resolved by its verdict, and it states none',
            DETAIL=header.case_number;
    END IF;
    IF header.verdict IN ('repaired','replaced') THEN
        -- The units come back repaired, or a replacement enters in their place: either way the branch's
        -- own sellable stock gains what the admission took off it, so the shelf destination is stated.
        IF header.stock_destination IS DISTINCT FROM 'stock' THEN
            RAISE EXCEPTION USING ERRCODE='LW028',
                MESSAGE='A finding that returns its units states its shelf as stock',
                DETAIL=header.case_number;
        END IF;
        SELECT * INTO balance FROM inventory_balances
        WHERE location_id=header.branch_location_id AND variant_id=header.variant_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='LW029',
                MESSAGE='The branch holds no balance row for the units that return',
                DETAIL=header.case_number;
        END IF;
        -- numeric arithmetic keeps the bound check exact before any bigint cast, exactly like 021, 022,
        -- 025 and 026; reserved is never written by a resolution.
        total := balance.existing::numeric + header.quantity::numeric;
        IF total > 9223372036854775807 THEN
            RAISE EXCEPTION USING ERRCODE='LW032',
                MESSAGE='The units that return exceed bigint inventory',
                DETAIL=header.case_number;
        END IF;
        UPDATE inventory_balances SET existing=total::bigint
        WHERE location_id=header.branch_location_id AND variant_id=header.variant_id;
        RETURN NULL;
    END IF;
    -- Every other verdict leaves the write-off of 067 standing: the damaged units stay in the used pool
    -- or leave as scrap, and the branch gets no sellable unit back (S11).
    IF header.stock_destination IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='LW028',
            MESSAGE='A finding that keeps its written-off units states no shelf destination',
            DETAIL=header.case_number;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER restock_stock_defect_resolution AFTER INSERT ON warranty_case_events
FOR EACH ROW EXECUTE FUNCTION restock_stock_defect_resolution();
