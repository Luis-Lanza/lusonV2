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
	// tokens is one live session per provisioned account, in account order: the administrator is
	// tokens[0] and the branches are the rest, which is what a refusal signed by a branch reads.
	tokens []string
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
	f.tokens = []string{f.token}
	for i := 1; i < len(creds); i++ {
		_, token, err := f.service.Login(f.ctx, creds[i].Username, creds[i].Password, fmt.Sprintf("192.0.2.%d", i+1), "")
		if err != nil {
			t.Fatal(err)
		}
		f.tokens = append(f.tokens, token)
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

// loadRows counts the two books of the installation, so "a refused load writes nothing" and "0,00
// writes nothing" are one comparison each instead of a promise about a row.
func (f *branchFunds) loadRows() (drawer, fund int) {
	f.t.Helper()
	if err := f.pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM branch_cash_movements),
         (SELECT count(*) FROM branch_fund_movements)`).Scan(&drawer, &fund); err != nil {
		f.t.Fatalf("the rows of the two books could not be counted: %v", err)
	}
	return drawer, fund
}

// freeze opens the live settlement of a branch, which is what freezes it: the warehouse is the only
// account that settles and the commission rate is a fact of the proposal, so the opener states none.
func (f *branchFunds) freeze(branch int) int64 {
	f.t.Helper()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO branch_settings(branch_location_id,
         commission_rate_percent,updated_by_account_id) VALUES($1,12.50,1)
         ON CONFLICT (branch_location_id) DO UPDATE SET commission_rate_percent=12.50`,
		int16(branch)); err != nil {
		f.t.Fatalf("the commission of branch %d could not be configured: %v", branch, err)
	}
	var closing int64
	if err := f.pool.QueryRow(f.ctx, `INSERT INTO branch_closings(branch_location_id,period_start,
         opened_by_account_id) VALUES($1,now(),1) RETURNING id`, int16(branch)).Scan(&closing); err != nil {
		f.t.Fatalf("the settlement of branch %d could not be opened: %v", branch, err)
	}
	return closing
}

