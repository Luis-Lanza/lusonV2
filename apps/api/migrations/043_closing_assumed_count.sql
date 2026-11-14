-- The count sheet starts aligned with the system (S1, S4): the warehouse opens a
-- settlement and every line already states that what was counted is what the database
-- expects, so the admin only edits the lines that disagree and the difference it writes is
-- still exactly what the closure applies. Today 035 seeds one line per variant with stock
-- and leaves the counted quantity pending (NULL), which is what refuses the proposal
-- (034, LC019) and the closure (035, LC006) until every variant of the branch is typed in.
--
-- Why this is a seeding change and not a new column. S2 rejects any distinction between
-- "counted" and "assumed", so the sheet cannot start empty: an empty cell would be exactly
-- that mark, and nothing could then tell an untouched line from a line touched with the
-- same number. The default therefore lives in the value itself -- the counted quantity is
-- seeded with the expected quantity -- and the row of a variant the admin never opened is
-- indistinguishable from the row of one it agreed with. Say it once, where it matters: the
-- expected quantity is still the snapshot of the cut instant read from the balance, and the
-- counted quantity seeded here is only its starting value.
--
-- Why the pending-line refusals of 034 and 035 are left where they are. 001-042 are applied
-- and their checksums recorded, so no statement of them is rewritten: the predicate
-- counted_quantity IS NULL in 034 (the proposal, LC019) and in 035 (the closure, LC006) is
-- kept as the unreachable safety net it becomes, and the count_pending refusal of the store
-- and of the HTTP surface mirrors it (S3). It is unreachable because no writer can leave a
-- line pending any more: admit_closing_count_line (035) never inserts a NULL, the seeding
-- function below is replaced to state the quantity it seeds, and the backfill at the end of
-- this file seeds the sheets that already exist. Nothing else writes that column.
--
-- The order of this file is the order of the problem: the seeding function is replaced
-- first, so a settlement opened while this version runs is already seeded and the backfill
-- cannot see it; only then are the sheets that predate this version seeded, so the backfill
-- reaches nothing but the state the old seed left behind.
--
-- What guards the backfill, read from every migration that installs a trigger on
-- closing_count_lines. admit_closing_count_line (035) is BEFORE INSERT, so it never sees an
-- update; protect_closing_count_lines (034) refuses DELETE and
-- protect_closing_count_lines_truncate (034) refuses TRUNCATE, and neither is reached by an
-- UPDATE. guard_closing_count_line (034) is BEFORE UPDATE and is the one that applies: it
-- refuses any line whose settlement does not read as open or rejected (LC004), which is why
-- the backfill filters on exactly those two states and never on the plain "not closed" of
-- the freeze predicate. A proposed settlement is not a case it has to handle: the proposal
-- refuses a pending line (LC019) and the same guard refuses every later write of the sheet,
-- so a proposed or a closed settlement never holds a pending line for the backfill to find.
--
-- What fires on branch_closings: nothing. This file never inserts, updates or deletes a
-- settlement, so the opener (admit_branch_closing, 034), the transition guard
-- (admit_branch_closing_transition, 034), the offer (record_branch_closing_offer, 035), the
-- ledger (record_branch_closing_ledger, 035) and the closure (apply_branch_closing_closure,
-- 035) stay silent. The settlement is not reopened, not re-offered, not closed and not
-- unfrozen here, the closure applies no stock because no closure runs, and no cash entry is
-- written: the only column this file writes is closing_count_lines.counted_quantity, and it
-- writes it inside the same state the settlement already had (S6).
--
-- Why the function is replaced instead of edited: 035 is applied and checksummed. It is
-- redefined whole with CREATE OR REPLACE, exactly as 039 redefines the opener of 034 and 037
-- the offer, and the trigger of 035 (seed_closing_count_lines AFTER INSERT on
-- branch_closings) is not recreated: a second trigger on the same event would seed the
-- sheet twice. Everything the function did before is kept statement by statement: the branch
-- is read from NEW.branch_location_id, the expected quantity is balance.existing, and only a
-- variant the branch actually holds (existing > 0) gets a line.
--
-- The one bound worth naming: counted_quantity is checked against 1000000 by 034. A branch
-- holding more than a million units of one variant could not open a settlement after this
-- version, because the seeded quantity would break that check, and the closure could never
-- have restated such a line either -- the counted quantity it applies was already bounded by
-- the same check. The limit is 034's and is not rewritten here; a variant that reached it
-- would be a catalogue error to fix, not a count to clamp, because clamping would make the
-- closure set the stock to an invented number.
--
-- The backfill below inherits that ceiling and can fail because of it: a sheet written before this
-- version that already holds a line above the bound makes this file abort with the same check
-- violation and roll back whole, seed function included. That is the loud half of the same
-- decision -- never a clamped count, and never a half-applied migration.
CREATE OR REPLACE FUNCTION seed_closing_count_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- The count starts aligned: the admin states the differences, never the whole sheet
    -- (S1). The counted quantity is the expected one, and nothing marks it as assumed (S2).
    INSERT INTO closing_count_lines(
        closing_id, variant_id, expected_quantity, counted_quantity)
    SELECT NEW.id, balance.variant_id, balance.existing, balance.existing
    FROM inventory_balances balance
    WHERE balance.location_id = NEW.branch_location_id AND balance.existing > 0;
    RETURN NULL;
END;
$$;

-- The sheets that already exist when this version is applied (S6): a settlement that is
-- still open, or that the branch rejected and the warehouse resumed, gets its pending lines
-- seeded with the expected quantity, so the admin that opens the sheet after the deploy does
-- not have to restate a line it already agrees with. Those two states are exactly the ones
-- guard_closing_count_line (034) admits a write in, and the narrower filter has a reason of
-- its own: a closed settlement is the history its branch signed and none of its lines is
-- touched, and a proposed one is the offer the branch is deciding, whose sheet is frozen
-- until it answers. Neither of them holds a pending line to seed in any case -- proposing
-- refuses one (LC019) -- so asking for the two live states loses nothing.
--
-- The quantity written is the expected quantity already stored on the line, not a fresh read
-- of the balance: the snapshot of the cut instant is the fact of the settlement, and the
-- balance may have moved since (the freeze guards of 035 are what prevent it, and this
-- version does not read the shelf to disagree with a row it is only completing).
UPDATE closing_count_lines line
SET counted_quantity = line.expected_quantity
FROM branch_closings header
WHERE header.id = line.closing_id
  AND header.status IN ('open','rejected')
  AND line.counted_quantity IS NULL;
