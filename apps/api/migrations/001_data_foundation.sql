-- Exact source entries; model suffixes are not polarity instructions.
CREATE TABLE locations (
    id smallint PRIMARY KEY CHECK (id BETWEEN 1 AND 3),
    name text NOT NULL UNIQUE,
    CHECK ((id = 1 AND name = 'Almacén') OR
           (id = 2 AND name = 'Sucursal A') OR
           (id = 3 AND name = 'Sucursal B'))
);

CREATE TABLE catalog_entries (
    id integer PRIMARY KEY CHECK (id BETWEEN 1 AND 95),
    brand text NOT NULL CHECK (brand <> ''),
    model text NOT NULL CHECK (model <> ''),
    capacity_ah numeric(12,6) NOT NULL
        CHECK (capacity_ah > 0 AND capacity_ah <> 'NaN'::numeric),
    UNIQUE (brand, model)
);

CREATE TABLE catalog_variants (
    id integer PRIMARY KEY CHECK (id BETWEEN 1 AND 190),
    catalog_entry_id integer NOT NULL REFERENCES catalog_entries(id),
    polarity text NOT NULL CHECK (polarity IN ('L', 'R')),
    UNIQUE (catalog_entry_id, polarity)
);

CREATE TABLE inventory_balances (
    location_id smallint NOT NULL REFERENCES locations(id),
    variant_id integer NOT NULL REFERENCES catalog_variants(id),
    existing bigint NOT NULL CHECK (existing >= 0),
    reserved bigint NOT NULL CHECK (reserved >= 0 AND reserved <= existing),
    available bigint GENERATED ALWAYS AS (existing - reserved) STORED,
    PRIMARY KEY (location_id, variant_id)
);

-- This metadata is not a UI label, account, or transfer hold.
CREATE TABLE initialization_metadata (
    id smallint PRIMARY KEY CHECK (id = 1),
    source_sha256 text NOT NULL,
    fixture_sha256 text NOT NULL,
    stock_origin text NOT NULL CHECK (stock_origin = 'fictional-local-trial-v1'),
    initialized_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION protect_preloaded_catalog() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' OR EXISTS (SELECT 1 FROM initialization_metadata) THEN
        RAISE EXCEPTION 'preloaded catalog and locations are immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER protect_locations
BEFORE INSERT OR UPDATE OR DELETE ON locations
FOR EACH ROW EXECUTE FUNCTION protect_preloaded_catalog();
CREATE TRIGGER protect_entries
BEFORE INSERT OR UPDATE OR DELETE ON catalog_entries
FOR EACH ROW EXECUTE FUNCTION protect_preloaded_catalog();
CREATE TRIGGER protect_variants
BEFORE INSERT OR UPDATE OR DELETE ON catalog_variants
FOR EACH ROW EXECUTE FUNCTION protect_preloaded_catalog();

CREATE FUNCTION reject_preloaded_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'initialization metadata and preloaded catalog are immutable';
END;
$$;
CREATE TRIGGER protect_initialization_metadata
BEFORE UPDATE OR DELETE ON initialization_metadata
FOR EACH ROW EXECUTE FUNCTION reject_preloaded_mutation();
CREATE TRIGGER protect_locations_truncate
BEFORE TRUNCATE ON locations
EXECUTE FUNCTION reject_preloaded_mutation();
CREATE TRIGGER protect_entries_truncate
BEFORE TRUNCATE ON catalog_entries
EXECUTE FUNCTION reject_preloaded_mutation();
CREATE TRIGGER protect_variants_truncate
BEFORE TRUNCATE ON catalog_variants
EXECUTE FUNCTION reject_preloaded_mutation();
CREATE TRIGGER protect_metadata_truncate
BEFORE TRUNCATE ON initialization_metadata
EXECUTE FUNCTION reject_preloaded_mutation();
