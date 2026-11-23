-- The commission of a settlement is paid on the batteries it sold and on nothing else: "la
-- comision debe ser solamente de la venta de baterias, la venta de 'otros productos' como agua
-- acidulada no cuentan para la comision" (S1). Since 034 the offer computed the rate over every
-- sold line of the period, so a bottle of acidulated water paid a commission nobody sold it with.
-- This version gives the base its own column and its own sum, and the commission is the single
-- rounding of 035 over that sum (S2, S3, S5).
--
-- 001-063 are already applied and their checksums recorded, so every one of those files is left
-- exactly as it is. The offer the branch is asked to accept is 037's record_branch_closing_offer,
-- redefined whole at the end of this file because a checksummed migration cannot be edited in place
-- and CREATE OR REPLACE is the schema's own way to install a new version of a function; its trigger
-- is untouched, and so are the period totals it already computed, its frozen rate and the
-- immutability of the offer.
--
-- Backfill: none, on purpose (S8). commission_base is added nullable, with no default and no
-- UPDATE of any row: a settlement recorded before this rule keeps the commission it settled with and
-- states no base at all, which every reader publishes as JSON null instead of inventing a zero it
-- never multiplied. Recomputing a historical commission would rewrite an acta the branch already
-- signed, and the rule below therefore only governs what is computed from now on (L2).
--
-- What does not change with the base: `sales_total` -- "Plata del período" -- keeps counting every
-- sale of the window, batteries and other products alike, and so do the cash, card, transfer and QR
-- totals of the same sales. The commission is reported beside them and is a term of no cash
-- identity; the window of the metrics card keeps cross-checking its own money against the sale
-- total, which is why that sum is left exactly as 037 wrote it (S4).

-- 1. The base the settlement multiplied, nullable and with no default: a settlement proposed from
-- now on records the battery sales of its period here, and one recorded before this rule states no
-- base at all (S6, S8).
-- The check is the sibling money columns' own (034): a base is an amount the branch sold, never a
-- signed reading. It cannot fire today -- a sale line has a positive subtotal (025) -- and it is here
-- so the column refuses what every reader would refuse anyway.
ALTER TABLE branch_closings ADD COLUMN commission_base numeric(12,2)
    CHECK (commission_base >= 0);

-- 2. The offer computes the commission on the batteries of the period (S2, S3, S5). This is 037's
-- record_branch_closing_offer, redefined whole: the state machine, the frozen rate, the single
-- rounding and the immutability of the offer are unchanged, and the only difference is the base the
-- commission is computed on. The period total keeps its own unfiltered sum, so the acta and the
-- card still state what the branch sold and not only what it earned.
--
-- It still runs after admit_branch_closing_transition (034), which freezes the rate on this same
-- row, and the trigger that calls it is untouched: only the function body is replaced.
CREATE OR REPLACE FUNCTION record_branch_closing_offer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    sold numeric(12,2);
    commission_sold numeric(12,2);
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
    -- The commission base is the battery lines of that same window and of that same period: the
    -- catalogue kind of the line decides, joined through the variant the line points at, because a
    -- bottle of acidulated water is sold, counted and paid like a battery and earns no commission
    -- (S1, S2). Every other reading of the period keeps reading every line.
    SELECT coalesce(sum(line.subtotal),0) INTO commission_sold
    FROM sale_lines line
    JOIN sales sale ON sale.id = line.sale_id
    JOIN catalog_variants variant ON variant.id = line.variant_id
    JOIN catalog_entries entry ON entry.id = variant.catalog_entry_id
    WHERE sale.branch_location_id = NEW.branch_location_id
      AND sale.created_at >= NEW.period_start
      AND sale.created_at < NEW.cut_at
      AND entry.kind = 'battery';
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
    -- The base is recorded and the commission is the one rounding of the period over it (S5). The
    -- rounding is 035's own: numeric round() takes a half cent away from zero, so exactly half a
    -- cent goes up (S3).
    NEW.commission_base := commission_sold;
    NEW.commission_amount := round(commission_sold * NEW.commission_rate_percent / 100, 2);
    RETURN NEW;
END;
$$;

-- 3. The base is frozen with the offer it produced. 044 already refuses a rewrite of
-- `commission_amount` once the settlement left `proposed`; the number it multiplied has to be just
-- as immovable, or an acta could keep a commission whose base says something else. This guard is a
-- trigger of its own and not a body of 044's `admit_branch_closing_transition`, because that function
-- carries the whole transition table and this rule is not about transitions: it states exactly 044's
-- condition for the offer -- anything but a proposal keeps it -- and nothing else (S5, S8).
CREATE OR REPLACE FUNCTION keep_branch_closing_commission_base() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'proposed'
       AND NEW.commission_base IS DISTINCT FROM OLD.commission_base THEN
        RAISE EXCEPTION USING ERRCODE='LC005',
            MESSAGE='The offer of a settlement is recorded when it is proposed';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS keep_branch_closing_commission_base ON branch_closings;
CREATE TRIGGER keep_branch_closing_commission_base
BEFORE UPDATE ON branch_closings
FOR EACH ROW EXECUTE FUNCTION keep_branch_closing_commission_base();
