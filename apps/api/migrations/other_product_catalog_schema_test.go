package migrations_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/db"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// Other products share the catalog identity with batteries. The migration is
// additive: every pre-existing row keeps kind='battery' and the battery shape,
// so nothing that already reads the catalog changes meaning.
func TestOtherProductCatalogStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile("055_other_product_catalog.sql")
	if err != nil {
		t.Fatal("other product migration must be embedded", err)
	}
	sql := statements(string(b))
	for _, required := range []string{
		"ALTER TABLE catalog_entries ADD COLUMN kind text NOT NULL DEFAULT 'battery'",
		"ALTER TABLE catalog_entries ADD COLUMN name text",
		"ALTER TABLE catalog_entries ALTER COLUMN brand DROP NOT NULL",
		"ALTER TABLE catalog_entries ALTER COLUMN model DROP NOT NULL",
		"ALTER TABLE catalog_entries ALTER COLUMN capacity_ah DROP NOT NULL",
		"ADD CONSTRAINT catalog_entries_kind_shape",
		"CREATE UNIQUE INDEX catalog_entries_active_other_name",
		"lower(name)",
		"ALTER TABLE catalog_variants ALTER COLUMN polarity DROP NOT NULL",
		"CREATE UNIQUE INDEX catalog_variants_single_other",
		"CREATE FUNCTION guard_catalog_variant_kind() RETURNS trigger",
		"CREATE TRIGGER protect_variant_kind BEFORE INSERT OR UPDATE OR DELETE ON catalog_variants",
		"CONSTRAINT='catalog_variant_polarity'",
		"CONSTRAINT='catalog_entry_kind_immutable'",
		"CREATE TABLE catalog_entry_fields",
		"CONSTRAINT catalog_entry_fields_shape CHECK",
		"CONSTRAINT catalog_entry_fields_unit CHECK",
		"CREATE UNIQUE INDEX catalog_entry_fields_name",
		"CONSTRAINT='catalog_entry_field_kind'",
		"CONSTRAINT='catalog_entry_field_retired'",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("other product migration is incomplete: missing %s", required)
		}
	}
	// The catalog keeps its one-way retirement and its reset guards: this
	// migration adds a product shape, it does not open a deletion path.
	for _, forbidden := range []string{
		"DROP TRIGGER protect_entries",
		"DROP TRIGGER protect_variants",
		"DROP TRIGGER protect_entries_truncate",
		"DROP TRIGGER protect_variants_truncate",
		"DELETE FROM catalog_entries",
		"DELETE FROM catalog_variants",
		"TRUNCATE",
		"DROP COLUMN deleted_at",
		"ADD COLUMN kind text NOT NULL DEFAULT 'other'",
		// 029 already owns the retired-battery refusal inside this function; a
		// replacement would silently drop it.
		"CREATE OR REPLACE FUNCTION guard_catalog_variant_identity",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the other product migration must not weaken the catalog: found %s", forbidden)
		}
	}
}

