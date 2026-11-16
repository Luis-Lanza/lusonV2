-- The purchase writes its own movement of the branch's fund (S5, S6, S7, S8). 044 admitted a
-- purchase against an *envelope* read from the last closed settlement, and it deliberately left
-- one case open: "an unstated envelope is not zero", so a branch whose fund had never been stated
-- could spend money nobody had put there. 048 replaced that envelope with the fund's own ledger
-- and stated the rule once and for all -- the balance of a fund is `sum(effective)` of
-- `purchase_fund_ledger`, and a movement that would leave it below zero is refused with the
-- balance and the requested amount (LF003). What was missing is the other half: the purchase did
-- not write a movement at all, so the ledger of the fund never saw it and the tope measured a
-- settlement instead of the book.
--
-- This version closes that half, and it does it where the money is spent, in the database:
--
--   1. `purchase_fund_writes`, the link between one document and the one movement it wrote. A
--      purchase has at most one movement of the fund and a movement belongs to at most one
--      document, and both are primary facts of an append-only book, so the table is sealed the
--      way the two books it joins are: no update, no delete, no truncate;
--   2. `write_purchase_fund_movement()`, the rule that writes it, fired by a *deferred* trigger on
--      `purchases`. A purchase of the branch paid in cash appends a `compra` for that cash. A
--      counter-document appends the opposite: a `correccion` that answers the `compra` of its
--      original for the same amount, so the money comes back. A document that pays no cash writes
--      nothing at all -- a zero is the empty sum of a book, not a movement to explain;
--   3. `admit_purchase_against_fund()` replaced. What is left of 044's rule is the one thing that
--      is the document's own: a branch purchase is paid in cash, so a document that pays anything
--      by transfer is refused (LP006) before any balance is read. The tope is not restated here.
--
-- Why the movement is written by a trigger and not by the store. The fund's ledger must not be
-- bypassable by a client: a purchase that does not write its movement would leave a document that
-- never charged the fund, and a client -- the screen, a script, a maintenance session -- can
-- always skip a write the application remembers to do. As a trigger it cannot be skipped, and it
-- runs inside the very transaction of the document: la compra y su movimiento nacen juntos, o no
-- nace nada.
--
-- Why the trigger is deferred. The description of a fund movement names the material the document
-- bought (S5: a book read as history has to say what the money was for), and the lines of a
-- purchase are written *after* its header: at the moment the row is inserted the document has no
-- lines yet. The write is therefore a CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED, so it
-- fires at the commit of the document -- the same instant 032's `require_purchase_document` judges
-- a complete document -- when both kinds of line are in place. It is still the transaction of the
-- purchase, so a refused purchase takes its movement with it.
--
-- Why the tope is not decided here. S7 asks for exactly one arithmetic: the balance of the fund is
-- `sum(effective)` of `purchase_fund_ledger` and it is computed nowhere else. The admission 048
-- installed on the ledger already reads it, under the lock of the branch (340251, the key of the
-- closure and of 044), and refuses what would take the fund below zero naming the balance and the
-- requested amount. A second sum here -- of what the settlement left minus what the branch spent,
-- or of the view again -- would be a second arithmetic, and two arithmetics is how a book stops
-- closing. The movement this version writes is admitted by that admission like any other row of
-- the book: the actor belongs to the branch, the branch is not frozen, and the fund never goes
-- negative. So a branch whose fund was never stated is not an exception any more (S7): its book is
-- empty, its balance is the empty sum, and its purchase is refused with `0.00 in it`.
--
-- Writing: this file adds one table and its two immutability guards, replaces one function of 044
-- (its trigger keeps calling the name it already has) and installs one function and one deferred
-- trigger. No row of either ledger is written, no settlement is touched, and 048 -- its table, its
-- view and its admission -- is used exactly as it is.

-- The link between a document and the movement of the fund it wrote. It is its own table and not a
-- column of `branch_fund_movements` on purpose: 048's ledger is the book every other unit of this
-- vertical reads, its shape is what they were written against, and the link is a fact of the
-- purchase -- which document paid this movement -- not a fact of the money. The primary key says a
-- document writes one movement, the unique key says a movement is written by one document.
CREATE TABLE purchase_fund_writes (
    purchase_id bigint PRIMARY KEY REFERENCES purchases(id),
    movement_id bigint NOT NULL UNIQUE REFERENCES branch_fund_movements(id)
);

-- Sealed like the books it joins (034, 046, 048): a link is never rewritten, deleted or
-- truncated, because the history it states is the history the money was read as.
CREATE TRIGGER protect_purchase_fund_writes BEFORE UPDATE OR DELETE ON purchase_fund_writes
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_purchase_fund_writes_truncate BEFORE TRUNCATE ON purchase_fund_writes
EXECUTE FUNCTION protect_pending_request();

