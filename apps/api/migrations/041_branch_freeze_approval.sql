-- A frozen branch cannot have stock reserved for it either (S3): 035 guards dispatch and
-- receipt, but the approval of a request is the step that reserves the origin's units, and
-- a reservation made while the settlement is live leaves the settlement unclosable until
-- somebody cancels the request (the closure refuses any open reservation, LC007). Refusing
-- it at the attempt is what S3 asks for, and it is the difference between a warehouse that
-- reads "you cannot do that now" and one that discovers it with the branch frozen.
--
-- Only the origin is asserted: the destination's stock does not move and no reservation is
-- taken there, so approving a request towards a frozen branch reserves nothing of it and the
-- receipt is already refused by the same function below.
--
-- The function is replaced whole because 035 is applied and checksummed; the dispatch and
-- receipt arms are kept exactly as they were.
CREATE OR REPLACE FUNCTION admit_transfer_move_when_branches_operating() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'pending' AND NEW.status = 'approved' THEN
        -- The approval reserves the origin's units, so the origin is the branch that has to
        -- be operating for it to happen.
        PERFORM assert_branch_not_frozen(OLD.origin_location_id);
    ELSIF OLD.status = 'approved' AND NEW.status = 'in_transit' THEN
        PERFORM assert_branch_not_frozen(OLD.origin_location_id);
    ELSIF OLD.status = 'in_transit' AND NEW.status = 'received' THEN
        PERFORM assert_branch_not_frozen(OLD.destination_location_id);
    END IF;
    RETURN NEW;
END;
$$;