// TestAdministrationLoadBranchFundsWritesBothAportes proves S1, S3, S4, S6 and S9 on a live
// database: from the administration the warehouse states the two funds of a branch that already
// exists, and the two books receive one aporte each, signed by the warehouse; the branch keeps
// operating afterwards, because a load is not a settlement.
func TestAdministrationLoadBranchFundsWritesBothAportes(t *testing.T) {
	f := newBranchFunds(t)
	if err := f.service.LoadBranchFunds(f.ctx, f.token, 2, "5000.00", "3000.00"); err != nil {
		t.Fatalf("the funds of an existing branch must be loadable: %v", err)
	}
	drawer, fund := f.openings(2)
	if !strings.HasPrefix(drawer, "aporte:5000.00:1:") || !strings.Contains(drawer, "caja operativa") {
		t.Fatalf("the drawer receives an aporte of 5000.00 signed by the warehouse, got %q", drawer)
	}
	if !strings.HasPrefix(fund, "aporte:3000.00:1:") || !strings.Contains(fund, "compras") {
		t.Fatalf("the fund receives an aporte of 3000.00 signed by the warehouse, got %q", fund)
	}
	if cash, purchase := f.balances(2); cash != "5000.00" || purchase != "3000.00" {
		t.Fatalf("the branch holds the money it was given, got %s and %s", cash, purchase)
	}
	// One act states both amounts and writes the two movements of the warehouse: neither the drawer nor
	// the fund receives a second aporte of the load.
	if one, other := f.loadRows(); one != 1 || other != 1 {
		t.Fatalf("the load writes one movement of each book, got %d and %d", one, other)
	}
	// S6: the branch is not frozen and its own account still records its own movement.
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,
         amount,description,created_by_account_id) VALUES(2,'gasto',100.00,'Gasto del dia',2)`); err != nil {
		t.Fatalf("the branch must keep operating after a load: %v", err)
	}
	if cash, _ := f.balances(2); cash != "4900.00" {
		t.Fatalf("the drawer is the load minus what the branch spent, got %s", cash)
	}
}

// TestAdministrationLoadBranchFundsRequiresCanonicalAmounts proves S2, S4 and S10 on a live
// database: both amounts are mandatory and each is the canonical decimal text the database stores.
// A refusal writes no act and no movement.
func TestAdministrationLoadBranchFundsRequiresCanonicalAmounts(t *testing.T) {
	f := newBranchFunds(t)
	beforeDrawer, beforeFund := f.loadRows()
	for _, refused := range []struct {
		name, cash, fund string
		branch           int
		err              error
	}{
		{"both amounts missing", "", "", 2, auth.ErrAdminInvalid},
		{"the opening cash missing", "", "300.00", 2, auth.ErrAdminInvalid},
		{"the purchase fund missing", "500.00", "", 2, auth.ErrAdminInvalid},
		{"an empty amount that is not zero", " ", "300.00", 2, auth.ErrAdminInvalid},
		{"an integer without decimals", "500", "300.00", 2, auth.ErrAdminInvalid},
		{"one decimal", "500.0", "300.00", 2, auth.ErrAdminInvalid},
		{"three decimals", "500.000", "300.00", 2, auth.ErrAdminInvalid},
		{"a padded amount", "0500.00", "300.00", 2, auth.ErrAdminInvalid},
		{"a negative amount", "-500.00", "300.00", 2, auth.ErrAdminInvalid},
		{"a decimal comma", "500,00", "300.00", 2, auth.ErrAdminInvalid},
		{"more integral digits than the column holds", "10000000000.00", "300.00", 2, auth.ErrAdminInvalid},
		// The warehouse is not a branch and an unknown identity is no branch either.
		{"the warehouse", "500.00", "300.00", 1, auth.ErrAdminInvalid},
		{"a branch that does not exist", "500.00", "300.00", 99, auth.ErrAdminNotFound},
	} {
		t.Run(refused.name, func(t *testing.T) {
			if err := f.service.LoadBranchFunds(f.ctx, f.token, refused.branch, refused.cash, refused.fund); !errors.Is(err, refused.err) {
				t.Fatalf("%s must be refused as %v, got %v", refused.name, refused.err, err)
			}
			if drawer, fund := f.loadRows(); drawer != beforeDrawer || fund != beforeFund {
				t.Fatalf("%s must write nothing, got %d/%d rows", refused.name, drawer, fund)
			}
		})
	}
}

// TestAdministrationLoadBranchFundsStartsWithoutMovementsForZero proves S9: 0,00 is a stated answer
// and not a missing one, so the two zeroes are admitted and they write no act and no movement.
func TestAdministrationLoadBranchFundsStartsWithoutMovementsForZero(t *testing.T) {
	f := newBranchFunds(t)
	if err := f.service.LoadBranchFunds(f.ctx, f.token, 2, "0.00", "0.00"); err != nil {
		t.Fatalf("0,00 is an explicit and valid answer: %v", err)
	}
	if drawer, fund := f.loadRows(); drawer != 0 || fund != 0 {
		t.Fatalf("a load of 0,00 writes nothing, got %d/%d rows", drawer, fund)
	}
	if cash, purchase := f.balances(2); cash != "0.00" || purchase != "0.00" {
		t.Fatalf("the branch still holds nothing, got %s and %s", cash, purchase)
	}
}

// TestAdministrationLoadBranchFundsRefusesABranchAccount proves S4: only the warehouse loads funds.
// A branch account is refused before anything is written, for itself and for another branch.
func TestAdministrationLoadBranchFundsRefusesABranchAccount(t *testing.T) {
	f := newBranchFunds(t)
	for _, token := range []string{f.tokens[1], f.tokens[2]} {
		for _, branch := range []int{2, 3} {
			if err := f.service.LoadBranchFunds(f.ctx, token, branch, "500.00", "300.00"); !errors.Is(err, auth.ErrAdminForbidden) {
				t.Fatalf("a branch account must not load the funds of branch %d, got %v", branch, err)
			}
		}
	}
	if drawer, fund := f.loadRows(); drawer != 0 || fund != 0 {
		t.Fatalf("a refused load writes nothing, got %d/%d rows", drawer, fund)
	}
}

// TestAdministrationLoadBranchFundsRefusesARetiredBranch proves S4 on a live database: a branch that
// was given up is not a place to put money in. The branch is founded empty and retired, so it carries
// no stock and no users and the refusal under test is the load's and not the retirement's.
func TestAdministrationLoadBranchFundsRefusesARetiredBranch(t *testing.T) {
	f := newBranchFunds(t)
	branch, err := f.service.CreateBranch(f.ctx, f.token, "Sucursal C", "0.00", "0.00")
	if err != nil {
		t.Fatalf("the branch could not be founded: %v", err)
	}
	if err = f.service.RetireBranch(f.ctx, f.token, int64(branch.ID)); err != nil {
		t.Fatalf("the branch could not be retired: %v", err)
	}
	if err = f.service.LoadBranchFunds(f.ctx, f.token, branch.ID, "500.00", "300.00"); !errors.Is(err, auth.ErrAdminNotFound) {
		t.Fatalf("a load of a retired branch must be refused as not found, got %v", err)
	}
	if drawer, fund := f.loadRows(); drawer != 0 || fund != 0 {
		t.Fatalf("a load of a retired branch writes nothing, got %d/%d rows", drawer, fund)
	}
}

// TestAdministrationLoadBranchFundsRefusesAFrozenBranch proves S5: while the branch is being
// counted, the load is refused with the settlement's own refusal -- the one the branch reads when it
// cannot operate -- and nothing is written. The other branch is not frozen and is loaded.
func TestAdministrationLoadBranchFundsRefusesAFrozenBranch(t *testing.T) {
	f := newBranchFunds(t)
	f.freeze(2)
	if err := f.service.LoadBranchFunds(f.ctx, f.token, 2, "500.00", "300.00"); !errors.Is(err, auth.ErrBranchFrozen) {
		t.Fatalf("a load of a frozen branch must be refused as frozen, got %v", err)
	}
	if drawer, fund := f.loadRows(); drawer != 0 || fund != 0 {
		t.Fatalf("a load of a frozen branch writes nothing, got %d/%d rows", drawer, fund)
	}
	if err := f.service.LoadBranchFunds(f.ctx, f.token, 3, "500.00", "300.00"); err != nil {
		t.Fatalf("the other branch is not frozen and must be loaded: %v", err)
	}
}

// TestAdministrationBranchBooksPublishTheTwoBalances proves S7 and S8: the administration reads the
// two balances of every live branch by branch, from the books and with the terms the drawer's own
// rule reads, and it says which branch a live settlement has frozen. The warehouse is not a branch
// and owns no drawer, so it is not published here.
func TestAdministrationBranchBooksPublishTheTwoBalances(t *testing.T) {
	f := newBranchFunds(t)
	books, err := f.service.ListBranchBooks(f.ctx, f.token)
	if err != nil {
		t.Fatalf("the balances of the branches must be readable: %v", err)
	}
	// One row per live branch, ordered by identity, and no row for the warehouse (1).
	if len(books) != 2 || books[0].BranchID != 2 || books[1].BranchID != 3 {
		t.Fatalf("the read publishes one row per live branch, got %+v", books)
	}
	for _, book := range books {
		if book.OpeningCash != "0.00" || book.CashSales != "0.00" || book.CashEffective != "0.00" ||
			book.FundBalance != "0.00" || book.Frozen {
			t.Fatalf("a branch that never operated reads zero and unfrozen, got %+v", book)
		}
	}
	if err := f.service.LoadBranchFunds(f.ctx, f.token, 2, "5000.00", "3000.00"); err != nil {
		t.Fatalf("the load must be admitted: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,
         amount,description,created_by_account_id) VALUES(2,'gasto',150.00,'Gasto del dia',2)`); err != nil {
		t.Fatalf("the branch must be able to record its own expense: %v", err)
	}
	books, err = f.service.ListBranchBooks(f.ctx, f.token)
	if err != nil {
		t.Fatal(err)
	}
	if books[0].CashEffective != "4850.00" || books[0].FundBalance != "3000.00" {
		t.Fatalf("the balances are the load minus the expense and the fund, got %+v", books[0])
	}
	// The drawer's terms are the ones its own rule needs, and the amounts are the canonical text the
	// books store.
	for _, amount := range []string{books[0].OpeningCash, books[0].CashSales, books[0].CashEffective,
		books[0].FundBalance} {
		if !canonicalBookAmount(amount) {
			t.Fatalf("a published term is canonical money, got %q", amount)
		}
	}
	// A live settlement is published as the freeze: the panel says the drawer's number is about to
	// change instead of presenting it as settled (S8).
	f.freeze(2)
	books, err = f.service.ListBranchBooks(f.ctx, f.token)
	if err != nil {
		t.Fatal(err)
	}
	if !books[0].Frozen || books[1].Frozen {
		t.Fatalf("only the branch being counted is frozen, got %+v", books)
	}
}

// canonicalBookAmount states the canonical money contract of the vertical: at most ten integral
// digits and exactly two decimals, never negative, padded or approximated.
func canonicalBookAmount(text string) bool {
	whole, fraction, found := strings.Cut(text, ".")
	if !found || len(fraction) != 2 || whole == "" || len(whole) > 10 {
		return false
	}
	if whole != "0" && whole[0] == '0' {
		return false
	}
	for _, ch := range whole + fraction {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}
