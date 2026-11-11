package migrations_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// migration032 is the purchase migration: the system's first money-out document.
// It is additive -- new tables, new triggers and new indexes -- and it never
// rewrites a historical version or an existing table, so this constant names the one
// file this unit owns.
const migration032 = "032_purchases.sql"

// migration033 is the forward-only widening of the used model code: the catalogue
// itself serves codes that carry a comma, and 032 is already applied and checksummed.
const migration033 = "033_purchase_model_code_comma.sql"

// The purchase migration adds a document instead of widening an existing one: a used
// battery is never resold, so it belongs neither to the catalogue, nor to the point
// of sale, nor to inventory_balances. statements drops whole-line SQL comments, so a
// comment that names a historical object is never mistaken for a statement that
// touches it.
func TestPurchaseSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration032)
	if err != nil {
		t.Fatal("the purchase migration must be embedded", err)
	}
	sql := statements(string(b))
	for _, required := range []string{
		// Reference data: the four materials the branch buys by the kilogram.
		"CREATE TABLE materials",
		"INSERT INTO materials(id,name,unit) VALUES (1,'Cobre','kg'),(2,'Aluminio','kg'),(3,'Plomo','kg'),(4,'Bronce','kg')",
		"CHECK (unit = 'kg')",
		// The document: branch, note, total, the two paid amounts, the account that
		// received it and the reversal binding.
		"CREATE TABLE purchases",
		"operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9_-]{16,128}$')",
		"location_id smallint NOT NULL REFERENCES locations(id)",
		"note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500)",
		"total numeric(12,2) NOT NULL CHECK (total <> 'NaN'::numeric)",
		"paid_cash numeric(12,2) NOT NULL DEFAULT 0 CHECK (paid_cash <> 'NaN'::numeric)",
		"paid_transfer numeric(12,2) NOT NULL DEFAULT 0 CHECK (paid_transfer <> 'NaN'::numeric)",
		"reverses_purchase_id bigint REFERENCES purchases(id)",
		"reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500)",
		"created_by_account_id integer NOT NULL REFERENCES auth_accounts(id)",
		"created_at timestamptz NOT NULL DEFAULT now()",
		// A document never reverses itself and a counter-document always states why.
		"CHECK (reverses_purchase_id IS NULL OR reverses_purchase_id <> id)",
		"CHECK ((reverses_purchase_id IS NULL AND reason = '')",
		// A used battery is identified only by its model code, trimmed and upper-cased.
		"CREATE TABLE purchase_used_lines",
		"model text NOT NULL CHECK (model ~ '^[A-Z0-9][A-Z0-9 ._/-]{0,39}$')",
		"quantity bigint NOT NULL CHECK (quantity <> 0)",
		"unit_price numeric(12,2) NOT NULL CHECK (unit_price > 0 AND unit_price <> 'NaN'::numeric)",
		"amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount <> 'NaN'::numeric)",
		"PRIMARY KEY (purchase_id, model)",
		// Scrap is bought by the kilogram: a material, a weight and a price per kilogram.
		"CREATE TABLE purchase_scrap_lines",
		"material_id smallint NOT NULL REFERENCES materials(id)",
		"kg numeric(12,3) NOT NULL CHECK (kg <> 0 AND kg <> 'NaN'::numeric)",
		"price_per_kg numeric(12,2) NOT NULL CHECK (price_per_kg > 0 AND price_per_kg <> 'NaN'::numeric)",
		"PRIMARY KEY (purchase_id, material_id)",
		// A used line amount is quantity * unit_price, exact; a scrap line amount is the
		// kilogram price rounded half up to the cent. Both are derived, never typed.
		"NEW.quantity::numeric * NEW.unit_price",
		"round(NEW.kg * NEW.price_per_kg, 2)",
		"CREATE TRIGGER apply_purchase_used_line BEFORE INSERT ON purchase_used_lines",
		"CREATE TRIGGER apply_purchase_scrap_line BEFORE INSERT ON purchase_scrap_lines",
		// The branch, the settlement and the sign are the database's authority.
		"CREATE TRIGGER admit_purchase BEFORE INSERT ON purchases",
		"CREATE CONSTRAINT TRIGGER require_purchase_document AFTER INSERT ON purchases",
		"DEFERRABLE INITIALLY DEFERRED",
		// A line is judged with its document: the header's own deferred check cannot see
		// an append to an already committed document, so every line insert re-checks the
		// whole document at commit.
		"CREATE FUNCTION guard_purchase_line()",
		"CREATE CONSTRAINT TRIGGER guard_purchase_used_line AFTER INSERT ON purchase_used_lines",
		"CREATE CONSTRAINT TRIGGER guard_purchase_scrap_line AFTER INSERT ON purchase_scrap_lines",
		// At most one counter-document per original: both stay visible forever.
		"CREATE UNIQUE INDEX purchases_single_reversal ON purchases(reverses_purchase_id)",
		// The page and the last-prices read need their own access paths.
		"CREATE INDEX purchases_branch_history ON purchases(location_id, id DESC)",
		"CREATE INDEX purchase_used_lines_by_model ON purchase_used_lines(model, purchase_id DESC)",
		"CREATE INDEX purchase_scrap_lines_by_material ON purchase_scrap_lines(material_id, purchase_id DESC)",
		// Immutable documents, truncate included, through the house guard.
		"CREATE TRIGGER protect_purchases BEFORE UPDATE OR DELETE ON purchases",
		"CREATE TRIGGER protect_purchases_truncate BEFORE TRUNCATE ON purchases",
		"CREATE TRIGGER protect_purchase_used_lines BEFORE UPDATE OR DELETE ON purchase_used_lines",
		"CREATE TRIGGER protect_purchase_used_lines_truncate BEFORE TRUNCATE ON purchase_used_lines",
		"CREATE TRIGGER protect_purchase_scrap_lines BEFORE UPDATE OR DELETE ON purchase_scrap_lines",
		"CREATE TRIGGER protect_purchase_scrap_lines_truncate BEFORE TRUNCATE ON purchase_scrap_lines",
		"CREATE TRIGGER protect_materials BEFORE UPDATE OR DELETE ON materials",
		"CREATE TRIGGER protect_materials_truncate BEFORE TRUNCATE ON materials",
		"FOR EACH ROW EXECUTE FUNCTION protect_pending_request()",
		"EXECUTE FUNCTION protect_pending_request()",
		// Material names are read by the branch: they are bounded like every other text.
		"CHECK (char_length(btrim(name)) BETWEEN 1 AND 40)",
		"CHECK (id > 0)",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// Every refusal raises its own SQLSTATE: the store maps that code and nothing else.
	for _, code := range []string{"LP001", "LP002", "LP003", "LP004", "LP005"} {
		if !strings.Contains(sql, "ERRCODE='"+code+"'") {
			t.Errorf("missing SQLSTATE %s", code)
		}
	}
	// Additive only: no historical table, function or trigger is rewritten, and no
	// object is dropped.
	for _, forbidden := range []string{"ALTER TABLE", "CREATE OR REPLACE", "DROP "} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the purchase migration must be additive: %s", forbidden)
		}
	}
	// This domain moves no balance and extends no realtime scope: the received totals
	// are read on request, the sum of the persisted lines.
	for _, forbidden := range []string{"inventory_balances", "realtime", "invalidate_balance_change"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("a purchase must never depend on %s", forbidden)
		}
	}
	// The reference rows are the only data this migration writes: they are the four
	// materials of the contract, typed data and never a client value.
	if n := strings.Count(sql, "INSERT INTO"); n != 1 {
		t.Fatalf("the purchase migration writes its reference rows only, got %d inserts", n)
	}
	// The document is judged at commit, so a counter-document that mirrors a persisted
	// original is judged after both line kinds are stored.
	if first, second := strings.Index(sql, "CREATE TABLE purchases"), strings.Index(sql, "CREATE TABLE purchase_used_lines"); first < 0 || second < 0 || first > second {
		t.Error("the document must exist before its lines do")
	}
	if first, second := strings.Index(sql, "INSERT INTO materials"), strings.Index(sql, "CREATE TRIGGER protect_materials"); first < 0 || second < 0 || first > second {
		t.Error("the reference rows are written before the table is sealed")
	}
	// The migration documents why a used battery is a document of its own and how a
	// correction is expressed.
	for _, documented := range []string{"money-out", "counter-document", "half up", "never resold"} {
		if !strings.Contains(string(b), documented) {
			t.Errorf("the migration must document its own decision: %s", documented)
		}
	}
}

