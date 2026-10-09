-- Status-only invalidation complements, rather than replaces, the INSERT
-- trigger. Lifecycle guards still admit only immutable Pending decisions.
-- A statement trigger cannot use UPDATE OF with transition tables.
CREATE FUNCTION invalidate_transfer_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audience text;
BEGIN
    -- Gather the COMPLETE changed participant set before incrementing any
    -- revision. Stable C-collated ordering matches migration004's INSERT path;
    -- locking origin first would invert the order for opposite-direction flows.
    PERFORM scope FROM realtime_revisions
    WHERE scope IN (
        SELECT 'transfers:' || n.origin_location_id
        FROM updated_transfers n JOIN previous_transfers o USING (id)
        WHERE n.status IS DISTINCT FROM o.status
        UNION
        SELECT 'transfers:' || n.destination_location_id
        FROM updated_transfers n JOIN previous_transfers o USING (id)
        WHERE n.status IS DISTINCT FROM o.status
    ) ORDER BY scope FOR UPDATE;

    -- Match INSERT revision counts: each changed header contributes once to
    -- each participant, while notification audiences are deduplicated below.
    UPDATE realtime_revisions r SET revision = r.revision + changes.n
    FROM (
        SELECT scope, count(*) AS n FROM (
            SELECT 'transfers:' || n.origin_location_id AS scope
            FROM updated_transfers n JOIN previous_transfers o USING (id)
            WHERE n.status IS DISTINCT FROM o.status
            UNION ALL
            SELECT 'transfers:' || n.destination_location_id
            FROM updated_transfers n JOIN previous_transfers o USING (id)
            WHERE n.status IS DISTINCT FROM o.status
        ) participants GROUP BY scope
    ) changes WHERE r.scope = changes.scope;

    FOR audience IN SELECT scope FROM (
        SELECT 'transfers:' || n.origin_location_id AS scope
        FROM updated_transfers n JOIN previous_transfers o USING (id)
        WHERE n.status IS DISTINCT FROM o.status
        UNION
        SELECT 'transfers:' || n.destination_location_id
        FROM updated_transfers n JOIN previous_transfers o USING (id)
        WHERE n.status IS DISTINCT FROM o.status
    ) participants ORDER BY scope LOOP
        -- PostgreSQL releases metadata only on successful commit. No IDs,
        -- outcome fields or inventory invalidation are introduced here.
        PERFORM pg_notify('luson_realtime', audience);
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE TRIGGER invalidate_transfer_status_update AFTER UPDATE ON transfer_requests
REFERENCING OLD TABLE AS previous_transfers NEW TABLE AS updated_transfers
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_transfer_status();
