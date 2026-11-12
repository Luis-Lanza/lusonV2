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

// 041 is additive on top of an applied migration: it replaces one function whole and adds
// no table, no trigger and no column of its own.
func TestBranchFreezeApprovalSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile("041_branch_freeze_approval.sql")
	if err != nil {
		t.Fatal("the approval guard migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		"CREATE OR REPLACE FUNCTION admit_transfer_move_when_branches_operating()",
		"IF OLD.status = 'pending' AND NEW.status = 'approved' THEN",
		"ELSIF OLD.status = 'approved' AND NEW.status = 'in_transit' THEN",
		"ELSIF OLD.status = 'in_transit' AND NEW.status = 'received' THEN",
		"PERFORM assert_branch_not_frozen(OLD.origin_location_id);",
		"PERFORM assert_branch_not_frozen(OLD.destination_location_id);",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("the approval guard must state %q", required)
		}
	}
	for _, forbidden := range []string{"CREATE TABLE", "ALTER TABLE", "CREATE TRIGGER", "DROP "} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("041 only replaces a function, it must not use %q", forbidden)
		}
	}
}

// reservedOf reads the units a branch holds for a variant, which is what the approval
// raises and what a settlement refuses to close over.
func reservedOf(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch, variant int) int64 {
	t.Helper()
	var reserved int64
	if err := p.QueryRow(ctx, `SELECT reserved FROM inventory_balances
 WHERE location_id=$1 AND variant_id=$2`, branch, variant).Scan(&reserved); err != nil {
		t.Fatalf("the reservation of branch %d could not be read: %v", branch, err)
	}
	return reserved
}

// approveRequest mirrors the store's approval and returns its error instead of failing, so a
// refusal can be asserted. The reservation is raised before the status moves, like the store
// does it: the whole transaction is what the guard aborts.
func approveRequest(ctx context.Context, p *pgxpool.Pool, id int64) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	for _, statement := range []string{
		`INSERT INTO transfer_request_allocations(request_id,variant_id,quantity)
 SELECT request_id,variant_id,quantity FROM transfer_request_items WHERE request_id=$1 ORDER BY variant_id`,
		`UPDATE inventory_balances b SET reserved=b.reserved+i.quantity
 FROM transfer_request_items i JOIN transfer_requests r ON r.id=i.request_id
 WHERE i.request_id=$1 AND b.location_id=r.origin_location_id AND b.variant_id=i.variant_id`,
		`UPDATE transfer_requests SET status='approved' WHERE id=$1`,
	} {
		if _, err := tx.Exec(ctx, statement, id); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// S3: the approval of a request is the step that reserves the origin's units, so a frozen
// branch must be refused there and not only at dispatch. Without it the settlement becomes
// unclosable — the closure refuses any open reservation — until somebody cancels the request.
func TestBranchFreezeRefusesTheApprovalOfATransfer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 41)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	// Branch 2 ships to the warehouse: it is the origin, so it is the branch whose units the
	// approval reserves and the one that gets settled.
	if _, err := p.Exec(ctx, `INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(1,1,20,0),(2,1,10,0)`); err != nil {
		t.Fatal("the stock could not be provisioned")
	}

	// Both requests are created while the branch still operates: a frozen branch cannot even
	// ask for stock, so the case the guard has to cover is an approval of a request that
	// already existed when the settlement opened.
	operating := createTransfer(t, ctx, p, 2, "send_to_warehouse", 2, 1, 1, "freeze-approval-open", 2)
	waiting := createTransfer(t, ctx, p, 2, "send_to_warehouse", 2, 1, 1, "freeze-approval-live", 3)

	// While the branch operates, the approval reserves its units and moves the request.
	if err := approveRequest(ctx, p, operating); err != nil {
		t.Fatalf("an operating branch must be able to have its transfer approved: %v", err)
	}
	if got := reservedOf(t, ctx, p, 2, 1); got != 2 {
		t.Fatalf("the approval must reserve the origin's units, got %d", got)
	}

	// With a settlement live, approving the request that was already waiting is refused
	// before it can hold stock of the frozen branch.
	openSettlement(t, ctx, p, 2)
	err := approveRequest(ctx, p, waiting)
	if err == nil {
		t.Fatal("a frozen branch must not have stock reserved for it")
	}
	if !strings.Contains(err.Error(), "LC001") {
		t.Fatalf("the refusal must be the freeze code, got %v", err)
	}
	if got := reservedOf(t, ctx, p, 2, 1); got != 2 {
		t.Fatalf("a refused approval reserves nothing, got %d", got)
	}
	var status string
	if err := p.QueryRow(ctx, `SELECT status FROM transfer_requests WHERE id=$1`, waiting).Scan(&status); err != nil {
		t.Fatalf("the request could not be read: %v", err)
	}
	if status != "pending" {
		t.Fatalf("a refused approval leaves the request pending, got %s", status)
	}
}
