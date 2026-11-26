-- 075_stock_adjustment_actor_location.sql
--
-- The branch corrects its own counted stock (S36, S36.1). Until this version the adjustment was
-- the warehouse's alone: 022 refused every other location with LS005 and the store pinned
-- location 1 in the document and in every read. A real difference on a branch shelf then had no
-- exit at all -- the only way to fix it was to fake a transfer or a warehouse adjustment, which
-- states a journey that never happened. This version generalizes that one document instead of
-- opening a second act, so no second path writes the same balance and no rule is written twice.
--
-- What moves and what stays. 022's blind-count half is untouched: `apply_stock_adjustment_line`
-- still takes the expected snapshot from the locked balance row, still applies the difference
-- immediately, still refuses an uncovered decrease, and the counter-entry rules (LS002, LS003,
-- LS006, LS007) are exactly 022's and 023's. Only the admission of the header changes, and it
-- changes forward:
--
--   * the location stops being the warehouse and becomes integrity. LS005 keeps its number and
--     stops meaning "not the Almacén": it now answers "this installation has no such location",
--     so a location the schema cannot honour is still refused by admission and never reaches the
--     foreign key. The who is no longer decided here: the authority moved to the server, where an
--     account adjusts only its own location, and the store asks the session instead of a constant;
--   * the same-location rule of a reversal stays exactly as 022 wrote it (LS006): a counter-entry
--     is a document of its original's location, so a branch reverses its own document and a
--     reversal that names another location is refused whole.
--
-- The guard 035 deliberately omitted, connected here (S36.2). 035 wired `assert_branch_not_frozen`
-- into every branch-facing document and left `stock_entries` and `stock_adjustments` out, with this
-- reason: "021 refuses any location other than 1 (LS005) and 022 reuses the same rule, so a branch
-- can never be the location of a stock ingress or of an adjustment: a guard here could never fire."
-- That premise dies with this version. With a settlement open, a branch that could adjust its own
-- stock would move it outside the cut that is already counted: the count sheet photographed at the
-- open would no longer describe the shelf, and the closure would either resurrect the difference it
-- applied or refuse to close at all (LC018) over a movement this very schema allowed. In the words
-- of the domain: the branch is being settled (its rendición de cuentas is live) and the cut it was
-- asked to count would stop being the truth of that instant. So the adjustment is branch-facing
-- now, and it consults the freeze like a sale, a purchase or a transfer receipt does:
-- `assert_branch_not_frozen(NEW.location_id)`, the predicate's own LC001 and no second copy of the
-- message, on a BEFORE INSERT trigger named to fire before `admit_stock_adjustment_header`.
-- `stock_entries` keeps 035's exemption: it is still the warehouse's, so that premise is still true.
--
-- 035 cannot carry this correction itself. It is applied on every tracked database and its
-- checksum is recorded, so editing it would make the runner refuse to start (S36.2 reads "the
-- comment that justified its absence is rewritten": that rewrite is this header, in the version
-- that makes it false, because a historical version is immutable and checksummed: its bytes are
-- the version that was applied. Nothing of 035 is redefined here either: `assert_branch_not_frozen` and
-- `branch_closure_blocker` keep exactly one owner, and this migration only calls them.
--
-- What this version does not do: it adds no table, no column, no index and no row; it does not
-- rewrite `stock_entries`, the balance application, the counter-entry completeness guard or the
-- immutability of the two tables; and it maps no new public code to LS005, which the store already
-- publishes as 400 invalid_request.

-- 022's admission, restated whole because the guard that decides the location is the one that
-- changes. The location must be one this installation has; a reversal target must be an original
-- document of the same location and never a counter-entry itself.
CREATE OR REPLACE FUNCTION admit_stock_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target stock_adjustments%ROWTYPE;
BEGIN
    -- Integrity, not authority: every location of this installation counts its own stock, and the
    -- server is what keeps the session to its own location.
    IF NOT EXISTS (SELECT 1 FROM locations WHERE id=NEW.location_id) THEN
        RAISE EXCEPTION USING ERRCODE='LS005', MESSAGE='Stock adjustment requires an existing location';
    END IF;
    IF NEW.reverses_adjustment_id IS NOT NULL THEN
        SELECT * INTO target FROM stock_adjustments WHERE id=NEW.reverses_adjustment_id;
        IF NOT FOUND OR target.location_id IS DISTINCT FROM NEW.location_id
           OR target.reverses_adjustment_id IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='LS006', MESSAGE='Reversal target must be an original adjustment of the same location';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- The freeze, wired the way 035 wires a sale, a purchase and a transfer receipt: the predicate's
-- own refusal, before the document's own admission runs.
CREATE FUNCTION admit_stock_adjustment_when_branch_operating() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM assert_branch_not_frozen(NEW.location_id);
    RETURN NEW;
END;
$$;
-- PostgreSQL fires the BEFORE ROW triggers of one table in name order: this one sorts before
-- admit_stock_adjustment_header, so the frozen branch is refused with LC001 before the location and
-- the reversal target of the document are judged.
CREATE TRIGGER admit_frozen_branch_stock_adjustment BEFORE INSERT ON stock_adjustments
FOR EACH ROW EXECUTE FUNCTION admit_stock_adjustment_when_branch_operating();
