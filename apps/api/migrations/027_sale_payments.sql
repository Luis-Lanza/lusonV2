-- Mixed payment: "como puedo hacer si se paga un monto en transferencia y otro monto en
-- efectivo?". One sale now records how much was paid with each admitted method -- cash,
-- card, transfer -- so a single document can be settled partly in cash and partly by
-- transfer. The payment label stops being something the counter chooses: it is derived
-- by the database from the amounts, so a sale can never declare a label its own money
-- contradicts.
--
-- 024, 025 and 026 are already applied and keep their recorded checksums, so this
-- migration only adds to the sale header: no table, column or guard of the price list or
-- of the sale lines is rewritten. Money stays numeric(12,2) and never becomes a binary
-- float, and the sum is compared by the database in exact decimal arithmetic.
--
-- Step 2 rewrites every sale that was already issued, and 025 installed the immutability
-- guard protect_sales (protect_pending_request) to reject any UPDATE of a sale. The
-- backfill therefore disables that one trigger, writes the amounts, and enables it again
-- immediately, all inside this migration's own transaction: the only window in which an
-- issued sale can be rewritten is this run, and the guard is installed again before the
-- transaction commits. Existing sales are never deleted or renumbered.

-- 1. One amount per admitted method, so one sale can be settled with more than one. The
-- default is the honest zero: an existing sale has not been apportioned yet, and the
-- backfill below fills it from the label it was paid with.
ALTER TABLE sales ADD COLUMN cash_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN card_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN transfer_amount numeric(12,2) NOT NULL DEFAULT 0;

-- 2. Backfill: the whole total of every issued sale goes to the method it declared, so no
-- stored sale changes its amount of money, only the shape that holds it.
ALTER TABLE sales DISABLE TRIGGER protect_sales;
UPDATE sales SET
    cash_amount = CASE WHEN payment_method='cash' THEN total ELSE 0 END,
    card_amount = CASE WHEN payment_method='card' THEN total ELSE 0 END,
    transfer_amount = CASE WHEN payment_method='transfer' THEN total ELSE 0 END;
ALTER TABLE sales ENABLE TRIGGER protect_sales;

-- 3. The label stops being an input of the document.
ALTER TABLE sales DROP COLUMN payment_method;

-- 4. The label comes back derived and read-only: 'mixed' when more than one method was
-- paid with, otherwise the single method that paid. A client can read it, filter by it
-- and print it, but never write it.
ALTER TABLE sales ADD COLUMN payment_method text GENERATED ALWAYS AS (
    CASE
        WHEN (cash_amount > 0)::int + (card_amount > 0)::int + (transfer_amount > 0)::int > 1 THEN 'mixed'
        WHEN cash_amount > 0 THEN 'cash'
        WHEN card_amount > 0 THEN 'card'
        ELSE 'transfer'
    END) STORED;

-- 5. The settlement is the database's own rule: no method holds a negative or NaN amount,
-- at least one method actually paid, and the three amounts close against the total
-- exactly, so a document can never be short or leave change behind.
ALTER TABLE sales ADD CONSTRAINT sales_cash_amount_bounded
CHECK (cash_amount >= 0 AND cash_amount <> 'NaN'::numeric);
ALTER TABLE sales ADD CONSTRAINT sales_card_amount_bounded
CHECK (card_amount >= 0 AND card_amount <> 'NaN'::numeric);
ALTER TABLE sales ADD CONSTRAINT sales_transfer_amount_bounded
CHECK (transfer_amount >= 0 AND transfer_amount <> 'NaN'::numeric);
ALTER TABLE sales ADD CONSTRAINT sales_payments_nonzero
CHECK (cash_amount > 0 OR card_amount > 0 OR transfer_amount > 0);
ALTER TABLE sales ADD CONSTRAINT sales_payments_total
CHECK (cash_amount + card_amount + transfer_amount = total);
