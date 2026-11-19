-- The rendición of a branch is the fact that freezes it, and the branch has to learn it while it
-- looks at the screen: the warehouse opening the settlement is an INSERT and proposing it is an
-- UPDATE, and both are writes the branch's own stream can carry (S8, S10).
--
-- Why the stream of the branch and not a topic of its own: the audience of every realtime reader is
-- already the location of its session. `015_dynamic_branches.sql` seeds one counter per location
-- (`transfers:<id>`), `admit_realtime_audience` admits no other counter, `parsePayload` refuses any
-- scope that is not that shape, the `EXCEPT` lists of `readRevisions` fail closed on a counter the
-- locations do not explain, and `install()` of the broker delivers a transfers event only to the
-- subscriber of that same location (S9). A settlement is a fact of one branch about itself, so it
-- reuses that audience instead of opening one: this version adds no row, no scope and no Go publish
-- path, and it restates neither the CHECK of 015, nor its seed, nor `admit_realtime_audience`, nor
-- `parsePayload`, nor `readRevisions`.
--
-- A settlement of a branch the audience of 015 never gave a counter to is written silently: the
-- counter is read under the lock of its own row first, and a missing row returns without a bump,
-- because a reader that received a hint of a scope the counters do not hold would fail closed on it.
CREATE FUNCTION invalidate_branch_closing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM scope FROM realtime_revisions
    WHERE scope = 'transfers:' || NEW.branch_location_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    UPDATE realtime_revisions SET revision = revision + 1
    WHERE scope = 'transfers:' || NEW.branch_location_id;
    -- PostgreSQL releases the hint only on commit. It carries the scope and no document: the branch
    -- reads its own settlement again through the API, never through the stream.
    PERFORM pg_notify('luson_realtime', 'transfers:' || NEW.branch_location_id);
    RETURN NULL;
END;
$$;
CREATE TRIGGER invalidate_branch_closing_write AFTER INSERT OR UPDATE ON branch_closings
FOR EACH ROW EXECUTE FUNCTION invalidate_branch_closing();
