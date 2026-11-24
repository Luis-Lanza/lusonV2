-- The notice and the release of a battery case (T5, S13, S14, S19, S23): the two facts that turn the
-- battery the factory returned into either the client's exchange or the branch's sellable stock.
--
-- Why they are not phases (S23). 065 froze a journey of six tramos -- received, in_transit,
-- at_warehouse, at_factory, resolved, closed -- and a case moves along it one edge at a time. The
-- notice the branch registers and the release the warehouse authorises are not steps of that journey:
-- nothing about the battery's position changes when the client is told that it came back, and nothing
-- changes when the warehouse decides that the unit waiting in custody goes to the shelf. Hanging them
-- on a seventh phase would have rewritten a vocabulary the backend and the frontend agreed on, and
-- hanging them on the existing six would have made a notice read as a movement of the battery. So the
-- history keeps one row per fact and gains the kind that tells them apart: `phase` is a tramo of the
-- journey, `notice` and `release` are facts of the same case that carry the phase the case already
-- holds. One append-only history, no new phase, and S23's six phases stay frozen.
--
-- What the narrowed LW006 states (065 keeps its number). A `phase` event must enter a phase the case
-- is not already in, exactly as before; a `notice` or a `release` must state the phase the case
-- already holds, because neither of them moves it. The two directions of one rule, refused with the
-- same code and with the same certainty: an event of this table can never move a case it did not mean
-- to move, and can never claim a position the case does not hold.
--
-- Who states each of them (S14, S19). The branch that owns the case registers the notice and the
-- warehouse authorises the release, and neither can take the other's fact: "la sucursal le debe la
-- respuesta al cliente y el almacén solo mueve la batería". The notice is the branch's because the
-- client is, and the release is the warehouse's because the balance between custodia and stock is what
-- the warehouse is for. The tramo that closes the case is the branch's as well, which is the other
-- half of S19: the warehouse moves the battery and never closes the case that answers to a client.
-- The three rules are triggers of the history and not promises of the application, so a handler that
-- forgot one -- or a session that went straight at the API -- is refused by the database itself.
--
-- Why the release writes the balance (S13, S14). 067 states the one write of stock a branch is
-- allowed: the admission of a `stock_defect` takes the units off the branch's shelf in the
-- transaction that admits the case, because a failed battery on the shelf is no longer sellable. S14
-- states what happens when the factory returns a unit the client never came back for: it becomes
-- sellable stock. That is the same boundary crossed the other way, so this file states its mirror
-- exactly as narrowly as 067 states its exception:
--
--   * it fires only on INSERT of a `release` event of `warranty_case_events`, and on nothing else;
--   * the location and the variant are the persisted case's own -- its branch and the battery it is
--     about -- read under the case's lock: no caller states either, so this path cannot be pointed at
--     another branch, at the warehouse or at a battery the case is not about;
--   * the units are the ones the case holds: what its finding wrote off its own shelf (067), or the
--     single repaired unit a claim got back for its client (S13). A claim whose battery never came
--     back -- kept by the factory, scrapped or sent to the used pool -- holds nothing to release and
--     is refused (LW025);
--   * the increment is the event's own statement inside the event's transaction, so a release is
--     either stored with its stock or not stored at all;
--   * it writes `existing` and never `reserved`, exactly like 067, and it writes no document of the
--     warehouse: no `stock_entries`, no `stock_adjustments`, no line and no operation key.
--
-- Together with 067 these are the two only stock writes of this vertical, and both are the case
-- crossing the boundary between the branch's stock and the custody of a case: down when the shelf
-- finds a battery failed, up when the warehouse releases the unit back. Nothing else of a case moves
-- a balance, and no other document of this repository is involved.
--
-- The gate of S14, stated by the database. A release requires a recorded notice (LW020) and it happens
-- once (LW019); a notice happens once as well (LW019); neither exists before the factory answered,
-- because before that there is no unit to notify and none to release (LW021). A second attempt is
-- refused, never silently ignored, so a decision that was already taken is never read as a new one.
--
-- What this file does not decide. The order of the journey is still 065's -- a case moves along the
-- frozen edge from its own phase -- and the store keeps judging it before writing. The resolution
-- matrix of a finding on the shelf is another document's (T4 refuses to resolve one here), so a
-- `stock_defect` reaches this release once its own resolution exists; the rule of the units is stated
-- for both doors because the boundary is one boundary.
--
-- Codes (S23). 065 states LW001 to LW015 and 067 states LW016 to LW018, so this file states the next
-- ones and repeats none:
--
--   * LW019 -- a case registers its notice once and authorises its release once;
--   * LW020 -- a release requires a recorded notice;
--   * LW021 -- neither exists before the factory answered the case;
--   * LW022 -- the notice is registered by the account of the case's own branch;
--   * LW023 -- the release is authorised by the warehouse;
--   * LW024 -- the release finds no balance row to receive the unit;
--   * LW025 -- the case holds no unit to release;
--   * LW026 -- the tramo that closes a case is written by the branch that owns it.
--
-- Nothing here touches an applied migration in place: 065's guard is narrowed forward by restating it
-- whole, so the order of a tramo keeps exactly one authority, and the rest of this file adds a column,
-- two indexes and one trigger.

