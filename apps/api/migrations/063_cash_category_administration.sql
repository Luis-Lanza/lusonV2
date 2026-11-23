-- The list of motives stops being a table that only a migration writes (S3, S4, S5, S7, S8, S10).
--
-- Three facts of the catalogue are not columns yet, and the administration cannot invent them:
--
-- * Who archived an option. `retired_at` says when; the screen says who, and a money-adjacent
--   catalogue that cannot name the author of an archival is not auditable. `retired_by` is a
--   snapshot of the actor's account name, taken by the API at the moment of the write, and it is
--   present exactly when `retired_at` is.
-- * Which option is the catch-all of the list. The branch may rename it, so a rule that looks for
--   the label `Otros gastos` breaks on the first rename. `pinned` is the structure that rule needs:
--   the seeded catch-all is pinned and an archive of a pinned option is refused by the database.
-- * That the list is never left without a usable option. Archiving the last active one would leave
--   every branch unable to record an expense, and the guard for it has to see every concurrent
--   archive, so it serializes on an advisory key instead of on the rows it counts.
--
-- And the branch has to learn a catalogue change while it looks at the screen (S8): a write on the
-- table now bumps a global counter and notifies its scope, the same way `004` does for inventory.
ALTER TABLE branch_cash_categories
    ADD COLUMN pinned boolean NOT NULL DEFAULT false,
    ADD COLUMN retired_by text;

-- The catch-all is the seeded last option. The rename of a pinned option is allowed; its archival
-- is not, and `pinned` is what stays true through a rename.
UPDATE branch_cash_categories SET pinned = true WHERE sort_order = 11 AND label = 'Otros gastos';

ALTER TABLE branch_cash_categories ADD CONSTRAINT branch_cash_categories_retirement_shape CHECK (
    (retired_at IS NULL AND retired_by IS NULL)
    OR (
        retired_at IS NOT NULL
        AND retired_by IS NOT NULL
        AND char_length(btrim(retired_by)) BETWEEN 1 AND 200
        AND retired_by = btrim(retired_by)
    )
);

COMMENT ON COLUMN branch_cash_categories.pinned IS
    'The catch-all of the closed list: the branch may rename it, the administration may never archive it.';
COMMENT ON COLUMN branch_cash_categories.retired_by IS
    'The account name that archived the motive, present exactly when retired_at is. A snapshot, not a reference.';

-- The administration adds, renames, archives and reactivates. Nothing else: the place of an option
-- in the list is stated once and never recomputed, its identity and its age never move, and a
-- pinned option is never archived. The archive of the last active option is refused under an
-- advisory lock taken for the whole transaction, so two concurrent archives cannot both see a
-- remaining sibling and both succeed.
CREATE FUNCTION guard_branch_cash_category() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE remaining integer;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = 'LC034',
            MESSAGE = 'A motive of the drawer is archived, never deleted';
    END IF;
    IF NEW.id <> OLD.id OR NEW.sort_order <> OLD.sort_order
        OR NEW.created_at <> OLD.created_at OR NEW.pinned <> OLD.pinned THEN
        RAISE EXCEPTION USING ERRCODE = 'LC034',
            MESSAGE = 'A motive of the drawer keeps its identity, its place and its pin';
    END IF;
    IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL THEN
        IF OLD.pinned THEN
            RAISE EXCEPTION USING ERRCODE = 'LC035',
                MESSAGE = 'The catch-all motive of the drawer is never archived';
        END IF;
        PERFORM pg_advisory_xact_lock(340253, 1);
        SELECT count(*) INTO remaining FROM branch_cash_categories
        WHERE retired_at IS NULL AND id <> OLD.id;
        IF remaining = 0 THEN
            RAISE EXCEPTION USING ERRCODE = 'LC036',
                MESSAGE = 'The last offered motive of the drawer is never archived';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER guard_branch_cash_category_write BEFORE UPDATE OR DELETE ON branch_cash_categories
FOR EACH ROW EXECUTE FUNCTION guard_branch_cash_category();

-- A global scope, the shape `inventory` already has: the list is global to every branch, so there
-- is no location to key it by. The counter is read under its own row lock first and a missing row
-- returns silently, because a reader that received a hint of a scope the counters do not hold
-- would fail closed on it.
ALTER TABLE realtime_revisions DROP CONSTRAINT realtime_revisions_scope_check;
ALTER TABLE realtime_revisions ADD CONSTRAINT realtime_revisions_scope_check
    CHECK (scope IN ('inventory', 'catalogue') OR scope ~ '^transfers:[1-9][0-9]{0,4}$');

CREATE OR REPLACE FUNCTION admit_realtime_audience() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.scope IN ('inventory', 'catalogue') OR NOT EXISTS (
        SELECT 1 FROM locations WHERE 'transfers:' || id = NEW.scope
    ) THEN
        RAISE EXCEPTION 'Realtime audience must identify an existing location';
    END IF;
    RETURN NEW;
END;
$$;
-- A global scope is stated once by its own migration and is never insertable afterwards, which is
-- exactly what this guard already did to `inventory`. The seed therefore runs with the guard off.
ALTER TABLE realtime_revisions DISABLE TRIGGER admit_realtime_audience;
INSERT INTO realtime_revisions(scope) VALUES ('catalogue') ON CONFLICT (scope) DO NOTHING;
ALTER TABLE realtime_revisions ENABLE TRIGGER admit_realtime_audience;

CREATE FUNCTION invalidate_branch_cash_categories() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM scope FROM realtime_revisions WHERE scope = 'catalogue' FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    UPDATE realtime_revisions SET revision = revision + 1 WHERE scope = 'catalogue';
    -- Released only on commit. It carries the scope and no row: every reader re-reads the list
    -- through the API, never through the stream.
    PERFORM pg_notify('luson_realtime', 'catalogue:0');
    RETURN NULL;
END;
$$;
CREATE TRIGGER invalidate_branch_cash_categories_write
AFTER INSERT OR UPDATE ON branch_cash_categories
FOR EACH ROW EXECUTE FUNCTION invalidate_branch_cash_categories();