// TestOtherProductCatalog runs on the admitted parent-owned PostgreSQL fixture;
// no skip path.
func TestOtherProductCatalog(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	p := testpg.Open(t)
	if err := db.Apply(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := bootstrap.Seed(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	exec := func(t *testing.T, sql string, args ...any) {
		t.Helper()
		if _, err := p.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	// refused asserts the exact database-level refusal, so a violation cannot
	// pass as some other error.
	refused := func(t *testing.T, code, constraint, sql string, args ...any) {
		t.Helper()
		_, err := p.Exec(ctx, sql, args...)
		requirePgFailure(t, err, code, constraint)
	}
	scalar := func(t *testing.T, query string, args ...any) int {
		t.Helper()
		var n int
		if err := p.QueryRow(ctx, query, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	insertBattery := func(t *testing.T, brand, model string) int64 {
		t.Helper()
		var entry int64
		if err := p.QueryRow(ctx,
			"INSERT INTO catalog_entries(brand,model,capacity_ah) VALUES($1,$2,75) RETURNING id",
			brand, model).Scan(&entry); err != nil {
			t.Fatalf("a battery must stay insertable exactly as before: %v", err)
		}
		return entry
	}
	// createOther inserts the shape the HTTP layer will insert: one entry with a
	// free name and exactly one polarity-less variant.
	createOther := func(t *testing.T, name string) (entry int64, variant int64) {
		t.Helper()
		if err := p.QueryRow(ctx,
			"INSERT INTO catalog_entries(kind,name) VALUES('other',$1) RETURNING id",
			name).Scan(&entry); err != nil {
			t.Fatalf("an other product must be insertable: %v", err)
		}
		if err := p.QueryRow(ctx,
			"INSERT INTO catalog_variants(catalog_entry_id) VALUES($1) RETURNING id",
			entry).Scan(&variant); err != nil {
			t.Fatalf("an other product variant must be insertable: %v", err)
		}
		return entry, variant
	}

	t.Run("the_seeded_batteries_keep_their_shape", func(t *testing.T) {
		if got := scalar(t, `SELECT count(*) FROM catalog_entries WHERE kind='battery'`); got != 95 {
			t.Fatalf("every seeded entry stays a battery: got %d", got)
		}
		if got := scalar(t, `SELECT count(*) FROM catalog_entries WHERE name IS NOT NULL`); got != 0 {
			t.Fatalf("no battery carries a product name: got %d", got)
		}
		if got := scalar(t, `SELECT count(*) FROM catalog_variants WHERE polarity IS NULL`); got != 0 {
			t.Fatalf("no battery variant loses its polarity: got %d", got)
		}
	})

	t.Run("a_battery_is_created_exactly_as_before", func(t *testing.T) {
		entry := insertBattery(t, "OTRA", "75Ah")
		if got := scalar(t,
			`SELECT count(*) FROM catalog_entries WHERE id=$1 AND kind='battery' AND name IS NULL`, entry); got != 1 {
			t.Fatal("a battery inserted without a kind must default to kind='battery'")
		}
	})

	t.Run("an_other_product_has_a_name_and_no_battery_shape", func(t *testing.T) {
		entry, variant := createOther(t, "Agua acidulada")
		if got := scalar(t, `SELECT count(*) FROM catalog_entries
			WHERE id=$1 AND kind='other' AND name='Agua acidulada'
			AND brand IS NULL AND model IS NULL AND capacity_ah IS NULL`, entry); got != 1 {
			t.Fatal("an other product carries only its name")
		}
		if got := scalar(t,
			`SELECT count(*) FROM catalog_variants WHERE id=$1 AND polarity IS NULL`, variant); got != 1 {
			t.Fatal("an other product carries one polarity-less variant")
		}
		// The balance fan-out is the same one batteries use: one zero row per
		// active branch, which is what the later transfer vertical needs.
		active := scalar(t, "SELECT count(*) FROM locations WHERE deleted_at IS NULL")
		if got := scalar(t, `SELECT count(*) FROM inventory_balances
			WHERE variant_id=$1 AND existing=0 AND reserved=0`, variant); got != active {
			t.Fatalf("a new other product needs one zero balance per active branch: got %d want %d", got, active)
		}
	})

	t.Run("the_shape_of_a_kind_is_enforced", func(t *testing.T) {
		refused(t, "23514", "catalog_entries_kind_shape",
			"INSERT INTO catalog_entries(kind,brand,model,capacity_ah) VALUES('other','X','Y',75)")
		refused(t, "23514", "catalog_entries_kind_shape",
			"INSERT INTO catalog_entries(kind,name,capacity_ah) VALUES('other','Con capacidad',75)")
		refused(t, "23514", "catalog_entries_kind_shape",
			"INSERT INTO catalog_entries(kind,name,brand) VALUES('other','Con marca','X')")
		refused(t, "23514", "catalog_entries_kind_shape",
			"INSERT INTO catalog_entries(kind) VALUES('other')")
		refused(t, "23514", "catalog_entries_kind_shape",
			"INSERT INTO catalog_entries(kind,brand,model) VALUES('battery','SIN','CAPACIDAD')")
		refused(t, "23514", "catalog_entries_kind_shape",
			"INSERT INTO catalog_entries(kind,name,brand,model,capacity_ah) VALUES('battery','Nombre','X','Y',75)")
		refused(t, "23514", "catalog_entries_kind_check",
			"INSERT INTO catalog_entries(kind,brand,model,capacity_ah) VALUES('mixed','X','Y',75)")
	})

	t.Run("an_active_product_name_is_unique_ignoring_case", func(t *testing.T) {
		createOther(t, "Batería de gel")
		refused(t, "23505", "catalog_entries_active_other_name",
			"INSERT INTO catalog_entries(kind,name) VALUES('other','BATERÍA DE GEL')")
	})

	t.Run("a_retired_product_frees_its_name", func(t *testing.T) {
		entry, _ := createOther(t, "Aguarrás")
		exec(t, "UPDATE catalog_entries SET deleted_at=now() WHERE id=$1", entry)
		createOther(t, "aguarrás")
	})

	t.Run("a_variant_polarity_belongs_to_its_kind", func(t *testing.T) {
		entry, _ := createOther(t, "Ácido sulfúrico")
		refused(t, "23505", "catalog_variants_single_other",
			"INSERT INTO catalog_variants(catalog_entry_id) VALUES($1)", entry)
		refused(t, "23514", "catalog_variant_polarity",
			"INSERT INTO catalog_variants(catalog_entry_id,polarity) VALUES($1,'L')", entry)
		if got := scalar(t,
			`SELECT count(*) FROM catalog_variants WHERE catalog_entry_id=$1`, entry); got != 1 {
			t.Fatalf("an other product keeps one variant: got %d", got)
		}
		battery := insertBattery(t, "POL", "40Ah")
		refused(t, "23514", "catalog_variant_polarity",
			"INSERT INTO catalog_variants(catalog_entry_id) VALUES($1)", battery)
	})

	t.Run("a_kind_never_changes", func(t *testing.T) {
		entry, _ := createOther(t, "Nevera")
		refused(t, "23514", "catalog_entry_kind_immutable",
			"UPDATE catalog_entries SET kind='battery' WHERE id=$1", entry)
	})

	t.Run("fields_belong_to_an_other_product", func(t *testing.T) {
		entry, _ := createOther(t, "Destilada")
		exec(t, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,unit,number_value)
			VALUES($1,'volumen en L','number','L',5)`, entry)
		exec(t, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,text_value)
			VALUES($1,'origen','text','importado')`, entry)
		battery := insertBattery(t, "FLD", "50Ah")
		refused(t, "23514", "catalog_entry_field_kind",
			`INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,text_value)
			VALUES($1,'marca','text','x')`, battery)
	})

	t.Run("a_field_value_matches_its_type", func(t *testing.T) {
		entry, _ := createOther(t, "Con campos")
		refused(t, "23514", "catalog_entry_fields_shape",
			`INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,text_value)
			VALUES($1,'volumen','number','cinco')`, entry)
		refused(t, "23514", "catalog_entry_fields_shape",
			`INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind) VALUES($1,'volumen','number')`, entry)
		refused(t, "23514", "catalog_entry_fields_shape",
			`INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,number_value)
			VALUES($1,'nota','text',5)`, entry)
		refused(t, "23514", "catalog_entry_fields_shape",
			`INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,unit,text_value)
			VALUES($1,'nota','text','L','texto')`, entry)
		refused(t, "23514", "catalog_entry_fields_shape",
			`INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,text_value)
			VALUES($1,'  ','text','x')`, entry)
		refused(t, "23514", "catalog_entry_fields_shape",
			`INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,text_value)
			VALUES($1,repeat('x',41),'text','x')`, entry)
		refused(t, "23514", "catalog_entry_fields_unit",
			`INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,unit,number_value)
			VALUES($1,'volumen','number','hectolitros',5)`, entry)
		refused(t, "23514", "catalog_entry_fields_kind",
			`INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,text_value)
			VALUES($1,'raro','boolean','x')`, entry)
	})

	t.Run("a_field_name_is_unique_inside_its_product", func(t *testing.T) {
		entry, _ := createOther(t, "Con repetidos")
		exec(t, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,text_value)
			VALUES($1,'origen','text','x')`, entry)
		refused(t, "23505", "catalog_entry_fields_name",
			`INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,text_value)
			VALUES($1,'ORIGEN','text','y')`, entry)
	})

	t.Run("a_retired_product_freezes_its_fields", func(t *testing.T) {
		entry, variant := createOther(t, "Retirada")
		exec(t, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,text_value)
			VALUES($1,'origen','text','x')`, entry)
		// Retirement is refused while stock exists, then allowed when it is zero.
		exec(t, "UPDATE inventory_balances SET existing=1 WHERE variant_id=$1", variant)
		refused(t, "23514", "catalog_retirement_blocked",
			"UPDATE catalog_entries SET deleted_at=now() WHERE id=$1", entry)
		exec(t, "UPDATE inventory_balances SET existing=0 WHERE variant_id=$1", variant)
		exec(t, "UPDATE catalog_entries SET deleted_at=now() WHERE id=$1", entry)
		refused(t, "23514", "catalog_entry_field_retired",
			`UPDATE catalog_entry_fields SET text_value='y' WHERE catalog_entry_id=$1`, entry)
		refused(t, "23514", "catalog_entry_field_retired",
			`INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,text_value)
			VALUES($1,'otro','text','x')`, entry)
	})
}
