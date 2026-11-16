package auth_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
)

// branchFunds is one installation with its three accounts and the administrator
// signed in: the state the founding of a branch is reached from. The branch it
// creates is the fourth location, as upstream allocation states.
type branchFunds struct {
	t       *testing.T
	ctx     context.Context
	pool    *pgxpool.Pool
	service *auth.Service
	token   string
}

func newBranchFunds(t *testing.T) *branchFunds {
	t.Helper()
	f := &branchFunds{t: t, ctx: context.Background(), pool: testpg.Open(t)}
	if err := bootstrap.Initialize(f.ctx, f.pool, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	creds := make([]bootstrap.Credentials, 3)
	for i := range creds {
		creds[i] = bootstrap.Credentials{Username: fmt.Sprintf("operator_%d", i), Password: testpg.Random(t)}
	}
	if err := bootstrap.Provision(f.ctx, f.pool, creds); err != nil {
		t.Fatal(err)
	}
	// The administrator of the warehouse is the one the founding is signed by, and
	// a completed initial password change is what Administrator admits.
	if _, err := f.pool.Exec(f.ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal(err)
	}
	var err error
	if f.service, err = auth.New(f.pool, nil); err != nil {
		t.Fatal(err)
	}
	if _, f.token, err = f.service.Login(f.ctx, creds[0].Username, creds[0].Password, "192.0.2.1", ""); err != nil {
		t.Fatal(err)
	}
	return f
}

// branches lists the live locations by identity, so "no branch was created" is
// one comparison instead of a promise about a row.
func (f *branchFunds) branches() []int {
	f.t.Helper()
	rows, err := f.pool.Query(f.ctx, `SELECT id FROM locations WHERE deleted_at IS NULL ORDER BY id`)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	var ids []int
	for rows.Next() {
		var id int
		if err = rows.Scan(&id); err != nil {
			f.t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err = rows.Err(); err != nil {
		f.t.Fatal(err)
	}
	return ids
}

// openings is the whole ledger of a branch as one value: the row the founding
// wrote, with the amount and the administrator it is signed by.
func (f *branchFunds) openings(branch int) (drawer, fund string) {
	f.t.Helper()
	if err := f.pool.QueryRow(f.ctx, `SELECT coalesce(string_agg(kind||':'||amount::text||':'
         ||created_by_account_id||':'||description,',' ORDER BY id),'')
         FROM branch_cash_movements WHERE branch_location_id=$1`, branch).Scan(&drawer); err != nil {
		f.t.Fatalf("the drawer of branch %d could not be read: %v", branch, err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT coalesce(string_agg(kind||':'||amount::text||':'
         ||created_by_account_id||':'||description,',' ORDER BY id),'')
         FROM branch_fund_movements WHERE branch_location_id=$1`, branch).Scan(&fund); err != nil {
		f.t.Fatalf("the fund of branch %d could not be read: %v", branch, err)
	}
	return drawer, fund
}

// balances reads the two boxes of a branch from the views that own their
// arithmetic, so no test states a balance a second way.
func (f *branchFunds) balances(branch int) (drawer, fund string) {
	f.t.Helper()
	if err := f.pool.QueryRow(f.ctx, `SELECT coalesce(sum(effective),0)::numeric(12,2)::text
         FROM branch_cash_ledger WHERE branch_location_id=$1 AND closing_id IS NULL`,
		branch).Scan(&drawer); err != nil {
		f.t.Fatalf("the drawer of branch %d could not be read: %v", branch, err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT coalesce(sum(effective),0)::numeric(12,2)::text
         FROM purchase_fund_ledger WHERE branch_location_id=$1`, branch).Scan(&fund); err != nil {
		f.t.Fatalf("the fund of branch %d could not be read: %v", branch, err)
	}
	return drawer, fund
}

// TestAdministrationCreateBranchFoundstheBranchWithBothAmounts proves S1, S2, S4
// and S12 on a live database: the administration states the two amounts, and the
// branch it creates is born with them -- the drawer's opening cash and the
// purchase fund -- as two movements of their ledgers signed by the administrator
// that creates it. One transaction: the branch and its money exist together.
func TestAdministrationCreateBranchFoundstheBranchWithBothAmounts(t *testing.T) {
	f := newBranchFunds(t)
	location, err := f.service.CreateBranch(f.ctx, f.token, "Sucursal C", "500.00", "300.00")
	if err != nil {
		t.Fatalf("the branch must be founded: %v", err)
	}
	if location != (auth.Location{ID: 4, Name: "Sucursal C"}) {
		t.Fatalf("the founding returns the created location, got %+v", location)
	}
	if got := f.branches(); len(got) != 4 || got[3] != 4 {
		t.Fatalf("the branch is the next identity of the catalogue, got %v", got)
	}
	// The two openings are movements of the two books (S4, S2), each one signed by
	// the administrator -- account 1 is the only one 014 leaves.
	drawer, fund := f.openings(4)
	if !strings.HasPrefix(drawer, "aporte:500.00:1:") || !strings.Contains(drawer, "inicial de caja") {
		t.Fatalf("the drawer's opening is an aporte of 500.00 signed by the admin, got %q", drawer)
	}
	if !strings.HasPrefix(fund, "aporte:300.00:1:") || !strings.Contains(fund, "inicial de compras") {
		t.Fatalf("the fund's opening is an aporte of 300.00 signed by the admin, got %q", fund)
	}
	if cash, purchase := f.balances(4); cash != "500.00" || purchase != "300.00" {
		t.Fatalf("the branch is born with the stated money, got %s and %s", cash, purchase)
	}
}

// TestAdministrationCreateBranchRequiresBothAmounts proves S1 and S13: an amount
// is mandatory and it is canonical decimal text -- the exact text the database
// stores, never an approximation of what the caller meant. A refusal leaves no
// branch and no movement behind, because the founding is one transaction (S12).
func TestAdministrationCreateBranchRequiresBothAmounts(t *testing.T) {
	f := newBranchFunds(t)
	before := f.branches()
	for _, refused := range []struct{ name, cash, fund string }{
		{"both amounts missing", "", ""},
		{"the opening cash missing", "", "300.00"},
		{"the purchase fund missing", "500.00", ""},
		// Zero is a valid answer, but only stated as the canonical amount.
		{"an empty amount that is not zero", " ", "300.00"},
		// The canonical form is two decimals with no padding and no sign.
		{"an integer without decimals", "500", "300.00"},
		{"one decimal", "500.0", "300.00"},
		{"three decimals", "500.000", "300.00"},
		{"a padded amount", "0500.00", "300.00"},
		{"zero padded", "00.00", "300.00"},
		{"a negative amount", "-500.00", "300.00"},
		{"a signed amount", "+500.00", "300.00"},
		{"a decimal comma", "500,00", "300.00"},
		{"an exponent", "5e2", "300.00"},
		{"padded text", " 500.00", "300.00"},
		{"text that is not an amount", "quinientos", "300.00"},
		// The whole range of numeric(12,2) and not one digit more.
		{"more integral digits than the column holds", "10000000000.00", "300.00"},
	} {
		t.Run(refused.name, func(t *testing.T) {
			_, err := f.service.CreateBranch(f.ctx, f.token, "Sucursal C", refused.cash, refused.fund)
			if !errors.Is(err, auth.ErrAdminInvalid) {
				t.Fatalf("%s must be refused as invalid input, got %v", refused.name, err)
			}
			if got := f.branches(); fmt.Sprint(got) != fmt.Sprint(before) {
				t.Fatalf("%s must create no branch, got %v before %v", refused.name, got, before)
			}
			var rows int
			if err := f.pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM branch_cash_movements)
                 + (SELECT count(*) FROM branch_fund_movements)`).Scan(&rows); err != nil ||
				rows != 0 {
				t.Fatalf("%s must write no movement, got %d rows: %v", refused.name, rows, err)
			}
		})
	}
	// The name rules of the seam are untouched: an invalid or reserved name is
	// invalid input whatever the amounts state.
	for _, name := range []string{"", " ", "   Almacén  ", strings.Repeat("a", 129), "Su\x00cursal"} {
		if _, err := f.service.CreateBranch(f.ctx, f.token, name, "500.00", "300.00"); !errors.Is(err, auth.ErrAdminInvalid) {
			t.Fatalf("the name %q must still be refused, got %v", name, err)
		}
	}
	if got := f.branches(); fmt.Sprint(got) != fmt.Sprint(before) {
		t.Fatalf("a refused name must create no branch, got %v before %v", got, before)
	}
}

// TestAdministrationCreateBranchStartsWithoutMovementsForZero proves S3: 0,00 is
// the explicit answer of a branch that starts with no money, so it is admitted and
// it writes no movement -- the empty sum of a book is not a row the ledger has to
// explain. The drawer and the fund of that branch read zero.
func TestAdministrationCreateBranchStartsWithoutMovementsForZero(t *testing.T) {
	f := newBranchFunds(t)
	location, err := f.service.CreateBranch(f.ctx, f.token, "Sucursal D", "0.00", "0.00")
	if err != nil {
		t.Fatalf("0,00 is an explicit and valid answer: %v", err)
	}
	if location != (auth.Location{ID: 4, Name: "Sucursal D"}) {
		t.Fatalf("a branch of 0,00 is still a branch, got %+v", location)
	}
	if drawer, fund := f.openings(4); drawer != "" || fund != "" {
		t.Fatalf("a founding of 0,00 writes no movement, got %q and %q", drawer, fund)
	}
	if cash, purchase := f.balances(4); cash != "0.00" || purchase != "0.00" {
		t.Fatalf("the branch starts at zero, got %s and %s", cash, purchase)
	}
}
