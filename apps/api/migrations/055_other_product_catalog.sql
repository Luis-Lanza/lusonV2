-- Other products join the catalog identity as a second kind. A battery keeps its
-- brand/model/capacity shape and its polarities; an other product carries a free
-- name, no battery shape and one polarity-less variant. Every pre-existing row
-- defaults to kind='battery', so nothing that already reads the catalog changes
-- meaning and the transfer engine keeps one item identity to work with.

ALTER TABLE catalog_entries ADD COLUMN kind text NOT NULL DEFAULT 'battery';
ALTER TABLE catalog_entries ADD COLUMN name text;

-- The battery shape stops being a table-wide obligation and becomes a rule of
-- its kind, enforced by catalog_entries_kind_shape below.
ALTER TABLE catalog_entries ALTER COLUMN brand DROP NOT NULL;
ALTER TABLE catalog_entries ALTER COLUMN model DROP NOT NULL;
ALTER TABLE catalog_entries ALTER COLUMN capacity_ah DROP NOT NULL;

ALTER TABLE catalog_entries ADD CONSTRAINT catalog_entries_kind_check
    CHECK (kind IN ('battery', 'other'));

-- Exactly one shape per kind: a battery never carries a product name and an
-- other product never carries brand, model or capacity.
ALTER TABLE catalog_entries ADD CONSTRAINT catalog_entries_kind_shape CHECK (
    (kind = 'battery'
        AND brand IS NOT NULL AND model IS NOT NULL AND capacity_ah IS NOT NULL
        AND name IS NULL)
    OR
    (kind = 'other'
        AND name IS NOT NULL AND btrim(name) <> ''
        AND brand IS NULL AND model IS NULL AND capacity_ah IS NULL)
);

-- An active product name is unique ignoring case, the same way an active
-- battery identity is, and a retired product frees the name it used.
CREATE UNIQUE INDEX catalog_entries_active_other_name
ON catalog_entries (lower(name)) WHERE deleted_at IS NULL AND kind = 'other';

-- A polarity only makes sense for a battery: the NOT NULL becomes a rule of the
-- kind, checked by guard_catalog_variant_identity below.
ALTER TABLE catalog_variants ALTER COLUMN polarity DROP NOT NULL;

-- One other product, one variant. `UNIQUE (catalog_entry_id, polarity)` cannot
-- express this because NULL polarities never collide.
CREATE UNIQUE INDEX catalog_variants_single_other
ON catalog_variants (catalog_entry_id) WHERE polarity IS NULL;

CREATE OR REPLACE FUNCTION guard_catalog_entry_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE blocker text;
BEGIN
    IF TG_OP='INSERT' THEN
        RETURN NEW;
    ELSIF TG_OP='DELETE' THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_entry_deletion_forbidden',
            MESSAGE='catalog batteries are retired, never deleted';
    END IF;
    IF NEW.id<>OLD.id THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_entry_identity_immutable',
            MESSAGE='catalog battery identity is immutable';
    END IF;
    -- A catalog entry is born one kind and stays that kind: the balance matrix,
    -- the prices and every append-only line already point at its variant.
    IF NEW.kind IS DISTINCT FROM OLD.kind THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_entry_kind_immutable',
            MESSAGE='a catalog entry never changes kind';
    END IF;
    IF OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN
        IF OLD.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_entry_retired_immutable',
                MESSAGE='a retired catalog battery is immutable';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
       AND (to_jsonb(NEW)-'deleted_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'deleted_at') THEN
        blocker:=catalog_entry_retirement_blocker(OLD.id);
        IF blocker IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_retirement_blocked',
                MESSAGE='Battery retirement blocked: '||blocker;
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_entry_identity_immutable',
        MESSAGE='catalog battery identity is immutable';
END;
$$;

-- A new trigger owns the kind rule. Replacing guard_catalog_variant_identity
-- would silently drop the retired-battery refusal 029 added to it, so the
-- polarity decision lives in its own function and both triggers keep firing.
CREATE FUNCTION guard_catalog_variant_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_kind text;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    SELECT kind INTO parent_kind FROM catalog_entries WHERE id = NEW.catalog_entry_id;
    IF NOT FOUND THEN
        -- The foreign key owns the unknown-entry refusal.
        RETURN NEW;
    END IF;
    IF parent_kind = 'battery' AND NEW.polarity IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_variant_polarity',
            MESSAGE='a battery variant needs a polarity';
    END IF;
    IF parent_kind = 'other' AND NEW.polarity IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_variant_polarity',
            MESSAGE='an other product carries a polarity-less variant';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER protect_variant_kind BEFORE INSERT OR UPDATE OR DELETE ON catalog_variants
FOR EACH ROW EXECUTE FUNCTION guard_catalog_variant_kind();

-- Typed custom fields. They belong to an other product, they are values and not
-- evidence, so an edit replaces them; a retired product freezes them instead of
-- deleting them.
CREATE TABLE catalog_entry_fields (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    catalog_entry_id integer NOT NULL REFERENCES catalog_entries(id),
    name text NOT NULL,
    kind text NOT NULL,
    unit text,
    number_value numeric(18,6),
    text_value text,
    CONSTRAINT catalog_entry_fields_kind CHECK (kind IN ('number', 'text')),
    CONSTRAINT catalog_entry_fields_shape CHECK (
        btrim(name) = name AND char_length(name) BETWEEN 1 AND 40 AND (
            kind NOT IN ('number', 'text')
            OR (kind = 'number'
                AND number_value IS NOT NULL AND number_value <> 'NaN'::numeric
                AND text_value IS NULL)
            OR (kind = 'text'
                AND text_value IS NOT NULL AND text_value <> ''
                AND number_value IS NULL AND unit IS NULL)
        )
    ),
    CONSTRAINT catalog_entry_fields_unit CHECK (
        unit IS NULL OR (btrim(unit) = unit AND char_length(unit) BETWEEN 1 AND 8)
    )
);

CREATE UNIQUE INDEX catalog_entry_fields_name
ON catalog_entry_fields (catalog_entry_id, lower(name));

CREATE FUNCTION guard_catalog_entry_field() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_kind text; parent_deleted timestamptz;
BEGIN
    SELECT kind, deleted_at INTO parent_kind, parent_deleted
        FROM catalog_entries WHERE id = COALESCE(NEW.catalog_entry_id, OLD.catalog_entry_id);
    IF NOT FOUND THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF parent_kind <> 'other' THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_entry_field_kind',
            MESSAGE='custom fields belong to an other product';
    END IF;
    IF parent_deleted IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='catalog_entry_field_retired',
            MESSAGE='a retired product is immutable';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER protect_entry_fields BEFORE INSERT OR UPDATE OR DELETE ON catalog_entry_fields
FOR EACH ROW EXECUTE FUNCTION guard_catalog_entry_field();
