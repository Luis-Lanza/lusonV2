-- Pending is an immutable request, not a reservation or stock movement.
CREATE SEQUENCE transfer_requests_id_seq AS bigint START WITH 1 NO CYCLE;
CREATE TABLE transfer_requests (
    id bigint PRIMARY KEY DEFAULT nextval('transfer_requests_id_seq') CHECK (id > 0),
    creator_location_id smallint NOT NULL REFERENCES auth_accounts(location_id) CHECK (creator_location_id IN (2,3)),
    kind text NOT NULL CHECK (kind IN ('request_stock','send_to_warehouse')),
    origin_location_id smallint NOT NULL REFERENCES locations(id),
    destination_location_id smallint NOT NULL REFERENCES locations(id),
    approver_location_id smallint NOT NULL REFERENCES locations(id),
    status text NOT NULL DEFAULT 'pending' CHECK (status = 'pending'),
    retry_key text COLLATE "C" NOT NULL CHECK (retry_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- An item may be inserted only in the transaction that created its header.
    creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
    UNIQUE (creator_location_id,retry_key),
    CHECK (origin_location_id <> destination_location_id),
    CHECK (
        (kind = 'request_stock' AND origin_location_id IN (1,2,3)
         AND destination_location_id = creator_location_id AND approver_location_id = origin_location_id)
        OR
        (kind = 'send_to_warehouse' AND origin_location_id = creator_location_id
         AND destination_location_id = 1 AND approver_location_id = 1)
    )
);
ALTER SEQUENCE transfer_requests_id_seq OWNED BY transfer_requests.id;
CREATE TABLE transfer_request_items (
    request_id bigint NOT NULL REFERENCES transfer_requests(id),
    variant_id integer NOT NULL REFERENCES catalog_variants(id),
    quantity bigint NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (request_id,variant_id)
);

-- Deferred completeness catches orphan headers even from direct SQL. The Go
-- transaction still validates availability before inserting any header/item.
CREATE FUNCTION check_pending_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_count integer;
BEGIN
    SELECT count(*) INTO item_count FROM transfer_request_items WHERE request_id = NEW.id;
    IF item_count < 1 OR item_count > 190 THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Pending request must have 1 to 190 items';
    END IF;
    RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER check_transfer_request_complete AFTER INSERT ON transfer_requests
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_pending_request_complete();

CREATE FUNCTION protect_pending_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Pending requests are immutable';
END;
$$;
CREATE TRIGGER protect_transfer_requests BEFORE UPDATE OR DELETE ON transfer_requests
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_transfer_requests_truncate BEFORE TRUNCATE ON transfer_requests
EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_transfer_request_items BEFORE UPDATE OR DELETE ON transfer_request_items
FOR EACH ROW EXECUTE FUNCTION protect_pending_request();
CREATE TRIGGER protect_transfer_request_items_truncate BEFORE TRUNCATE ON transfer_request_items
EXECUTE FUNCTION protect_pending_request();

CREATE FUNCTION check_pending_item_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM transfer_requests WHERE id = NEW.request_id
                   AND creation_xid = pg_current_xact_id()) THEN
        RAISE EXCEPTION 'Pending items must be created with their request';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER check_transfer_request_item_creation BEFORE INSERT ON transfer_request_items
FOR EACH ROW EXECUTE FUNCTION check_pending_item_creation();
