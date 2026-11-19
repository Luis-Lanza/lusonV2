-- A warranty is a promise with a recipient, so a sale that issues one names its client:
-- exactly the three data the printed document carries, the name, the phone and the
-- document. A sale of products alone issues no warranty, so it names nobody and prints
-- "Consumidor final"; the address stays optional always, because it is stored and never
-- printed and a rule nobody can satisfy from the paper is not a rule.
--
-- The rule is the document's, so it hangs on the sale and is judged at commit, beside the
-- units: a battery line is what makes a warranty, and a document that carries one is
-- refused until its client is complete.

ALTER TABLE sales DROP CONSTRAINT sales_customer_name_check;

-- The name is no longer mandatory: a product-only sale has no client to name.
ALTER TABLE sales ALTER COLUMN customer_name SET DEFAULT '';
ALTER TABLE sales ADD CONSTRAINT sales_customer_name_check
    CHECK (char_length(btrim(customer_name)) <= 120);

CREATE FUNCTION require_warranty_customer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    warranted boolean;
    missing text;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM sale_lines line
        JOIN catalog_variants variant ON variant.id=line.variant_id
        JOIN catalog_entries entry ON entry.id=variant.catalog_entry_id
        WHERE line.sale_id=NEW.id AND entry.kind='battery'
    ) INTO warranted;
    IF NOT warranted THEN
        RETURN NULL;
    END IF;
    SELECT string_agg(field, ',' ORDER BY field) INTO missing
    FROM (VALUES
        ('customer_name', NEW.customer_name),
        ('customer_phone', NEW.customer_phone),
        ('customer_document', NEW.customer_document)
    ) AS client(field, value)
    WHERE btrim(value) = '';
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='LV015',
            MESSAGE='A sale that issues a warranty requires the complete customer',
            DETAIL=missing;
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER require_warranty_customer AFTER INSERT ON sales
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_warranty_customer();
