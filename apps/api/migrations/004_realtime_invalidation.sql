-- Internal recovery evidence, never a browser cursor or activity count.
CREATE TABLE realtime_revisions (
    scope text COLLATE "C" PRIMARY KEY
        CHECK (scope IN ('inventory','transfers:1','transfers:2','transfers:3')),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO realtime_revisions(scope) VALUES
    ('inventory'),('transfers:1'),('transfers:2'),('transfers:3');

-- Four fixed rows cannot be rekeyed, removed, reset or decremented through
-- ordinary DML. Revision exhaustion fails the enclosing transaction closed.
CREATE FUNCTION protect_realtime_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.scope = OLD.scope AND NEW.revision > OLD.revision THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Realtime revisions are monotonic internal state';
END;
$$;
CREATE TRIGGER protect_realtime_revision BEFORE UPDATE OR DELETE ON realtime_revisions
FOR EACH ROW EXECUTE FUNCTION protect_realtime_revision();
CREATE TRIGGER protect_realtime_revisions_truncate BEFORE TRUNCATE ON realtime_revisions
EXECUTE FUNCTION protect_realtime_revision();

-- A transition table covers every participant in a multi-header INSERT. Lock
-- the complete set in ascending key order BEFORE any counter increment, not
-- origin-first/destination-first (which reverses for opposite-direction writes).
CREATE FUNCTION invalidate_pending_transfers() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audience text;
BEGIN
    PERFORM scope FROM realtime_revisions
    WHERE scope IN (
        SELECT 'transfers:' || origin_location_id FROM inserted_transfers
        UNION SELECT 'transfers:' || destination_location_id FROM inserted_transfers
    ) ORDER BY scope FOR UPDATE;

    UPDATE realtime_revisions r SET revision = r.revision + changes.n
    FROM (
        SELECT scope, count(*) AS n FROM (
            SELECT 'transfers:' || origin_location_id AS scope FROM inserted_transfers
            UNION ALL SELECT 'transfers:' || destination_location_id FROM inserted_transfers
        ) participants GROUP BY scope
    ) changes WHERE r.scope = changes.scope;

    FOR audience IN SELECT DISTINCT scope FROM (
        SELECT 'transfers:' || origin_location_id AS scope FROM inserted_transfers
        UNION SELECT 'transfers:' || destination_location_id FROM inserted_transfers
    ) participants ORDER BY scope LOOP
        PERFORM pg_notify('luson_realtime', audience);
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE TRIGGER invalidate_transfer_insert AFTER INSERT ON transfer_requests
REFERENCING NEW TABLE AS inserted_transfers
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_pending_transfers();

-- Seed INSERTs intentionally count as balance changes. LISTEN begins only
-- after initialization; identical transaction metadata may coalesce. No-op
-- UPDATEs are silent, and Pending headers never emit inventory invalidations.
CREATE FUNCTION invalidate_inventory_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.existing = OLD.existing AND NEW.reserved = OLD.reserved THEN
        RETURN NULL;
    END IF;
    UPDATE realtime_revisions SET revision = revision + 1 WHERE scope = 'inventory';
    PERFORM pg_notify('luson_realtime', 'inventory:0');
    RETURN NULL;
END;
$$;
CREATE TRIGGER invalidate_balance_change AFTER INSERT OR DELETE OR UPDATE OF existing,reserved
ON inventory_balances FOR EACH ROW EXECUTE FUNCTION invalidate_inventory_balance();