// TestPurchaseModelCodeCommaMigration proves the widening is forward-only: the applied
// 032 is checksummed, so 033 drops the constraint PostgreSQL named there and adds the
// same bound with the comma, without writing or moving a single line.
func TestPurchaseModelCodeCommaMigration(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration033)
	if err != nil {
		t.Fatal("the comma migration must be embedded", err)
	}
	sql := statements(string(b))
	for _, required := range []string{
		"ALTER TABLE purchase_used_lines",
		"DROP CONSTRAINT purchase_used_lines_model_check",
		"ADD CONSTRAINT purchase_used_lines_model_check",
		"CHECK (model ~ '^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$')",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// Forward-only and data-free: only the constraint changes.
	for _, forbidden := range []string{"INSERT INTO", "UPDATE ", "DELETE ", "CREATE TABLE", "DROP TABLE", "TRUNCATE"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the comma migration must not move data: %s", forbidden)
		}
	}
	// The migration documents why it exists.
	for _, documented := range []string{"12N6,5_3B", "checksum", "comma"} {
		if !strings.Contains(string(b), documented) {
			t.Errorf("the migration must document its own reason: %s", documented)
		}
	}
}

// TestPurchaseModelCodeCommaGuard proves the widened pattern on a live database: the
// catalogue's comma models are persisted, and a character still outside the set is
// refused by the constraint 033 recreates.
func TestPurchaseModelCodeCommaGuard(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 33)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}

	// The two catalogue codes that carry a comma are admitted and stored exactly.
	tx, used := admitPurchase(t, ctx, p, "purchase-comma-guard-01", "51000.00", "51000.00", "0.00")
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'12N6,5_3B',1,25000.00),($1,'YB6,5_BS',1,26000.00)`, used); err != nil {
		t.Fatalf("the catalogue's comma models must be admitted: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a purchase of comma models must commit: %v", err)
	}
	var models string
	if err := p.QueryRow(ctx, `SELECT string_agg(model, ',' ORDER BY model)
 FROM purchase_used_lines WHERE purchase_id=$1`, used).Scan(&models); err != nil ||
		models != "12N6,5_3B,YB6,5_BS" {
		t.Fatalf("the comma models were not persisted: %q %v", models, err)
	}

	// A bang is outside the set and violates the check constraint itself.
	tx, bang := admitPurchase(t, ctx, p, "purchase-comma-guard-02", "25000.00", "25000.00", "0.00")
	_, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL!',1,25000.00)`, bang)
	checkViolation(t, err)
	_ = tx.Rollback(ctx)

	// A leading comma is outside the set too: the first character keeps its own bound.
	tx, leading := admitPurchase(t, ctx, p, "purchase-comma-guard-03", "25000.00", "25000.00", "0.00")
	_, err = tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,',NS60ZL',1,25000.00)`, leading)
	checkViolation(t, err)
	_ = tx.Rollback(ctx)
}

// checkViolation asserts a statement was refused by a CHECK constraint, not by an
// unrelated error.
func checkViolation(t *testing.T, err error) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("a model outside the set must violate the check, got %v", err)
	}
}

// TestPurchaseGuards proves the purchase rules on a live database: a complete document
// is admitted with its derived amounts, and every contradictory one is refused with its
// own SQLSTATE. Nothing here asserts a Go rule: these are the database's.
func TestPurchaseGuards(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 32)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}

	// The reference data is the contract's own list, ordered by id.
	var materials string
	if err := p.QueryRow(ctx, `SELECT string_agg(id||':'||name||':'||unit,',' ORDER BY id) FROM materials`).Scan(&materials); err != nil {
		t.Fatal("the materials could not be read")
	}
	if materials != "1:Cobre:kg,2:Aluminio:kg,3:Plomo:kg,4:Bronce:kg" {
		t.Fatalf("the reference materials are wrong: %s", materials)
	}

	// A complete document is admitted and its used amount is derived exactly.
	tx, used := admitPurchase(t, ctx, p, "purchase-guard-used-01", "75000.00", "75000.00", "0.00")
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',3,25000.00)`, used); err != nil {
		t.Fatalf("a positive used line must be admitted: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a complete purchase must commit: %v", err)
	}
	var usedAmount string
	if err := p.QueryRow(ctx, `SELECT amount::text FROM purchase_used_lines WHERE purchase_id=$1`, used).Scan(&usedAmount); err != nil || usedAmount != "75000.00" {
		t.Fatalf("the used amount must be quantity * unit_price: %q %v", usedAmount, err)
	}

	// A scrap amount is the kilogram price rounded half up to the cent, and a whole
	// weight keeps the exact product.
	tx, scrap := admitPurchase(t, ctx, p, "purchase-guard-scrap-01", "99200.01", "0.00", "99200.01")
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,1,12.400,8000.00),($1,2,0.005,1.00)`, scrap); err != nil {
		t.Fatalf("the scrap lines must be admitted: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a scrap purchase must commit: %v", err)
	}
	for material, want := range map[int]string{1: "99200.00", 2: "0.01"} {
		var amount string
		if err := p.QueryRow(ctx, `SELECT amount::text FROM purchase_scrap_lines WHERE purchase_id=$1 AND material_id=$2`, scrap, material).Scan(&amount); err != nil || amount != want {
			t.Fatalf("material %d amount %q, want %q: %v", material, amount, want, err)
		}
	}

	// A counter-document mirrors the persisted original: negated quantities and kg,
	// the same prices and negated amounts.
	tx, counter := admitCounter(t, ctx, p, "purchase-guard-counter-01", used, "-75000.00", "-75000.00", "0.00", "pesaje mal tipeado")
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',-3,25000.00)`, counter); err != nil {
		t.Fatalf("a mirrored counter line must be admitted: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a mirroring counter-document must commit: %v", err)
	}
	var counterAmount string
	if err := p.QueryRow(ctx, `SELECT amount::text FROM purchase_used_lines WHERE purchase_id=$1`, counter).Scan(&counterAmount); err != nil || counterAmount != "-75000.00" {
		t.Fatalf("the counter amount must negate its original: %q %v", counterAmount, err)
	}

	// A scrap counter-document mirrors the rounded amount exactly, so the net is zero.
	tx, scrapCounter := admitCounter(t, ctx, p, "purchase-guard-counter-02", scrap, "-99200.01", "0.00", "-99200.01", "peso mal tipeado")
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,1,-12.400,8000.00),($1,2,-0.005,1.00)`, scrapCounter); err != nil {
		t.Fatalf("the mirrored scrap lines must be admitted: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a mirroring scrap counter-document must commit: %v", err)
	}
	var netAmount string
	if err := p.QueryRow(ctx, `SELECT sum(amount)::text FROM purchase_scrap_lines WHERE purchase_id IN ($1,$2)`, scrap, scrapCounter).Scan(&netAmount); err != nil || netAmount != "0.00" {
		t.Fatalf("a counter-document must net out its original: %q %v", netAmount, err)
	}

	// The warehouse buys nothing: the branch guard is LP001, whatever the body says.
	_, err := p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES('purchase-guard-branch-01',1,10.00,10.00,0.00,1)`)
	execRefusal(t, err, "LP001")
	// An account of another branch never registers a purchase in this one.
	_, err = p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES('purchase-guard-branch-02',2,10.00,10.00,0.00,1)`)
	execRefusal(t, err, "LP001")

	// The total is the cash plus the transfer paid, exactly: LP002.
	_, err = p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES('purchase-guard-total-01',2,100.00,60.00,30.00,2)`)
	execRefusal(t, err, "LP002")

	// An original purchase spends money and a counter-document returns it: LP005.
	_, err = p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES('purchase-guard-sign-01',2,-100.00,-60.00,-40.00,2)`)
	execRefusal(t, err, "LP005")
	_, err = p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,reverses_purchase_id,reason,created_by_account_id)
 VALUES('purchase-guard-sign-02',2,100.00,100.00,0.00,$1,'motivo',2)`, used)
	execRefusal(t, err, "LP005")

	// A rejected document writes nothing at all.
	var documents int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM purchases`).Scan(&documents); err != nil || documents != 4 {
		t.Fatalf("a refused purchase must write nothing: %d %v", documents, err)
	}

	// A document without any line is refused at commit, whichever kind was expected.
	tx, _ = admitPurchase(t, ctx, p, "purchase-guard-empty-01", "100.00", "100.00", "0.00")
	commitRefusal(t, ctx, tx, "LP005")

	// A second document of both kinds is the mirror fixture: it carries two used
	// lines and one scrap line, so a counter-document is judged on both kinds at once.
	tx, mixed := admitPurchase(t, ctx, p, "purchase-guard-mixed-01", "26000.00", "26000.00", "0.00")
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',2,10000.00),($1,'55B24L',1,5000.00)`, mixed); err != nil {
		t.Fatalf("the mixed used lines must be admitted: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,3,1.000,1000.00)`, mixed); err != nil {
		t.Fatalf("the mixed scrap line must be admitted: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a purchase of both kinds must commit: %v", err)
	}

	// A counter-document that misses a line, changes a price or invents one does not
	// mirror its original: LP003, judged at commit.
	tx, missed := admitCounter(t, ctx, p, "purchase-guard-mirror-01", mixed, "-26000.00", "-26000.00", "0.00", "faltó una línea")
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',-2,10000.00)`, missed); err != nil {
		t.Fatalf("the single mirror line must be insertable: %v", err)
	}
	commitRefusal(t, ctx, tx, "LP003")
	tx, cheaper := admitCounter(t, ctx, p, "purchase-guard-mirror-02", mixed, "-26000.00", "-26000.00", "0.00", "otro precio")
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',-2,9999.00),($1,'55B24L',-1,5000.00)`, cheaper); err != nil {
		t.Fatalf("the cheaper mirror line must be insertable: %v", err)
	}
	commitRefusal(t, ctx, tx, "LP003")
	tx, extra := admitCounter(t, ctx, p, "purchase-guard-mirror-03", mixed, "-26000.00", "-26000.00", "0.00", "línea inventada")
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',-2,10000.00),($1,'55B24L',-1,5000.00),($1,'12N5-3B',-1,1500.00)`, extra); err != nil {
		t.Fatalf("the invented mirror line must be insertable: %v", err)
	}
	commitRefusal(t, ctx, tx, "LP003")
	// The header amounts are mirrored too: a counter that returns another amount is
	// not a mirror even when its lines are.
	tx, mispaid := admitCounter(t, ctx, p, "purchase-guard-mirror-04", mixed, "-25000.00", "-25000.00", "0.00", "otro importe")
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',-2,10000.00),($1,'55B24L',-1,5000.00)`, mispaid); err != nil {
		t.Fatalf("the mispaid mirror lines must be insertable: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,3,-1.000,1000.00)`, mispaid); err != nil {
		t.Fatalf("the mispaid mirror scrap line must be insertable: %v", err)
	}
	commitRefusal(t, ctx, tx, "LP003")
	// A line of the wrong sign is not a mirror either.
	tx, wrongSign := admitCounter(t, ctx, p, "purchase-guard-sign-03", mixed, "-26000.00", "-26000.00", "0.00", "signo")
	_, err = tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',2,10000.00)`, wrongSign)
	execRefusal(t, err, "LP005")
	_ = tx.Rollback(ctx)
	// A complete counter-document of both kinds is admitted and nets out exactly.
	tx, mixedCounter := admitCounter(t, ctx, p, "purchase-guard-mirror-05", mixed, "-26000.00", "-26000.00", "0.00", "pesaje del día")
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',-2,10000.00),($1,'55B24L',-1,5000.00)`, mixedCounter); err != nil {
		t.Fatalf("the mirroring used lines must be admitted: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,3,-1.000,1000.00)`, mixedCounter); err != nil {
		t.Fatalf("the mirroring scrap line must be admitted: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a complete counter-document must commit: %v", err)
	}
	var netUsed, netScrap string
	if err := p.QueryRow(ctx, `SELECT sum(quantity)::text FROM purchase_used_lines WHERE purchase_id IN ($1,$2)`, mixed, mixedCounter).Scan(&netUsed); err != nil || netUsed != "0" {
		t.Fatalf("the counter must net out the received units: %q %v", netUsed, err)
	}
	if err := p.QueryRow(ctx, `SELECT sum(amount)::text FROM purchase_scrap_lines WHERE purchase_id IN ($1,$2)`, mixed, mixedCounter).Scan(&netScrap); err != nil || netScrap != "0.00" {
		t.Fatalf("the counter must net out the received value: %q %v", netScrap, err)
	}

	// One original, one counter-document: the second is LP004, and a counter-document
	// is never reversed itself.
	_, err = p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,reverses_purchase_id,reason,created_by_account_id)
 VALUES('purchase-guard-twice-01',2,-75000.00,-75000.00,0.00,$1,'otra vez',2)`, used)
	execRefusal(t, err, "LP004")
	_, err = p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,reverses_purchase_id,reason,created_by_account_id)
 VALUES('purchase-guard-twice-02',2,-75000.00,-75000.00,0.00,$1,'revertir la reversa',2)`, counter)
	execRefusal(t, err, "LP004")

	// The documents are immutable: no update, no delete, no truncate, on either kind
	// of line and on the reference data.
	for _, statement := range []string{
		`UPDATE purchases SET note='otra'`,
		`DELETE FROM purchases`,
		`TRUNCATE purchases`,
		`UPDATE purchase_used_lines SET quantity=1`,
		`DELETE FROM purchase_used_lines`,
		`TRUNCATE purchase_used_lines`,
		`UPDATE purchase_scrap_lines SET kg=1`,
		`DELETE FROM purchase_scrap_lines`,
		`TRUNCATE purchase_scrap_lines`,
		`UPDATE materials SET name='Oro'`,
		`DELETE FROM materials`,
		`TRUNCATE materials`,
	} {
		if _, err := p.Exec(ctx, statement); err == nil {
			t.Fatalf("a purchase never changes: %s", statement)
		}
	}
	t.Logf("032: admitted, mirrored and refused documents behave as the contract says")
}

