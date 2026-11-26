-- The warranty case reaches its two participants while they look at their screens (T10, S22):
-- the branch that owns the case and the warehouse that moves the battery have to learn a write of
-- the other side without a reload. The stream already exists -- `004` states the counters and the
-- notification, `015` keys them by location, `063` adds the global catalogue -- and this file adds
-- the one audience the case needs instead of inventing a second transport.
--
-- Why a participant audience and not the branch's `transfers:<id>` (the shortcut `058` takes for a
-- settlement). A settlement is a fact of one branch about itself; a case is one document of two
-- locations, exactly like a transfer, so it is delivered to the subscriber of the branch and to the
-- subscriber of the warehouse and to nobody else. Reusing `transfers:<id>` would have woken every
-- transfer reader on a warranty write, which is a behaviour change of another vertical (S21), and
-- `063`'s `catalogue` scope is global, which no case is. So the counter is `warranty:<id>`, one per
-- existing location, and the broker's `parsePayload` refuses every other shape.
--
-- What a case write is. Every persisted write of the vertical is one of three rows: the case itself
-- is inserted once (both doors), the append-only history gains one row per tramo, notice and release,
-- and the loans gain a row per handover and change one when a fate is decided. The three triggers
-- below are the only producers, and each one reads the branch from the persisted case under its own
-- lock, so a caller never states an audience.
--
-- The payload stays empty: `warranty:0` is not a scope and no record travels through the stream. The
-- hint only says which counter moved, and each reader re-reads its own private data through the API.
--
-- Codes (S23). This file states no `LW` code: it refuses nothing a client writes, it only counts a
-- write that already happened. Nothing of an applied migration is edited in place either: `015`'s
-- CHECK and `063`'s audience guard are narrowed forward by restating them whole, and `030`'s branch
-- initialization is restated with the second audience row, so the audience of a new branch keeps one
-- authority.
--
-- Why this is `070`: `069_stock_defect_returns_its_units.sql` is the highest version the repository
-- carries, and `db.versions` refuses a gap, so the next free contiguous number is 070.

-- The two per-location audiences share one grammar, so no other scope can ever be inserted.
ALTER TABLE realtime_revisions DROP CONSTRAINT realtime_revisions_scope_check;
ALTER TABLE realtime_revisions ADD CONSTRAINT realtime_revisions_scope_check
    CHECK (scope IN ('inventory', 'catalogue')
        OR scope ~ '^transfers:[1-9][0-9]{0,4}$'
        OR scope ~ '^warranty:[1-9][0-9]{0,4}$');

-- `063`'s guard, narrowed forward: a per-location audience is admitted when it names a location that
-- exists, under its own prefix, and no other scope is admitted.
CREATE OR REPLACE FUNCTION admit_realtime_audience() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.scope IN ('inventory', 'catalogue') OR NOT EXISTS (
        SELECT 1 FROM locations
        WHERE 'transfers:' || id = NEW.scope OR 'warranty:' || id = NEW.scope
    ) THEN
        RAISE EXCEPTION 'Realtime audience must identify an existing location';
    END IF;
    RETURN NEW;
END;
$$;

-- Every location that already exists gets its counter once. The guard admits the shape above, so no
-- trigger is disabled here; a replay is a no-op instead of a second row.
INSERT INTO realtime_revisions(scope)
SELECT 'warranty:' || id FROM locations
ON CONFLICT (scope) DO NOTHING;

-- `030`'s branch initialization, restated with the second audience row: a branch created afterwards
-- owns both counters, so a subscriber of a new branch never fails closed on a missing scope.
CREATE OR REPLACE FUNCTION initialize_branch_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- 015 and 030 own the transfers audience row; this version adds the warranty one beside it.
    INSERT INTO realtime_revisions(scope) VALUES ('transfers:' || NEW.id)
    ON CONFLICT (scope) DO NOTHING;
    INSERT INTO realtime_revisions(scope) VALUES ('warranty:' || NEW.id)
    ON CONFLICT (scope) DO NOTHING;
    IF EXISTS (SELECT 1 FROM initialization_metadata) THEN
        PERFORM pg_advisory_xact_lock(21485914531180593);
        INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
        SELECT NEW.id,v.id,0,0 FROM catalog_variants v
        JOIN catalog_entries e ON e.id=v.catalog_entry_id
        WHERE e.deleted_at IS NULL
        ORDER BY v.id;
    END IF;
    RETURN NEW;
END;
$$;

-- One case write, two audiences. The case is read for its own branch under the lock the caller
-- already holds on it, the two counter rows are locked in ascending key order before any increment
-- (a branch is never location 1, so `warranty:1` always sorts first and opposite writers cannot
-- reverse), and a counter that does not exist stays silent instead of being invented: a reader that
-- received a hint of a scope the counters do not hold would fail closed on it.
CREATE FUNCTION invalidate_warranty_case_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    target bigint;
    branch smallint;
    audience text;
BEGIN
    IF TG_TABLE_NAME = 'warranty_cases' THEN
        target := NEW.id;
    ELSE
        target := NEW.case_id;
    END IF;
    SELECT branch_location_id INTO branch FROM warranty_cases WHERE id = target;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    PERFORM scope FROM realtime_revisions
    WHERE scope IN ('warranty:' || branch, 'warranty:1') ORDER BY scope FOR UPDATE;
    FOR audience IN SELECT scope FROM (
        SELECT 'warranty:' || branch AS scope
        UNION SELECT 'warranty:1'
    ) participants ORDER BY scope LOOP
        UPDATE realtime_revisions SET revision = revision + 1 WHERE scope = audience;
        IF FOUND THEN
            -- PostgreSQL releases the hint only on commit. It carries the scope and no document.
            PERFORM pg_notify('luson_realtime', audience);
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;

-- The case is inserted once, by either door, and that admission is a write of both sides.
CREATE TRIGGER invalidate_warranty_case_admission AFTER INSERT ON warranty_cases
FOR EACH ROW EXECUTE FUNCTION invalidate_warranty_case_write();

-- Every tramo, notice and release is one appended row, and it moves the case as well (065, 068).
CREATE TRIGGER invalidate_warranty_case_event AFTER INSERT ON warranty_case_events
FOR EACH ROW EXECUTE FUNCTION invalidate_warranty_case_write();

-- A loan is handed over and later states its fate; both change what the case says about its units
-- (S5, S7), and the delivery of the exchange settles every open loan in the same act (S4).
CREATE TRIGGER invalidate_warranty_case_loan AFTER INSERT OR UPDATE ON warranty_case_loans
FOR EACH ROW EXECUTE FUNCTION invalidate_warranty_case_write();
