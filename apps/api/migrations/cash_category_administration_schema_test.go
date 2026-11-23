package migrations_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// migration063 is the administration of the motive catalogue (S3, S4, S5, S8, S10): the table gains
// the catch-all mark and the author of an archival, the database refuses to delete a motive, to
// archive the catch-all and to leave the list without a usable option, and every write of the list
// publishes a global scope the branch reads without a reload.
const migration063 = "063_cash_category_administration.sql"

// TestCashCategoryAdministrationMigrationShape reads the embedded version exactly as PostgreSQL
// receives it and asserts the contract it installs. It also asserts what the version must not do --
// rewrite a movement, restate a settlement, open a second scope or delete a row -- because the
// catalogue is global and every branch reads it.
func TestCashCategoryAdministrationMigrationShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration063)
	if err != nil {
		t.Fatal("the administration migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The two facts the square table of 061 could not state: the catch-all and the author.
		"ADD COLUMN pinned boolean NOT NULL DEFAULT false",
		"ADD COLUMN retired_by text",
		"CONSTRAINT branch_cash_categories_retirement_shape CHECK (",

		// The guards: identity, place and pin never move, nothing is deleted, the catch-all is never
		// archived, and the last offered option is never archived.
		"CREATE FUNCTION guard_branch_cash_category() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER guard_branch_cash_category_write BEFORE UPDATE OR DELETE ON branch_cash_categories",
		"ERRCODE = 'LC034'",
		"ERRCODE = 'LC035'",
		"ERRCODE = 'LC036'",
		"PERFORM pg_advisory_xact_lock(340253, 1)",

		// The scope: one global counter, seeded once, admitted by a guard that still refuses an
		// audience no location explains, and published by the table's own write.
		"CHECK (scope IN ('inventory', 'catalogue') OR scope ~ '^transfers:[1-9][0-9]{0,4}$')",
		"INSERT INTO realtime_revisions(scope) VALUES ('catalogue') ON CONFLICT (scope) DO NOTHING",
		"CREATE FUNCTION invalidate_branch_cash_categories() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER invalidate_branch_cash_categories_write",
		"AFTER INSERT OR UPDATE ON branch_cash_categories",
		"PERFORM pg_notify('luson_realtime', 'catalogue:0')",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("the administration migration must state %q", required)
		}
	}
	for _, forbidden := range []string{
		// A motive is archived, never deleted, and no movement of the drawer is rewritten by this
		// version: the history of an expense keeps the label it was recorded with.
		"DELETE FROM branch_cash_categories",
		"UPDATE branch_cash_movements",
		// One scope and one only: a second global audience would widen what a session may read. The
		// counter is keyed `catalogue`, and the `:0` form belongs to the notification only.
		"INSERT INTO realtime_revisions(scope) VALUES ('catalogue:0')",
	} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("the administration migration must not state %q", forbidden)
		}
	}
}

// categoryAdminDB is the schema of this delivery on a live database, so every guard is proved where
// it runs and not only where it is written.
func categoryAdminDB(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 63)
	return ctx, p
}

// archiveMotive writes the archival a caller would write, and returns the error instead of asserting,
// so the same call is used where the row must be archived and where it must be refused.
func archiveMotive(ctx context.Context, p *pgxpool.Pool, label, actor string) error {
	_, err := p.Exec(ctx, `UPDATE branch_cash_categories SET retired_at=now(), retired_by=$2
 WHERE label=$1`, label, actor)
	return err
}

