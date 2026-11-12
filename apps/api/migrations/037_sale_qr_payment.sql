-- QR as a fourth payment of a sale: "el dinero que se utilizo en venta por Qr claramente
-- debe estar senialado porque ese dinero no estara en caja fisica" (S13). 027 gave a sale
-- one amount per admitted method -- cash, card, transfer -- derived the payment label from
-- those amounts and made the three close against the total exactly. QR is money the branch
-- collected and never holds in its drawer, so it is the fourth amount: a column of its own,
-- a label of its own and one more side of the same exact sum.
--
-- 001-036 are already applied and their checksums recorded, so every one of those files is
-- left exactly as it is. This migration therefore changes the sale header only: no table,
-- line, unit, price, guard or admission function of an earlier version is rewritten or
-- dropped. The one function of 035 that has to read the new column -- the offer the branch
-- is asked to accept -- is redefined at the end of this file, whole and with the same body,
-- because a checksummed migration cannot be edited in place and CREATE OR REPLACE is the
-- schema's own way to install a new version of a function.
--
-- Backfill: qr_amount is added NOT NULL DEFAULT 0, so every sale already issued keeps every
-- amount it had and gains the honest zero of a method that was never collected -- nothing
-- was ever paid by QR before this version, and the default is stored without rewriting a
-- row. The label column is then rebuilt from the four amounts, and no existing sale is
-- reclassified: the new expression reproduces the 027 one exactly for a row whose
-- qr_amount is 0, because the 'mixed' arm still counts the same three positive amounts and
-- the single-method arms still name cash, then card, then transfer. A sale that declared
-- 'transfer' (the last arm of 027) now reaches 'transfer' one arm earlier and stays
-- 'transfer'; no historical sale becomes 'qr'. That is the whole backfill of the label: the
-- derived value is recomputed from the amounts the sale already had, and this migration
-- never runs an UPDATE of an issued sale, so the immutability guard of 025 is never
-- disarmed either.

-- 1. The fourth amount. Same type, same default and the same honest zero as the other
-- three, so a sale that never used QR carries a recorded zero instead of a missing value.
ALTER TABLE sales ADD COLUMN qr_amount numeric(12,2) NOT NULL DEFAULT 0;

-- 2. The label is rebuilt over four amounts: 'mixed' when more than one method paid with,
-- otherwise the single method that paid, QR included. A client can read it, filter by it
-- and print it, but never write it.
ALTER TABLE sales DROP COLUMN payment_method;
ALTER TABLE sales ADD COLUMN payment_method text GENERATED ALWAYS AS (
    CASE
        WHEN (cash_amount > 0)::int + (card_amount > 0)::int + (transfer_amount > 0)::int + (qr_amount > 0)::int > 1 THEN 'mixed'
        WHEN cash_amount > 0 THEN 'cash'
        WHEN card_amount > 0 THEN 'card'
        WHEN transfer_amount > 0 THEN 'transfer'
        ELSE 'qr'
    END) STORED;

-- 3. The settlement rules, restated over four amounts: no method holds a negative or NaN
-- amount, at least one method actually paid, and the four amounts close against the total
-- exactly, so a document can never be short or leave change behind. The two constraints of
-- 027 are dropped and recreated because their expression is the rule itself; the bound of
-- the new amount is added beside the other three.
ALTER TABLE sales ADD CONSTRAINT sales_qr_amount_bounded
CHECK (qr_amount >= 0 AND qr_amount <> 'NaN'::numeric);
ALTER TABLE sales DROP CONSTRAINT sales_payments_nonzero;
ALTER TABLE sales ADD CONSTRAINT sales_payments_nonzero
CHECK (cash_amount > 0 OR card_amount > 0 OR transfer_amount > 0 OR qr_amount > 0);
ALTER TABLE sales DROP CONSTRAINT sales_payments_total;
ALTER TABLE sales ADD CONSTRAINT sales_payments_total
CHECK (cash_amount + card_amount + transfer_amount + qr_amount = total);

-- 4. The offer of the settlement reports the fourth method on its own (S13). This is 035's
-- record_branch_closing_offer, redefined whole because 035 is applied and checksummed: the
-- period totals, the frozen rate, the single rounding and the immutability of the offer are
-- unchanged, and the only difference is that qr_total is the QR sum of the same window and
-- the same sales instead of the hardcoded zero of the version that had no fourth method.
--
-- It still runs after admit_branch_closing_transition (034), which freezes the rate on this
-- same row, and the trigger that calls it is untouched: only the function body is replaced.
CREATE OR REPLACE FUNCTION record_branch_closing_offer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    sold numeric(12,2);
    payments record;
BEGIN
    IF NEW.status <> 'proposed' OR OLD.status = 'proposed' THEN
        RETURN NEW;
    END IF;
    IF NEW.commission_rate_percent IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='LC003',
            MESSAGE='The branch has no commission rate configured';
    END IF;
    SELECT coalesce(sum(line.subtotal),0) INTO sold
    FROM sale_lines line
    JOIN sales sale ON sale.id = line.sale_id
    WHERE sale.branch_location_id = NEW.branch_location_id
      AND sale.created_at >= NEW.period_start
      AND sale.created_at < NEW.cut_at;
    SELECT coalesce(sum(sale.cash_amount),0) AS cash,
           coalesce(sum(sale.card_amount),0) AS card,
           coalesce(sum(sale.transfer_amount),0) AS transfer,
           coalesce(sum(sale.qr_amount),0) AS qr
    INTO payments
    FROM sales sale
    WHERE sale.branch_location_id = NEW.branch_location_id
      AND sale.created_at >= NEW.period_start
      AND sale.created_at < NEW.cut_at;
    NEW.sales_total := sold;
    NEW.cash_sales := payments.cash;
    NEW.card_total := payments.card;
    NEW.transfer_total := payments.transfer;
    -- The fourth method is reported, never added to the cash: the drawer only holds what
    -- was collected in cash (S13).
    NEW.qr_total := payments.qr;
    -- One rounding, on the total of the period: numeric round() takes a half cent away
    -- from zero, so exactly half a cent goes up (S20).
    NEW.commission_amount := round(sold * NEW.commission_rate_percent / 100, 2);
    RETURN NEW;
END;
$$;