// TestPurchaseLineInsertGuard proves a line belongs to the document it was typed in.
// The header and the counter-document are judged at commit, but that check lives on
// `purchases` and never sees a row appended to an already committed document: the
// append would leave the header total stale and break the reversal mirror. Every line
// insert therefore re-checks the whole document at commit, and an append is refused.
func TestPurchaseLineInsertGuard(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 32)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}

	// A document of both kinds closes normally: the guards are deferred, so they judge
	// the whole document once every line of it is stored, and never a line alone.
	tx, document := admitPurchase(t, ctx, p, "purchase-line-guard-01", "80000.00", "60000.00", "20000.00")
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',2,25000.00)`, document); err != nil {
		t.Fatalf("the used line must be admitted: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,1,4.000,7500.00)`, document); err != nil {
		t.Fatalf("the scrap line must be admitted: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a document whose lines add up to its total must commit: %v", err)
	}
	if total := purchaseLinesTotal(t, ctx, p, document); total != "80000.00" {
		t.Fatalf("the committed document must keep its declared value: %q", total)
	}

	// A used line appended after that document committed is refused at commit with the
	// line guard's own SQLSTATE, and the append is not persisted: the document keeps the
	// one used line and the value it was closed with.
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the append transaction could not start")
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'55B24L',1,10000.00)`, document); err != nil {
		t.Fatalf("the appended used line must be insertable before commit: %v", err)
	}
	commitRefusal(t, ctx, tx, "LP002")
	var usedLines string
	if err := p.QueryRow(ctx, `SELECT string_agg(model,',' ORDER BY model) FROM purchase_used_lines WHERE purchase_id=$1`, document).Scan(&usedLines); err != nil || usedLines != "NS60ZL" {
		t.Fatalf("an appended used line must not be persisted: %q %v", usedLines, err)
	}
	if total := purchaseLinesTotal(t, ctx, p, document); total != "80000.00" {
		t.Fatalf("a refused used append must leave the value untouched: %q", total)
	}

	// The same for a scrap line: an appended kilogram is refused and never stored.
	tx, err = p.Begin(ctx)
	if err != nil {
		t.Fatal("the append transaction could not start")
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,2,1.000,1000.00)`, document); err != nil {
		t.Fatalf("the appended scrap line must be insertable before commit: %v", err)
	}
	commitRefusal(t, ctx, tx, "LP002")
	var scrapLines string
	if err := p.QueryRow(ctx, `SELECT string_agg(material_id::text,',' ORDER BY material_id) FROM purchase_scrap_lines WHERE purchase_id=$1`, document).Scan(&scrapLines); err != nil || scrapLines != "1" {
		t.Fatalf("an appended scrap line must not be persisted: %q %v", scrapLines, err)
	}
	if total := purchaseLinesTotal(t, ctx, p, document); total != "80000.00" {
		t.Fatalf("a refused scrap append must leave the value untouched: %q", total)
	}

	// The counter-document is still admitted, still mirrors both kinds of its original
	// and still nets it out exactly: the closed document did not become uncorrectable.
	tx, counter := admitCounter(t, ctx, p, "purchase-line-guard-counter-01", document, "-80000.00", "-60000.00", "-20000.00", "pesaje mal tipeado")
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',-2,25000.00)`, counter); err != nil {
		t.Fatalf("the mirrored used line must be admitted: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,1,-4.000,7500.00)`, counter); err != nil {
		t.Fatalf("the mirrored scrap line must be admitted: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a mirroring counter-document must commit: %v", err)
	}
	if total := purchaseLinesTotal(t, ctx, p, counter); total != "-80000.00" {
		t.Fatalf("the counter-document must negate the value of its original: %q", total)
	}
	var netUsed, netScrap string
	if err := p.QueryRow(ctx, `SELECT sum(quantity)::text FROM purchase_used_lines WHERE purchase_id IN ($1,$2)`, document, counter).Scan(&netUsed); err != nil || netUsed != "0" {
		t.Fatalf("the counter must net out the received units: %q %v", netUsed, err)
	}
	if err := p.QueryRow(ctx, `SELECT (coalesce(sum(kg),0))::text FROM purchase_scrap_lines WHERE purchase_id IN ($1,$2)`, document, counter).Scan(&netScrap); err != nil || netScrap != "0.000" {
		t.Fatalf("the counter must net out the received weight: %q %v", netScrap, err)
	}
	t.Logf("032: a closed document admits no further line and its reversal still mirrors it")
}

