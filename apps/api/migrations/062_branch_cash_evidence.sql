-- 062 -- the photographic receipt of a branch expense (S3, S5, S6)
--
-- A `gasto` may carry one photo of the ticket it paid for: the bytes the branch photographed, kept
-- in the movement's own row of the ledger (S3) and published by every read as its type, its size and
-- its SHA-256 (S7 is the reader's half and lives in the store). The photo is immutable for the
-- reason the whole row already is (S5): `protect_branch_cash_movements` of 034 refuses every UPDATE
-- and every DELETE of a row of this ledger, so the receipt inherits that refusal and this migration
-- adds no guard of its own.
--
-- Four nullable columns hold one receipt, all present or all absent:
--
--   evidence_bytes        the file exactly as it arrived, never re-encoded (S5)
--   evidence_content_type the format the server proved by decoding the bytes (S6)
--   evidence_size         the number of bytes, which is the octet_length of the column above
--   evidence_sha256       the digest of exactly those bytes, in lowercase hexadecimal
--
-- The rules of S6 are enforced here and not only in Go: the four columns travel together, only a
-- `gasto` carries them, the size is the real length of the bytes and never zero nor above 8 MB, the
-- content type is one of the two formats the product accepts, and the digest is a SHA-256. A row
-- recorded before this migration keeps its four columns null, and this file rewrites no row: an
-- incorrect photo is corrected the way everything else in this book is, with a compensating
-- movement and a new expense, because a receipt is never replaced (S5).
--
-- Reads of the table: the correction path of `admit_branch_cash_movement` (035, restated by 046,
-- 048, 054 and 060) copied the corrected row whole into a record variable, which from today would
-- drag the bytes of a receipt into every correction of the branch. It is restated below with an
-- explicit column list -- the six columns it reads, statement by statement as 060 wrote it -- so no
-- statement of the live schema reads this table with `*`. The view `branch_cash_ledger` is restated
-- with the three metadata columns appended and never the bytes, so no read of the book can drag
-- them either; the one statement that reads the bytes is the image route of the store, and it names
-- them.

-- The four columns of one receipt (S3). They are nullable on purpose: the receipt is optional on a
-- pay-out (S1) and impossible on every other kind, and every row recorded before this version has
-- none (S5).
ALTER TABLE branch_cash_movements
    ADD COLUMN evidence_bytes bytea,
    ADD COLUMN evidence_content_type text,
    ADD COLUMN evidence_size integer,
    ADD COLUMN evidence_sha256 text;

-- One receipt is four facts that travel together (S1): a row either states the bytes, the type, the
-- size and the digest, or states none of them. A reader can never see a receipt without its size or
-- a type without its bytes, exactly like the motive and its copied label of 061.
ALTER TABLE branch_cash_movements
    ADD CONSTRAINT branch_cash_movements_evidence_shape
    CHECK ((evidence_bytes IS NULL) = (evidence_content_type IS NULL)
       AND (evidence_bytes IS NULL) = (evidence_size IS NULL)
       AND (evidence_bytes IS NULL) = (evidence_sha256 IS NULL));

-- Only the expense of the drawer carries a receipt (S2): the contribution, the collection and the
-- correction answer for the money, not for a ticket, and the transfers a settlement writes are the
-- acta's own facts.
ALTER TABLE branch_cash_movements
    ADD CONSTRAINT branch_cash_movements_evidence_expense
    CHECK (evidence_bytes IS NULL OR kind = 'gasto');

-- The size is a fact of the bytes and not a promise of the caller (S6): it is the real length of
-- what the row stores, it is never zero -- an empty file is not a receipt -- and it stays inside the
-- cap the contract documents, 8 MB.
ALTER TABLE branch_cash_movements
    ADD CONSTRAINT branch_cash_movements_evidence_size
    CHECK (evidence_size IS NULL
       OR (evidence_size = octet_length(evidence_bytes)
           AND evidence_size BETWEEN 1 AND 8388608));

-- The two formats the product accepts (S6). SVG and everything else is refused here as well as in
-- the server, and the type is stored in the spelling the route serves as its `Content-Type`.
ALTER TABLE branch_cash_movements
    ADD CONSTRAINT branch_cash_movements_evidence_type
    CHECK (evidence_content_type IS NULL
       OR evidence_content_type IN ('image/jpeg','image/png'));

-- The digest of exactly the stored bytes, in the one spelling the contract publishes (S6): 32 bytes
-- of lowercase hexadecimal.
ALTER TABLE branch_cash_movements
    ADD CONSTRAINT branch_cash_movements_evidence_sha256
    CHECK (evidence_sha256 IS NULL
       OR evidence_sha256 ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN branch_cash_movements.evidence_bytes IS
    'The receipt of a gasto exactly as the branch uploaded it (S3). Null on every row without one, and never updated or removed: the row itself is immutable (S5).';
COMMENT ON COLUMN branch_cash_movements.evidence_content_type IS
    'The format the server proved by decoding the bytes of the receipt (S6): image/jpeg or image/png, and nothing else.';
COMMENT ON COLUMN branch_cash_movements.evidence_size IS
    'The size of the receipt in bytes: the octet_length of evidence_bytes, never zero and never above 8 MB (S6).';
COMMENT ON COLUMN branch_cash_movements.evidence_sha256 IS
    'The SHA-256 of exactly the bytes the row stores, in lowercase hexadecimal (S6). The bytes published beside it never travel in an answer (S7).';

-- The book of the drawer, restated from 061 with the three metadata columns of the receipt appended
-- and never the bytes (S7). Every column 061 published keeps its name, its order and its type, so a
-- reader of the view cannot tell this migration happened except for the three new columns, and the
-- bytes of a receipt are read by the image route alone.
CREATE OR REPLACE VIEW branch_cash_ledger AS
SELECT movement.id,
       movement.branch_location_id,
       movement.closing_id,
       movement.kind,
       movement.amount,
       movement.description,
       movement.occurred_at,
       movement.created_by_account_id,
       movement.corrects_id,
       CASE WHEN movement.kind = 'correccion' THEN corrected.kind ELSE movement.kind END
           AS effect_kind,
       branch_cash_effective(movement.kind, corrected.kind, movement.amount) AS effective,
       movement.category_id,
       movement.category_label,
       movement.evidence_content_type,
       movement.evidence_size,
       movement.evidence_sha256
  FROM branch_cash_movements movement
  LEFT JOIN branch_cash_movements corrected ON corrected.id = movement.corrects_id;

-- The drawer's admission, restated whole from 060 with one change: the corrected movement of a
-- correction is read column by column instead of copied whole, so a receipt is never carried into a
-- statement that does not read it. Everything of 060 is here statement by statement -- the load of
-- the two funds, the settlement transfer of 035, the founding of a branch, the actor of a movement of
-- the period, the freeze, the four refusals of a correction and the bound of the drawer -- so every
-- code and every message the branch and the warehouse already read is unchanged, and every refusal
-- keeps its precedence.
CREATE OR REPLACE FUNCTION admit_branch_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    actor auth_accounts%ROWTYPE;
    -- The corrected movement, one column at a time: the row of the ledger carries the bytes of a
    -- receipt since 062, and a row variable would copy them into every correction of the branch.
    corrected_branch smallint;
    corrected_kind text;
    corrected_closing bigint;
    corrected_occurred timestamptz;
    corrected_amount numeric(12,2);
    corrected_id bigint;
    used numeric(12,2);
    founding text := nullif(current_setting('luson.branch_founding', true), '');
    load_funds text := nullif(current_setting('luson.branch_funds', true), '');
BEGIN
    SELECT * INTO actor FROM auth_accounts WHERE id=NEW.created_by_account_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LC011', MESSAGE='Cash movement requires a known account';
    END IF;
    -- The load of the funds of a branch that already exists (054, S1-S6): the movement of a till its
    -- own branch cannot sign, because the warehouse states it, and the act that states it is the
    -- proof. See the header of this migration: the marker names the branch and the row runs at the
    -- depth only a trigger reaches, so a client statement with a bare set_config is refused here.
    IF load_funds IS NOT NULL AND NEW.kind = 'aporte' AND NEW.corrects_id IS NULL
       AND NEW.closing_id IS NULL THEN
        IF load_funds <> NEW.branch_location_id::text THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='The load of funds writes no movement of another branch';
        END IF;
        IF pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='A load of funds is written by the act that states it';
        END IF;
        PERFORM assert_load_of_branch_funds(NEW.branch_location_id, NEW.created_by_account_id);
        RETURN NEW;
    END IF;
    IF NEW.closing_id IS NOT NULL THEN
        -- The money of a settlement is the warehouse's: it moves in the till of the branch that
        -- settlement belongs to, and never by an account of the branch.
        IF actor.id <> 1 OR actor.location_id <> 1 THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='Only the warehouse moves the money of a settlement';
        END IF;
        -- A settlement transfer is written once, by the closure itself, while the row still reads
        -- as proposed. Anything else -- in particular appending money to a closed settlement -- is
        -- refused: that history is fixed by an approved correction, never by a new ledger row.
        IF NOT EXISTS (SELECT 1 FROM branch_closings
            WHERE id=NEW.closing_id AND branch_location_id=NEW.branch_location_id
              AND status = 'proposed') THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='A cash movement belongs to a proposed settlement of its own branch';
        END IF;
        IF EXISTS (SELECT 1 FROM branch_cash_movements
            WHERE closing_id=NEW.closing_id AND kind=NEW.kind) THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='A settlement states its transfer once';
        END IF;
        -- Provenance, checked last so the shape of the row is answered first: the row exists
        -- because the closure of this very settlement is writing it, right now, from inside its
        -- own trigger.
        IF current_setting('luson.closing_ledger', true) IS DISTINCT FROM NEW.closing_id::text
           OR pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION USING ERRCODE='LC020',
                MESSAGE='A cash movement of a settlement is written by its closure';
        END IF;
        -- S6: the closure states the money of the acta, and the acta's own checks govern it. The
        -- drawer's bound is about what a branch spends during the period, not about what a
        -- settlement transfers out of it.
        RETURN NEW;
    END IF;
    -- The founding of a branch (S4, S12), the one movement of a till its own branch cannot sign:
    -- the creator is the warehouse administrator and the branch has no account yet. It is
    -- admitted only when the marker names this branch AND the branch's own `locations` row was
    -- written by this transaction, which is what a client with a bare set_config cannot state.
    -- See the header of this migration: the depth of a founding insert is 1, so it cannot be the
    -- proof here, the way it is for a settlement transfer.
    IF NEW.kind = 'aporte' AND NEW.corrects_id IS NULL THEN
        IF founding IS NOT NULL AND founding <> NEW.branch_location_id::text THEN
            RAISE EXCEPTION USING ERRCODE='LC011',
                MESSAGE='The founding of a branch writes no movement of another branch';
        END IF;
        IF founding = NEW.branch_location_id::text THEN
            IF NOT EXISTS (SELECT 1 FROM locations
                WHERE id = NEW.branch_location_id AND xmin = pg_current_xact_id()::xid) THEN
                RAISE EXCEPTION USING ERRCODE='LC011',
                    MESSAGE='The opening contribution of a branch is written by the transaction that creates it';
            END IF;
            PERFORM assert_branch_not_frozen(NEW.branch_location_id);
            RETURN NEW;
        END IF;
    END IF;
    -- A movement of the period states the branch and the actor together: only an account of that
    -- branch writes its own till, and the warehouse has no till of its own to write.
    IF actor.location_id <> NEW.branch_location_id THEN
        RAISE EXCEPTION USING ERRCODE='LC011',
            MESSAGE='Only the branch records its own cash movements';
    END IF;
    PERFORM assert_branch_not_frozen(NEW.branch_location_id);
    IF NEW.kind <> 'correccion' THEN
        -- The one rule of this migration (S1): a movement of the period is admitted only when the
        -- till still holds what it spends.
        PERFORM assert_branch_drawer_holds(NEW.branch_location_id, NEW.kind, NULL, NEW.amount);
        RETURN NEW;
    END IF;
    -- The lock comes first: the sum below decides whether this correction still fits, and two
    -- corrections of the same movement must not read the same total.
    SELECT movement.branch_location_id,
           movement.kind,
           movement.closing_id,
           movement.occurred_at,
           movement.amount,
           movement.id
      INTO corrected_branch, corrected_kind, corrected_closing, corrected_occurred,
           corrected_amount, corrected_id
      FROM branch_cash_movements movement WHERE movement.id=NEW.corrects_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='LC030',
            MESSAGE='A correction names a movement of the ledger';
    END IF;
    IF corrected_branch <> NEW.branch_location_id THEN
        RAISE EXCEPTION USING ERRCODE='LC030',
            MESSAGE='A correction names a movement of its own branch';
    END IF;
    IF corrected_kind = 'correccion' THEN
        RAISE EXCEPTION USING ERRCODE='LC030', MESSAGE='A correction is not corrected';
    END IF;
    IF corrected_closing IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='LC030',
            MESSAGE='The transfer of a settlement is corrected in the settlement';
    END IF;
    -- The windows of closed settlements tile the branch's timeline: a movement inside one of them
    -- is already signed in an acta, and an acta is never recalculated (S7).
    IF EXISTS (SELECT 1 FROM branch_closings closing
        WHERE closing.branch_location_id = corrected_branch
          AND closing.status = 'closed'
          AND corrected_occurred >= closing.period_start
          AND corrected_occurred < closing.cut_at) THEN
        RAISE EXCEPTION USING ERRCODE='LC030',
            MESSAGE='A movement of a settled period is corrected in the settlement';
    END IF;
    SELECT coalesce(sum(amount),0) INTO used FROM branch_cash_movements
        WHERE corrects_id = corrected_id;
    IF used + NEW.amount > corrected_amount THEN
        RAISE EXCEPTION USING ERRCODE='LC031',
            MESSAGE='A correction never exceeds the movement it corrects';
    END IF;
    -- A correction answers the direction it corrects, so correcting an `aporte` takes money out of
    -- the till and obeys the same bound (S1). It answers last, after its own four refusals (S5).
    PERFORM assert_branch_drawer_holds(NEW.branch_location_id, NEW.kind, corrected_kind, NEW.amount);
    RETURN NEW;
END;
$$;