// TestMotiveCatalogueIsArchivedNeverDeleted proves S3 and S10 on a live database: an archival names
// its author, the catch-all is refused with its own code, a delete is refused with its own code, and a
// rename of the catch-all stays allowed -- the rule is the structure of the row, not its label.
func TestMotiveCatalogueIsArchivedNeverDeleted(t *testing.T) {
	ctx, p := categoryAdminDB(t)

	// The catch-all can be renamed: a guard that looked for the label would break here.
	if _, err := p.Exec(ctx, `UPDATE branch_cash_categories SET label='Otros' WHERE pinned`); err != nil {
		t.Fatalf("the catch-all must be renamable: %v", err)
	}
	renamed := tryRefusal(t, ctx, p, `UPDATE branch_cash_categories SET retired_at=now(),
 retired_by='dev_almacen' WHERE pinned`)
	if renamed == "" || !strings.Contains(renamed, "catch-all") {
		t.Fatalf("the catch-all must never be archived, got %q", renamed)
	}
	// Archiving an ordinary motive is a fact with an author, and it keeps the row.
	if err := archiveMotive(ctx, p, "Agua", "dev_almacen"); err != nil {
		t.Fatalf("an ordinary motive must be archivable: %v", err)
	}
	var by string
	if err := p.QueryRow(ctx, `SELECT retired_by FROM branch_cash_categories WHERE label='Agua'`).Scan(&by); err != nil || by != "dev_almacen" {
		t.Fatalf("the archival must name its author, got %q (%v)", by, err)
	}
	deleted := tryRefusal(t, ctx, p, `DELETE FROM branch_cash_categories WHERE label='Agua'`)
	if !strings.Contains(deleted, "never deleted") {
		t.Fatalf("a motive must never be deleted, got %q", deleted)
	}
	// The list is never left without an option: with every other motive archived, the catch-all is
	// still offered, so the branch can always record an expense.
	if _, err := p.Exec(ctx, `UPDATE branch_cash_categories SET retired_at=now(), retired_by='dev_almacen'
 WHERE NOT pinned AND retired_at IS NULL`); err != nil {
		t.Fatalf("the ordinary motives must be archivable: %v", err)
	}
	var offered int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_cash_categories WHERE retired_at IS NULL`).Scan(&offered); err != nil || offered != 1 {
		t.Fatalf("the list must keep exactly the catch-all offered, got %d (%v)", offered, err)
	}
}

// TestMotiveCatalogueWritePublishesItsOwnScope proves S8 on a live database: writing the list bumps
// the global catalogue counter and leaves the inventory counter alone, so a branch that listens learns
// the change without reading anything of its own stock again.
func TestMotiveCatalogueWritePublishesItsOwnScope(t *testing.T) {
	ctx, p := categoryAdminDB(t)
	revision := func(scope string) int64 {
		t.Helper()
		var n int64
		if err := p.QueryRow(ctx, `SELECT revision FROM realtime_revisions WHERE scope=$1`, scope).Scan(&n); err != nil {
			t.Fatalf("the %s counter must exist: %v", scope, err)
		}
		return n
	}
	catalogue, inventory := revision("catalogue"), revision("inventory")
	if _, err := p.Exec(ctx, `INSERT INTO branch_cash_categories(label,sort_order)
 SELECT 'Reposición de estantería', coalesce(max(sort_order),0)+1 FROM branch_cash_categories`); err != nil {
		t.Fatalf("a motive must be insertable: %v", err)
	}
	if got := revision("catalogue"); got != catalogue+1 {
		t.Fatalf("a write of the list must bump its own counter once, got %d from %d", got, catalogue)
	}
	if got := revision("inventory"); got != inventory {
		t.Fatalf("a write of the list must not touch the inventory counter, got %d from %d", got, inventory)
	}
	if err := archiveMotive(ctx, p, "Reposición de estantería", "dev_almacen"); err != nil {
		t.Fatalf("the motive must be archivable: %v", err)
	}
	if got := revision("catalogue"); got != catalogue+2 {
		t.Fatalf("an archival must bump the counter once too, got %d from %d", got, catalogue)
	}
}

// tryRefusal runs one statement in a transaction of its own and returns the message of the refusal it
// must produce, or an empty string when the database accepted it.
func tryRefusal(t *testing.T, ctx context.Context, p *pgxpool.Pool, statement string) string {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the refusal could not be probed")
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, statement); err != nil {
		return err.Error()
	}
	return ""
}