-- The kind of a tramo: what the history row states. The default is the journey, so every event
-- written before this version reads as the tramo it was.
ALTER TABLE warranty_case_events
    ADD COLUMN kind text NOT NULL DEFAULT 'phase'
        CHECK (kind IN ('phase','notice','release'));

-- A case registers its notice once and is released once (S14): the guard states both as its own
-- refusal and these two indexes are the invariant behind it, so even a direct INSERT cannot register
-- a second one.
CREATE UNIQUE INDEX warranty_case_events_one_notice ON warranty_case_events(case_id)
WHERE kind='notice';
CREATE UNIQUE INDEX warranty_case_events_one_release ON warranty_case_events(case_id)
WHERE kind='release';

-- The guard of 065, narrowed forward: a tramo of the journey must change the phase, a notice and a
-- release must not, the factory file number stays where it was, and the three facts of S14 and S19
-- carry the actor rule of the side that owns them.
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
    -- One rule with two directions (LW006): a tramo enters a phase the case was not in, and a notice
    -- or a release states the phase the case already holds.
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
    -- The factory file number travels with the factory shipment and with nothing else, so a notice
    -- or a release can never transcribe one (S9, S10).
    IF (NEW.kind='phase' AND NEW.phase='at_factory') <> (btrim(NEW.factory_case_number) <> '') THEN
        RAISE EXCEPTION USING ERRCODE='LW007',
            MESSAGE='The factory shipment carries its file number, and only it',
            DETAIL=NEW.phase;
    END IF;
    -- The notice is the branch's fact (S19): the account that registers it belongs to the branch that
    -- owns the case, and a client is never notified by the account of another branch.
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
    -- The release is the warehouse's decision (S14, S19), it requires the recorded notice and it
    -- happens once.
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

-- The release returns the units the case holds in custody to the branch's sellable stock (S13, S14):
-- the exact mirror of the write-off of a finding (067), in the transaction of the event that states
-- it, with the case's own branch and the case's own variant.
CREATE FUNCTION release_case_unit_to_stock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    header warranty_cases%ROWTYPE;
    units bigint;
BEGIN
    -- Only a release moves a balance: a tramo of the journey and a notice write nothing.
    IF NEW.kind <> 'release' THEN
        RETURN NULL;
    END IF;
    -- The case is the authority of the release, so it is read under its lock: the branch, the variant
    -- and the units are the persisted row's and never a parameter of this call.
    SELECT * INTO header FROM warranty_cases WHERE id=NEW.case_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LW024',
            MESSAGE='A release requires a persisted case';
    END IF;
    -- The units in custody: what the finding wrote off this branch's shelf (067), or the repaired unit
    -- a claim got back for its client (S13). A battery the factory kept, scrapped or that belongs to
    -- the used pool never came back, so there is nothing to release (S11).
    IF header.origin = 'stock_defect' THEN
        units := header.quantity;
    ELSIF header.reported_destination = 'customer' THEN
        units := 1;
    ELSE
        RAISE EXCEPTION USING ERRCODE='LW025',
            MESSAGE='The case holds no unit to release: its battery never came back',
            DETAIL=header.case_number;
    END IF;
    -- A release adds, so it can never take a balance below zero and never invents a row the branch
    -- does not have: a branch the case wrote a shelf off for still holds that row.
    UPDATE inventory_balances SET existing=existing+units
    WHERE location_id=header.branch_location_id AND variant_id=header.variant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LW024',
            MESSAGE='The branch holds no balance row for the released battery',
            DETAIL=header.case_number;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER release_case_unit_to_stock AFTER INSERT ON warranty_case_events
FOR EACH ROW EXECUTE FUNCTION release_case_unit_to_stock();
