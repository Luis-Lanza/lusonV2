-- S10: a transfer in transit has no cancellation path and receipt is its only
-- exit, so a physically received variant that was never dispatched would strand
-- it. 019 forbids the zero-expected receipt line that event needs, so the
-- administrative recovery records it here instead, as audit-only evidence: no
-- row of this table ever credits, debits or adjusts an inventory balance.
--
-- Deliberately separate from transfer_receipt_exceptions, whose foreign key to
-- transfer_receipt_lines would require a receipt line for a variant that has no
-- dispatched quantity. The request's own received_at stays server derived; the
-- observed arrival time supplied by the operator is evidence recorded here.
CREATE TABLE IF NOT EXISTS transfer_recovery_events (
    request_id bigint NOT NULL REFERENCES transfer_requests(id),
    variant_id integer NOT NULL REFERENCES catalog_variants(id),
    quantity bigint NOT NULL CHECK (quantity > 0),
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
    operator text NOT NULL CHECK (length(btrim(operator)) BETWEEN 1 AND 200),
    received_at timestamptz NOT NULL,
    PRIMARY KEY (request_id, variant_id)
);

-- Append-only evidence: no later operation may rewrite or remove it.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'transfer_recovery_events'::regclass
        AND tgname LIKE 'protect_transfer_recovery_events%') THEN
        CREATE TRIGGER protect_transfer_recovery_events BEFORE UPDATE OR DELETE ON transfer_recovery_events
        FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
        CREATE TRIGGER protect_transfer_recovery_events_truncate BEFORE TRUNCATE ON transfer_recovery_events
        EXECUTE FUNCTION protect_pending_request();
    END IF;
END $$;