// purchaseLinesTotal is the persisted value of one document, the sum of both line
// kinds: the figure its header total must keep matching.
func purchaseLinesTotal(t *testing.T, ctx context.Context, p *pgxpool.Pool, document int64) string {
	t.Helper()
	var total string
	if err := p.QueryRow(ctx, `SELECT (coalesce((SELECT sum(amount) FROM purchase_used_lines WHERE purchase_id=$1),0)
         + coalesce((SELECT sum(amount) FROM purchase_scrap_lines WHERE purchase_id=$1),0))::text`, document).Scan(&total); err != nil {
		t.Fatalf("the value of the document lines could not be read: %v", err)
	}
	return total
}

// admitPurchase starts one document of branch 2 with the asked settlement and leaves
// the transaction to the caller, so an immediate refusal is observed where it happens
// and the deferred one at commit.
func admitPurchase(t *testing.T, ctx context.Context, p *pgxpool.Pool, key, total, cash, transfer string) (pgx.Tx, int64) {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the purchase transaction could not start")
	}
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES($1,2,$2,$3,$4,2) RETURNING id`, key, total, cash, transfer).Scan(&id); err != nil {
		t.Fatalf("the purchase header could not be stored: %v", err)
	}
	// A failed assertion must not leave the document's row locks open, because the
	// fixture pool waits for every connection to come back.
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return tx, id
}

// admitCounter starts the counter-document of one persisted original.
func admitCounter(t *testing.T, ctx context.Context, p *pgxpool.Pool, key string, original int64, total, cash, transfer, reason string) (pgx.Tx, int64) {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the counter-document transaction could not start")
	}
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,reverses_purchase_id,reason,created_by_account_id)
 VALUES($1,2,$2,$3,$4,$5,$6,2) RETURNING id`, key, total, cash, transfer, original, reason).Scan(&id); err != nil {
		t.Fatalf("the counter-document header could not be stored: %v", err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return tx, id
}