-- The rule of 044, replaced: a branch purchase is paid in cash from the purchase fund. The tope
-- that 044 read from the last closed settlement is gone with the envelope it came from -- and with
-- it the exception of S7, "an unstated envelope is not zero" -- because the balance of a fund is
-- now the signed sum of a book, and a book nobody wrote a row in holds zero.
--
-- A counter-document is not judged here: it answers a document that already charged the fund, and
-- its own movement returns the money. An original written before 048 could have been paid by
-- transfer, so the mirror of such a purchase is admitted exactly as it was before this version.
CREATE OR REPLACE FUNCTION admit_purchase_against_fund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.reverses_purchase_id IS NOT NULL THEN
        RETURN NEW;
    END IF;
    -- S2: the fund is cash, so no part of an original purchase is paid by transfer. The refusal is
    -- the document's own and it is raised before any balance is read: a document that is not paid
    -- in cash from the fund is refused whatever the fund holds.
    IF NEW.paid_transfer <> 0 THEN
        RAISE EXCEPTION USING ERRCODE='LP006',
            MESSAGE='A branch purchase is paid in cash from the purchase fund';
    END IF;
    RETURN NEW;
END;
$$;

-- The purchase writes its movement of the fund. Two documents and one rule: an original paid in
-- cash appends a `compra` of that cash, and a counter-document appends the `correccion` that
-- answers the `compra` of the document it reverses, for the same amount -- the money comes back.
--
-- It writes the facts and decides nothing: the admission of 048 decides whether the movement is
-- admitted (the actor of the branch, the branch not frozen, the fund never negative), and it is
-- the only place that reads the balance, from `purchase_fund_ledger`.
CREATE FUNCTION write_purchase_fund_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    -- What the document bought, in the words the branch reads it in: the materials it weighed and
    -- the models it took, so a row of the fund's book says what its money paid for.
    bought text;
    original branch_fund_movements%ROWTYPE;
    description text;
    movement_id bigint;
BEGIN
    SELECT string_agg(item, ', ' ORDER BY item) INTO bought FROM (
        SELECT material.name AS item
          FROM purchase_scrap_lines line
          JOIN materials material ON material.id = line.material_id
         WHERE line.purchase_id = NEW.id
        UNION
        SELECT line.model FROM purchase_used_lines line WHERE line.purchase_id = NEW.id
    ) items;
    IF NEW.reverses_purchase_id IS NOT NULL THEN
        -- The `compra` of the document this one answers. A document that paid no cash wrote no
        -- movement, so it has nothing to answer and its counter-document writes nothing either:
        -- the money it would return never left the fund.
        SELECT movement.* INTO original
          FROM purchase_fund_writes writes
          JOIN branch_fund_movements movement ON movement.id = writes.movement_id
         WHERE writes.purchase_id = NEW.reverses_purchase_id
           AND movement.kind = 'compra';
        IF NOT FOUND THEN
            RETURN NULL;
        END IF;
        description := 'Corrección ' || NEW.id || ' de la compra ' || NEW.reverses_purchase_id
            || ': ' || coalesce(bought,'sin líneas');
        INSERT INTO branch_fund_movements(branch_location_id,kind,amount,description,
            created_by_account_id,corrects_id)
        VALUES(NEW.location_id,'correccion',original.amount,left(description,500),
            NEW.created_by_account_id,original.id)
        RETURNING id INTO movement_id;
        INSERT INTO purchase_fund_writes(purchase_id,movement_id) VALUES(NEW.id,movement_id);
        RETURN NULL;
    END IF;
    -- A document that pays no cash spends nothing of the fund, and a movement of zero is not a
    -- fact of a book: nothing is written, exactly as the founding of a branch with 0,00 writes no
    -- opening (048).
    IF NEW.paid_cash <= 0 THEN
        RETURN NULL;
    END IF;
    description := 'Compra ' || NEW.id || ': ' || coalesce(bought,'sin líneas');
    INSERT INTO branch_fund_movements(branch_location_id,kind,amount,description,
        created_by_account_id)
    VALUES(NEW.location_id,'compra',NEW.paid_cash,left(description,500),
        NEW.created_by_account_id)
    RETURNING id INTO movement_id;
    INSERT INTO purchase_fund_writes(purchase_id,movement_id) VALUES(NEW.id,movement_id);
    RETURN NULL;
END;
$$;
-- Deferred, because the material of a purchase is written after its header and the book has to
-- name it; and named so it fires before 032's `require_purchase_document`, which is the deferred
-- check of the same instant.
CREATE CONSTRAINT TRIGGER purchase_writes_the_fund_ledger AFTER INSERT ON purchases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION write_purchase_fund_movement();

COMMENT ON TABLE purchase_fund_writes IS
    'The movement of the branch fund each purchase document wrote. One document, one movement: the primary key states it, the unique key states that a movement belongs to one document, and the rows are append only.';
COMMENT ON FUNCTION write_purchase_fund_movement() IS
    'Writes the movement of the fund a purchase states (a compra of the cash it paid, or the correccion that answers the compra of the document it reverses), described with the document and the material it bought and signed by the purchase''s own account. The tope is the ledger''s admission (LF003), which reads sum(effective) of purchase_fund_ledger and nothing else.';
COMMENT ON FUNCTION admit_purchase_against_fund() IS
    'A branch purchase is paid in cash from the purchase fund (LP006). The balance of the fund is read by the admission of branch_fund_movements, from purchase_fund_ledger, and a branch whose fund was never stated has zero.';
