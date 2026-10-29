-- Account identity is independent of location. Historical creators stay locations.
ALTER TABLE auth_sessions DROP CONSTRAINT auth_sessions_account_id_fkey;
ALTER TABLE transfer_requests DROP CONSTRAINT transfer_requests_creator_location_id_fkey;
ALTER TABLE transfer_requests ADD FOREIGN KEY (creator_location_id) REFERENCES locations(id);
DROP TRIGGER protect_auth_accounts ON auth_accounts;
ALTER TABLE auth_accounts ADD COLUMN id bigint;
UPDATE auth_accounts SET id = location_id;
ALTER TABLE auth_accounts DROP CONSTRAINT auth_accounts_pkey;
ALTER TABLE auth_accounts ALTER COLUMN id SET NOT NULL;
ALTER TABLE auth_accounts ADD PRIMARY KEY (id);
ALTER TABLE auth_accounts ADD CHECK (id > 0);
ALTER TABLE auth_accounts ADD COLUMN display_name text NOT NULL DEFAULT '';
ALTER TABLE auth_accounts ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE auth_accounts ADD COLUMN must_change_password boolean NOT NULL DEFAULT true;
ALTER TABLE auth_accounts ADD COLUMN authority_version bigint NOT NULL DEFAULT 1 CHECK (authority_version > 0);
ALTER TABLE auth_accounts ADD CHECK ((id = 1 AND location_id = 1 AND enabled) OR (id <> 1 AND location_id <> 1));
CREATE INDEX auth_accounts_location ON auth_accounts(location_id);
ALTER TABLE auth_sessions ALTER COLUMN account_id TYPE bigint;
ALTER TABLE auth_sessions ADD FOREIGN KEY (account_id) REFERENCES auth_accounts(id);
ALTER TABLE auth_sessions ADD COLUMN authority_version bigint NOT NULL DEFAULT 1 CHECK (authority_version > 0);

-- Transactional allocation avoids consuming an identity sequence on rejection.
-- It also preserves the initial private bootstrap's IDs 1,2,3.
CREATE FUNCTION assign_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(214014, 1);
    IF NEW.id IS NULL THEN
        SELECT coalesce(max(id), 0) + 1 INTO NEW.id FROM auth_accounts;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER assign_auth_account_identity BEFORE INSERT ON auth_accounts
FOR EACH ROW EXECUTE FUNCTION assign_account_identity();
CREATE FUNCTION guard_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.id = 1 THEN RAISE EXCEPTION 'warehouse administrator is protected'; END IF;
        RETURN OLD;
    END IF;
    IF NEW.id <> OLD.id THEN RAISE EXCEPTION 'account identity is immutable'; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER protect_auth_accounts BEFORE UPDATE OR DELETE ON auth_accounts
FOR EACH ROW EXECUTE FUNCTION guard_account_identity();
-- The original TRUNCATE guard remains in force. No second administrator role exists.

-- Keep warehouse and catalog identity immutable, but admit positive branch IDs.
ALTER TABLE locations DROP CONSTRAINT locations_id_check;
ALTER TABLE locations DROP CONSTRAINT locations_check;
ALTER TABLE locations ADD CHECK (id > 0);
ALTER TABLE locations ADD CHECK ((id = 1 AND name = 'Almacén') OR (id > 1 AND name <> 'Almacén'));
ALTER TABLE locations ADD CHECK (btrim(name) <> '');
DROP TRIGGER protect_locations ON locations;
CREATE FUNCTION guard_location_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'location identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER protect_locations BEFORE INSERT OR UPDATE OR DELETE ON locations
FOR EACH ROW EXECUTE FUNCTION guard_location_identity();

-- Seed inserts locations before catalog/metadata. Later insertions atomically
-- initialize every catalog variant; no endpoint exposes this seam yet.
CREATE FUNCTION initialize_branch_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM initialization_metadata) THEN
        INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
        SELECT NEW.id,v.id,0,0 FROM catalog_variants v ORDER BY v.id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER initialize_branch_stock AFTER INSERT ON locations
FOR EACH ROW EXECUTE FUNCTION initialize_branch_inventory();
CREATE FUNCTION create_branch(branch_name text) RETURNS smallint LANGUAGE plpgsql AS $$
DECLARE branch_id smallint;
BEGIN
    -- Reuse initialization serialization, not a competing allocation path.
    PERFORM pg_advisory_xact_lock(21485914531180593);
    IF NOT EXISTS (SELECT 1 FROM initialization_metadata) THEN
        RAISE EXCEPTION 'catalog initialization is required';
    END IF;
    SELECT (max(id)::integer + 1)::smallint INTO branch_id FROM locations;
    INSERT INTO locations(id,name) VALUES(branch_id,branch_name);
    RETURN branch_id;
END;
$$;
REVOKE ALL ON FUNCTION create_branch(text) FROM PUBLIC;
