-- A receipt line always describes a dispatched variant. The undispatched
-- ("unexpected") variant an earlier receipt could store is a schema violation
-- now, not just an API refusal, so no writer can fabricate one.
--
-- Production was not reachable when this migration was authored, so its shape is
-- decided at apply time (S3): a clean table gets a validated constraint, while a
-- table that still holds historical zero-quantity rows gets NOT VALID. NOT VALID
-- forbids every new zero row and leaves the existing history readable for the
-- unified snapshot, so historical data never aborts a deploy and is never deleted.
DO $$
DECLARE
    legacy_zero_rows boolean;
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'transfer_receipt_lines'::regclass
          AND conname = 'transfer_receipt_lines_expected_positive'
    ) THEN
        RETURN;
    END IF;
    SELECT EXISTS (
        SELECT 1 FROM transfer_receipt_lines WHERE expected_quantity = 0
    ) INTO legacy_zero_rows;
    IF legacy_zero_rows THEN
        ALTER TABLE transfer_receipt_lines
            ADD CONSTRAINT transfer_receipt_lines_expected_positive CHECK (expected_quantity > 0) NOT VALID;
    ELSE
        ALTER TABLE transfer_receipt_lines
            ADD CONSTRAINT transfer_receipt_lines_expected_positive CHECK (expected_quantity > 0);
    END IF;
END $$;
