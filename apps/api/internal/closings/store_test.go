package closings_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/closings"
	"luson/api/internal/config"
	"luson/api/internal/pricing"
	"luson/api/internal/sales"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

// env is one isolated database with the settlement store on top of the trial catalogue.
// Without an admitted LUSON_TEST_PG_MANIFEST every test below fails closed at testpg.Open
// and that is the expected local outcome.
type env struct {
	ctx    context.Context
	pool   *pgxpool.Pool
	store  *closings.Store
	sales  *sales.Store
	prices *pricing.Store
}

// serials numbers the batteries of the fixtures below, so one database never sees a
// repeated serial in the sales it issues.
var serials atomic.Int64

func fixture(t *testing.T) *env {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("test initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("test account provisioning failed")
	}
	e := &env{ctx: ctx, pool: p, store: closings.New(p), sales: sales.New(p), prices: pricing.New(p)}
	// The trial catalogue gives every variant a fictional quantity in every location, and
	// the count sheet of an open settlement covers all of them. A settlement test needs
	// two known rows, so the branch starts from a count sheet of its own.
	e.seedStock(t, 2, map[int64]int64{1: 10, 2: 4})
	e.seedStock(t, 3, map[int64]int64{1: 5})
	// One battery priced for the branch, so a sale with the exact fractions the commission
	// tests need can be issued through the point of sale: both polarities of a battery
	// share one pair.
	for _, entry := range []int64{1, 2} {
		e.price(t, entry, "0.01", "100.00", 2)
	}
	// The rate of the branch the tests settle. The store writes it, so the fixture only
	// uses the real path.
	if _, err := e.store.ConfigureCommission(ctx, warehouse(), 2, "12.50"); err != nil {
		t.Fatalf("the branch commission could not be configured: %v", err)
	}
	return e
}

// identity is one session of an installation with one account per location.
func identity(location int) auth.Identity {
	return auth.Identity{AccountID: location, Location: auth.Location{ID: location}}
}

// warehouse is the Almacén session: it settles branches and never receives a settlement.
func warehouse() auth.Identity { return identity(1) }

// seedStock replaces the branch stock of one location by the asked quantities, so the
// count sheet of the next settlement is known.
func (e *env) seedStock(t *testing.T, location int, existing map[int64]int64) {
	t.Helper()
	if _, err := e.pool.Exec(e.ctx,
		"UPDATE inventory_balances SET existing=0,reserved=0 WHERE location_id=$1", location); err != nil {
		t.Fatal("branch stock could not be reset")
	}
	for variant, quantity := range existing {
		if _, err := e.pool.Exec(e.ctx,
			"UPDATE inventory_balances SET existing=$3 WHERE location_id=$1 AND variant_id=$2",
			location, variant, quantity); err != nil {
			t.Fatalf("branch stock of variant %d could not be set", variant)
		}
	}
}

// price writes one branch pair through the price store, so the fixture writes exactly what
// the Catálogo writes.
func (e *env) price(t *testing.T, entry int64, min, suggested string, branches ...int64) {
	t.Helper()
	if _, err := e.prices.Write(e.ctx, warehouse(), pricing.WriteInput{
		CatalogEntryID: entry,
		MinPrice:       pricing.Money(min),
		SuggestedPrice: pricing.Money(suggested),
		BranchIDs:      branches,
	}); err != nil {
		t.Fatalf("price fixture for battery %d failed: %v", entry, err)
	}
}

// entryOf reads the battery of a catalogue variant, so a test never guesses which entry a
// polarity belongs to.
func (e *env) entryOf(t *testing.T, variant int64) int64 {
	t.Helper()
	var entry int64
	if err := e.pool.QueryRow(e.ctx, "SELECT catalog_entry_id FROM catalog_variants WHERE id=$1",
		int32(variant)).Scan(&entry); err != nil {
		t.Fatal("catalogue entry read failed")
	}
	return entry
}

// sell issues one real sale in branch 2: the frozen price, the payment and the stock
// decrement are the point of sale's own, so the settlement reads the sale ledger exactly as
// the branch wrote it.
func (e *env) sell(t *testing.T, variant, quantity int64, unitPrice string, method sales.PaymentMethod) {
	t.Helper()
	total, err := sales.LineTotal(sales.Money(unitPrice), quantity)
	if err != nil {
		t.Fatalf("sale fixture amount %q is not sellable: %v", unitPrice, err)
	}
	e.sellPayments(t, variant, quantity, unitPrice, sales.Payment{Method: method, Amount: total})
}

// sellPayments issues one real sale in branch 2 with the settlement the test states, so a
// document paid with more than one method is written through the point of sale's own path
// and the settlement reads exactly what the counter wrote.
func (e *env) sellPayments(t *testing.T, variant, quantity int64, unitPrice string, payments ...sales.Payment) {
	t.Helper()
	units := make([]sales.Unit, 0, quantity)
	for i := int64(0); i < quantity; i++ {
		units = append(units, sales.Unit{SerialNumber: sales.SerialNumber(
			fmt.Sprintf("BAT-%d", serials.Add(1)))})
	}
	if _, err := e.sales.Create(e.ctx, identity(2), sales.CreateInput{
		Payments: payments,
		Customer: sales.Customer{Name: "Cliente de sucursal"},
		Lines: []sales.LineInput{{VariantID: variant, Quantity: quantity,
			UnitPrice: sales.Money(unitPrice), Units: units}},
	}); err != nil {
		t.Fatalf("sale fixture failed: %v", err)
	}
}

// expense records one small expense of the branch through the branch's own path, the way it
// records it while it operates: the ledger row is the branch's own fact and no settlement
// states it (S12).
func (e *env) expense(t *testing.T, branch int, amount, description string) closings.Expense {
	t.Helper()
	expense, err := e.store.RecordExpense(e.ctx, identity(branch), closings.Money(amount), description)
	if err != nil {
		t.Fatalf("the branch expense %q could not be recorded: %v", description, err)
	}
	return expense
}

// balance reads the stock of one branch straight from the database.
func (e *env) balance(t *testing.T, location, variant int64) (int64, int64) {
	t.Helper()
	var existing, reserved int64
	if err := e.pool.QueryRow(e.ctx,
		"SELECT existing,reserved FROM inventory_balances WHERE location_id=$1 AND variant_id=$2",
		location, variant).Scan(&existing, &reserved); err != nil {
		t.Fatal("balance read failed")
	}
	return existing, reserved
}

// scalar reads one number of the database's own state.
func (e *env) scalar(t *testing.T, query string, args ...any) int64 {
	t.Helper()
	var value int64
	if err := e.pool.QueryRow(e.ctx, query, args...).Scan(&value); err != nil {
		t.Fatalf("scalar query failed: %v", err)
	}
	return value
}

// text reads one text fact of the database's own state.
func (e *env) text(t *testing.T, query string, args ...any) string {
	t.Helper()
	var value string
	if err := e.pool.QueryRow(e.ctx, query, args...).Scan(&value); err != nil {
		t.Fatalf("text query failed: %v", err)
	}
	return value
}

// retireBranch retires one branch the way the administration does: the shipped stock is
// cleared first (a branch holding stock is never retired), then the account and finally the
// location.
func (e *env) retireBranch(t *testing.T, branch int) {
	t.Helper()
	if _, err := e.pool.Exec(e.ctx,
		"UPDATE inventory_balances SET existing=0,reserved=0 WHERE location_id=$1", branch); err != nil {
		t.Fatalf("the stock of branch %d could not be cleared: %v", branch, err)
	}
	if _, err := e.pool.Exec(e.ctx,
		"UPDATE auth_accounts SET enabled=false,deleted_at=now() WHERE location_id=$1", branch); err != nil {
		t.Fatalf("the account of branch %d could not be retired: %v", branch, err)
	}
	if _, err := e.pool.Exec(e.ctx, "UPDATE locations SET deleted_at=now() WHERE id=$1", branch); err != nil {
		t.Fatalf("branch %d could not be retired: %v", branch, err)
	}
}

// refused asserts a refusal is the asked domain error, so one refusal class never hides
// behind another.
func refused(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("expected %v, got %v", want, err)
	}
}

// countAll counts every line of the sheet with its expected quantity, so a test only
// states the lines it is interested in.
func (e *env) countAll(t *testing.T, id int64) closings.Closing {
	t.Helper()
	open, err := e.store.Read(e.ctx, warehouse(), id)
	if err != nil {
		t.Fatalf("the settlement could not be read: %v", err)
	}
	counted := make([]closings.Counted, 0, len(open.CountLines))
	for _, line := range open.CountLines {
		counted = append(counted, closings.Counted{VariantID: line.VariantID, Quantity: line.ExpectedQuantity})
	}
	after, err := e.store.Count(e.ctx, warehouse(), id, counted)
	if err != nil {
		t.Fatalf("the count sheet could not be counted: %v", err)
	}
	return after
}

// closeFirstSettlement walks the very first settlement of a branch the way the launch does
// (S11): an empty till, the counted stock left as counted, and the fund the admin declares
// as its own contribution. It is also the only way a later period has a sale window.
func (e *env) closeFirstSettlement(t *testing.T, fund string) int64 {
	t.Helper()
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the first settlement could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	zero := closings.Money("0.00")
	contribution := closings.Money(fund)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, closings.CashDraft{
		CountedCash: &zero, ContributedCash: contribution, ClosingCash: &contribution,
		Observation: "arranque de la sucursal",
	}); err != nil {
		t.Fatalf("the first cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the first settlement could not be proposed: %v", err)
	}
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch could not accept the first settlement: %v", err)
	}
	if closed.Status != closings.StatusClosed {
		t.Fatalf("the first settlement must be closed, got %q", closed.Status)
	}
	return opened.ID
}

// TestConfigureCommissionIsTheWarehouseOwn pins S6 rule 1: the rate is configured per
// branch, only by the warehouse (the database refuses anything else with LC015), and a
// branch without a configured rate has nothing to read.
func TestConfigureCommissionIsTheWarehouseOwn(t *testing.T) {
	e := fixture(t)

	// A branch neither configures nor reads the commission of another branch.
	_, err := e.store.ConfigureCommission(e.ctx, identity(2), 2, "10.00")
	refused(t, err, closings.ErrForbidden)
	_, err = e.store.ReadSettings(e.ctx, identity(2), 3)
	refused(t, err, closings.ErrForbidden)
	// A branch without a configured rate has nothing to read.
	_, err = e.store.ReadSettings(e.ctx, warehouse(), 3)
	refused(t, err, closings.ErrNotFound)

	// The warehouse writes the rate of one branch and receives it canonicalized.
	settings, err := e.store.ConfigureCommission(e.ctx, warehouse(), 2, "12.5")
	if err != nil {
		t.Fatalf("the warehouse must configure the branch commission: %v", err)
	}
	if settings.BranchID != 2 || settings.CommissionRatePercent != "12.50" {
		t.Fatalf("the configured rate is not canonical: %+v", settings)
	}
	read, err := e.store.ReadSettings(e.ctx, warehouse(), 2)
	if err != nil || read != settings {
		t.Fatalf("the warehouse must read back what it configured: %+v %v", read, err)
	}
	if branch, err := e.store.ReadSettings(e.ctx, identity(2), 2); err != nil || branch != settings {
		t.Fatalf("the branch must read the rate it is settled with: %+v %v", branch, err)
	}

	// The warehouse never settles a commission to itself, and a rate outside a percentage
	// is refused before the database.
	_, err = e.store.ConfigureCommission(e.ctx, warehouse(), 1, "10.00")
	refused(t, err, closings.ErrInvalid)
	_, err = e.store.ConfigureCommission(e.ctx, warehouse(), 2, "100.01")
	refused(t, err, closings.ErrInvalid)
	// An unknown branch does not exist, and a retired one keeps no setting.
	_, err = e.store.ConfigureCommission(e.ctx, warehouse(), 99, "10.00")
	refused(t, err, closings.ErrNotFound)
	e.retireBranch(t, 3)
	_, err = e.store.ConfigureCommission(e.ctx, warehouse(), 3, "10.00")
	var retired *closings.RetiredBranch
	if !errors.As(err, &retired) || retired.BranchID != 3 {
		t.Fatalf("a retired branch must be refused by name: %v", err)
	}
	refused(t, err, closings.ErrInvalid)

	// Only the branch the warehouse configured has a setting.
	if got := e.text(t, `SELECT string_agg(branch_location_id||':'||commission_rate_percent::text||':'
 ||updated_by_account_id::text,',' ORDER BY branch_location_id) FROM branch_settings`); got != "2:12.50:1" {
		t.Fatalf("the commission settings are not what the warehouse wrote: %q", got)
	}
}

// TestOpenFreezesThePeriodAndTheSnapshot pins rule 2: only the warehouse opens a settlement,
// only for a branch that exists, is not retired and is not the warehouse itself; the period,
// the cut instant, the inherited fund and the expected snapshot are the database's answers;
// and a second live settlement of the same branch is a conflict.
func TestOpenFreezesThePeriodAndTheSnapshot(t *testing.T) {
	e := fixture(t)

	// A branch never opens its own settlement, and the warehouse never settles itself.
	_, err := e.store.Open(e.ctx, identity(2), 2)
	refused(t, err, closings.ErrForbidden)
	_, err = e.store.Open(e.ctx, warehouse(), 1)
	refused(t, err, closings.ErrInvalid)
	_, err = e.store.Open(e.ctx, warehouse(), 99)
	refused(t, err, closings.ErrNotFound)
	if settlements := e.scalar(t, "SELECT count(*) FROM branch_closings"); settlements != 0 {
		t.Fatalf("a refused settlement must write nothing: %d rows", settlements)
	}

	// The open works and the database decides the whole identity of the period.
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the warehouse must open the settlement of a branch: %v", err)
	}
	if opened.Status != closings.StatusOpen || opened.BranchID != 2 || opened.BranchName == "" {
		t.Fatalf("the settlement did not open: %+v", opened)
	}
	if opened.CommissionRatePercent != nil {
		t.Fatalf("the rate is a fact of the proposal, not of the open: %v", *opened.CommissionRatePercent)
	}
	if opened.OpeningCash != "0.00" || opened.ClosingCash != nil || opened.CountedCash != nil {
		t.Fatalf("the first settlement starts from an empty drawer: %+v", opened)
	}
	if !opened.PeriodStart.Equal(opened.CutAt) || opened.ClosedAt != nil {
		t.Fatalf("the first period starts at the cut instant: %+v", opened)
	}
	// The expected snapshot is the database's answer, one line per variant with stock.
	if len(opened.CountLines) != 2 {
		t.Fatalf("the count sheet must cover the branch stock: %+v", opened.CountLines)
	}
	for _, line := range opened.CountLines {
		want := map[int64]int64{1: 10, 2: 4}[line.VariantID]
		if line.ExpectedQuantity != want || line.CountedQuantity != nil {
			t.Fatalf("variant %d: expected %d pending, got %+v", line.VariantID, want, line)
		}
		if line.Brand == "" || line.Model == "" || line.Polarity == "" || line.Capacity == "" {
			t.Fatalf("the sheet must be legible by catalogue identity: %+v", line)
		}
	}
	if opened.ExpectedCash != "0.00" || opened.CashDifference != nil || opened.TakenCash != nil {
		t.Fatalf("an empty drawer with nothing counted has no difference: %+v", opened)
	}

	// The snapshot is a fact of the cut instant, never a live read of the balance.
	if _, err := e.pool.Exec(e.ctx,
		"UPDATE inventory_balances SET existing=99 WHERE location_id=2 AND variant_id=1"); err != nil {
		t.Fatal("the branch stock could not be moved behind the settlement")
	}
	after, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil || after.CountLines[0].ExpectedQuantity != 10 {
		t.Fatalf("the expected quantity must not follow the live stock: %+v %v", after.CountLines, err)
	}

	// One live settlement per branch: the branch is frozen from the open on, and the refusal
	// names the settlement that already holds it, because that is the document to read or
	// close before the branch is settled again.
	_, err = e.store.Open(e.ctx, warehouse(), 2)
	refused(t, err, closings.ErrLiveConflict)
	var conflict *closings.LiveConflict
	if !errors.As(err, &conflict) || conflict.BranchID != 2 || conflict.ClosingID != opened.ID {
		t.Fatalf("a second open must name the settlement holding the branch: %v", err)
	}
	if settlements := e.scalar(t, "SELECT count(*) FROM branch_closings"); settlements != 1 {
		t.Fatalf("a refused open must write nothing: %d rows", settlements)
	}
	if frozen := e.scalar(t, "SELECT (branch_closure_blocker(2::smallint))::int"); frozen != 1 {
		t.Fatal("a live settlement must freeze its branch")
	}

	// The branch of the settlement reads its own; another branch's settlement is not part
	// of its ledger and a refusal never confirms that it exists.
	if _, err := e.store.Read(e.ctx, identity(2), opened.ID); err != nil {
		t.Fatalf("the branch must read its own settlement: %v", err)
	}
	_, err = e.store.Read(e.ctx, identity(3), opened.ID)
	refused(t, err, closings.ErrNotFound)
	_, err = e.store.Read(e.ctx, warehouse(), opened.ID+1000)
	refused(t, err, closings.ErrNotFound)

	// A retired branch is never settled, and the refusal names it.
	e.retireBranch(t, 3)
	_, err = e.store.Open(e.ctx, warehouse(), 3)
	var retired *closings.RetiredBranch
	if !errors.As(err, &retired) || retired.BranchID != 3 {
		t.Fatalf("a retired branch must be refused by name: %v", err)
	}
}

// TestCountUsesTheDatabaseSnapshot pins rule 3 and S4: the admin sees the expected snapshot
// the database took at open and sends only counted quantities, a variant the system did not
// have is added with a snapshot of zero, a recount only changes what was counted, and the
// sheet is refused while the branch is deciding or after the closure.
func TestCountUsesTheDatabaseSnapshot(t *testing.T) {
	e := fixture(t)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}

	// Only the warehouse holds the count sheet.
	_, err = e.store.Count(e.ctx, identity(2), opened.ID, []closings.Counted{{VariantID: 1, Quantity: 7}})
	refused(t, err, closings.ErrForbidden)
	// Only a positive settlement id reaches the database.
	_, err = e.store.Count(e.ctx, warehouse(), 0, []closings.Counted{{VariantID: 1, Quantity: 7}})
	refused(t, err, closings.ErrNotFound)

	// The admin counts a seeded line and a variant the system did not have at all: the
	// snapshot of the second one is zero, and it was never a caller value.
	counted, err := e.store.Count(e.ctx, warehouse(), opened.ID,
		[]closings.Counted{{VariantID: 1, Quantity: 7}, {VariantID: 3, Quantity: 2}})
	if err != nil {
		t.Fatalf("the warehouse must record what it counted: %v", err)
	}
	if got := sheet(counted); got != "1:10:7,2:4:-,3:0:2" {
		t.Fatalf("the count sheet is not the snapshot plus the counted quantities: %q", got)
	}

	// A recount only changes what was counted, never the expected snapshot.
	again, err := e.store.Count(e.ctx, warehouse(), opened.ID, []closings.Counted{{VariantID: 1, Quantity: 8}})
	if err != nil || sheet(again) != "1:10:8,2:4:-,3:0:2" {
		t.Fatalf("a recount must keep the snapshot: %q %v", sheet(again), err)
	}

	// Every impossible count is refused before the database and writes nothing.
	before := sheet(again)
	for _, invalid := range [][]closings.Counted{
		{},
		{{VariantID: 0, Quantity: 1}},
		{{VariantID: 1, Quantity: -1}},
		{{VariantID: 1, Quantity: 1_000_001}},
		{{VariantID: 1, Quantity: 1}, {VariantID: 1, Quantity: 2}},
		{{VariantID: 9999, Quantity: 1}},
	} {
		if _, err := e.store.Count(e.ctx, warehouse(), opened.ID, invalid); !errors.Is(err, closings.ErrInvalid) {
			t.Fatalf("count %+v must be refused with ErrInvalid, got %v", invalid, err)
		}
	}
	current, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil || sheet(current) != before {
		t.Fatalf("a refused count must leave the sheet untouched: %q %v", sheet(current), err)
	}

	// While the branch is deciding, the sheet cannot move: the offer it reads is frozen.
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, draft("100.00", "0.00", "20.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	_, err = e.store.Count(e.ctx, warehouse(), opened.ID, []closings.Counted{{VariantID: 1, Quantity: 1}})
	refused(t, err, closings.ErrCountFrozen)
	if current, err := e.store.Read(e.ctx, warehouse(), opened.ID); err != nil || current.CountLines[0].CountedQuantity == nil ||
		*current.CountLines[0].CountedQuantity != 10 {
		t.Fatalf("a refused count must leave the proposed sheet untouched: %+v %v", current.CountLines, err)
	}
}

// TestCashDraftWindowAndFundBound pins rules 4 and 7 with S8 and S10: the seven money and
// observation fields are a draft while the warehouse holds the settlement, the expected
// cash, the difference and the transfer are derived and never written, and the fund never
// exceeds the drawer the warehouse counted plus what it contributed.
func TestCashDraftWindowAndFundBound(t *testing.T) {
	e := fixture(t)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)

	// The draft persists exactly what the admin typed, canonicalized, and never the derived
	// numbers: expected 0 + 0 - 0 before the proposal, a surplus of 100 against the counted
	// 100, and 80 out of the drawer.
	saved, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("100.00", "10.00", "30.00"))
	if err != nil {
		t.Fatalf("the warehouse must be able to save a draft and leave: %v", err)
	}
	if *saved.CountedCash != "100.00" || saved.ContributedCash != "10.00" ||
		*saved.ClosingCash != "30.00" || saved.Observation != "borrador de la mesa" {
		t.Fatalf("the draft is not what the admin typed: %+v", saved)
	}
	// The draft states nothing about the period's money: cash sales and cash expenses come
	// from the ledgers at the proposal, so they are still zero here.
	if saved.CashSales != "0.00" || saved.CashExpenses != "0.00" {
		t.Fatalf("a draft must not state the money of the period: %+v", saved)
	}
	if saved.ExpectedCash != "0.00" || string(*saved.CashDifference) != "100.00" ||
		string(*saved.TakenCash) != "80.00" {
		t.Fatalf("the derived cash numbers are wrong: expected %q difference %v taken %v",
			saved.ExpectedCash, saved.CashDifference, saved.TakenCash)
	}
	// A draft may state the fund before the count is typed.
	countless, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		closings.CashDraft{ContributedCash: "0.00", ClosingCash: moneyPtr("10.00"),
			Observation: "sin contar"})
	if err != nil || countless.CashDifference != nil || countless.TakenCash != nil {
		t.Fatalf("a draft may still be missing the count: %+v %v", countless, err)
	}

	// The fund never exceeds the cash counted plus the contribution (S10, L13).
	_, err = e.store.SaveCash(e.ctx, warehouse(), opened.ID, draft("100.00", "10.00", "120.01"))
	var excess *closings.FundExceedsDrawer
	if !errors.As(err, &excess) || excess.Excess != "10.01" {
		t.Fatalf("a fund above the drawer must name its excess: %v", err)
	}
	refused(t, err, closings.ErrClosureRefused)
	// A refusal leaves the draft exactly as it was.
	after, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil || *after.ClosingCash != "10.00" || after.Observation != "sin contar" {
		t.Fatalf("a refused draft must leave the row untouched: %+v %v", after, err)
	}

	// Every impossible amount is refused before the database.
	negative, huge := closings.Money("-1.00"), closings.Money("10000000000.00")
	for _, invalid := range []closings.CashDraft{
		{ContributedCash: "1.005"},
		{ContributedCash: "-1.00"},
		{ContributedCash: "0.00", CountedCash: &negative},
		{ContributedCash: "0.00", ClosingCash: &huge},
		{ContributedCash: "0.00", Observation: strings.Repeat("x", 1001)},
	} {
		if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, invalid); !errors.Is(err, closings.ErrInvalid) {
			t.Fatalf("draft %+v must be refused with ErrInvalid, got %v", invalid, err)
		}
	}

	// The expected cash and the difference are not columns: they are derived on read, so
	// they cannot disagree with the facts of the drawer (L12).
	if stored := e.text(t, `SELECT count(*)::text FROM information_schema.columns
 WHERE table_name='branch_closings' AND column_name IN ('expected_cash','cash_difference','taken_cash')`); stored != "0" {
		t.Fatalf("the derived cash numbers must never be persisted: %s columns", stored)
	}

	// Once proposed, the settlement is not a draft any more: the branch is deciding it.
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("100.00", "0.00", "20.00")); err != nil {
		t.Fatalf("the cash draft could not be saved before proposing: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	_, err = e.store.SaveCash(e.ctx, warehouse(), opened.ID, draft("100.00", "0.00", "20.00"))
	refused(t, err, closings.ErrStateConflict)
}

// TestProposeFreezesTheRateAndOffersThePeriod pins rule 5 with S6, S7 and S10: one
// transaction computes the numbers of the period from the frozen sale ledger, inserts the
// round that carries the whole offer and flips the settlement to proposed, where the
// configured rate is frozen and later changes to it alter nothing.
func TestProposeFreezesTheRateAndOffersThePeriod(t *testing.T) {
	e := fixture(t)
	// A real period: the branch starts from an empty till, sells with the three admitted
	// methods and is settled again.
	e.closeFirstSettlement(t, "500.00")
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	e.sell(t, 2, 1, "50.00", sales.PaymentCard)
	e.sell(t, 1, 1, "20.00", sales.PaymentTransfer)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the second period could not be opened: %v", err)
	}
	if opened.OpeningCash != "500.00" {
		t.Fatalf("the period must inherit the fund of the previous closure: %q", opened.OpeningCash)
	}
	e.countAll(t, opened.ID)
	// The admin drafts only the drawer; the money of the period is the ledgers'.
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("600.00", "0.00", "100.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, identity(2), opened.ID); !errors.Is(err, closings.ErrForbidden) {
		t.Fatalf("only the warehouse proposes: %v", err)
	}

	proposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the warehouse must propose the settlement: %v", err)
	}
	if proposed.Status != closings.StatusProposed || proposed.CommissionRatePercent == nil ||
		*proposed.CommissionRatePercent != "12.50" {
		t.Fatalf("the proposal must freeze the configured rate: %+v", proposed)
	}
	// Exactly one round, carrying the whole offer the branch is asked to accept.
	if len(proposed.Rounds) != 1 {
		t.Fatalf("a proposal must create exactly one round: %+v", proposed.Rounds)
	}
	round := proposed.LatestRound()
	if round.Round != 1 || round.Decision != closings.DecisionPending ||
		round.DecidedAt != nil || round.DecidedByAccountID != nil || round.DecisionReason != "" {
		t.Fatalf("the first round must be pending and numbered by the database: %+v", round)
	}
	offer := round.Payload
	if !offer.PeriodStart.Equal(proposed.PeriodStart) || !offer.CutAt.Equal(proposed.CutAt) {
		t.Fatalf("the offer must state the period it settles: %+v", offer)
	}
	// The commission base is the sum of the sold subtotals of the period, and it is one
	// amount for the whole branch: 170.00 at 12.50% is 21.25, and no seller is named (S7).
	if offer.SalesTotal != "170.00" || offer.CommissionRatePercent != "12.50" ||
		offer.CommissionAmount != "21.25" {
		t.Fatalf("the commission of the period is wrong: %+v", offer)
	}
	if offer.CashSales != "100.00" || offer.CardTotal != "50.00" || offer.TransferTotal != "20.00" ||
		offer.QRTotal != "0.00" {
		t.Fatalf("the money of the period must be split by method: %+v", offer)
	}
	if *offer.CountedCash != "600.00" || offer.ContributedCash != "0.00" ||
		*offer.ClosingCash != "100.00" || offer.Observation != "borrador de la mesa" {
		t.Fatalf("the offer must state the drawer the admin counted and the fund it leaves: %+v", offer)
	}
	if len(offer.CountLines) != 2 || offer.CountLines[0].VariantID != 1 ||
		offer.CountLines[0].ExpectedQuantity != 8 || offer.CountLines[0].CountedQuantity != 8 ||
		offer.CountLines[1].VariantID != 2 || offer.CountLines[1].ExpectedQuantity != 3 {
		t.Fatalf("the offer must carry the counted sheet it is asking for: %+v", offer.CountLines)
	}

	// The offer is the database's row, not something this store keeps in memory.
	if stored := e.text(t, `SELECT proposed_payload->>'commission_amount' FROM closing_proposals
 WHERE closing_id=$1`, opened.ID); stored != "21.25" {
		t.Fatalf("the round must persist the offer it was shown: %q", stored)
	}
	// A commission is one amount per branch and period: no seller, no manager, no grouping.
	payload := strings.ToLower(e.text(t, "SELECT proposed_payload::text FROM closing_proposals WHERE closing_id=$1", opened.ID))
	for _, forbidden := range []string{"seller", "vendedor", "encargado", "manager", "clerk", "per_vendor"} {
		if strings.Contains(payload, forbidden) {
			t.Fatalf("the offer must not group the commission by person: it names %q", forbidden)
		}
	}

	// Changing the configured rate after the proposal alters neither the offer nor the frozen
	// rate: the settlement pays what it offered (S6).
	if _, err := e.store.ConfigureCommission(e.ctx, warehouse(), 2, "99.00"); err != nil {
		t.Fatalf("the configured rate could not be changed: %v", err)
	}
	after, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil || after.CommissionRatePercent == nil || *after.CommissionRatePercent != "12.50" ||
		after.LatestRound().Payload.CommissionAmount != "21.25" {
		t.Fatalf("a proposed settlement keeps the rate it offered: %+v %v", after, err)
	}

	// The database records the offer at proposal (R1-001): the transition guard writes the
	// sale totals and the commission of the period, so the settlement the branch is shown
	// already states them and the closure is not allowed to rewrite them.
	if proposed.SalesTotal != "170.00" || proposed.CommissionAmount != "21.25" ||
		proposed.CardTotal != "50.00" || proposed.TransferTotal != "20.00" {
		t.Fatalf("the offer must state the period the branch is accepting: %+v", proposed)
	}
	// A proposed settlement is not proposed twice: the branch is deciding it.
	_, err = e.store.Propose(e.ctx, warehouse(), opened.ID)
	refused(t, err, closings.ErrStateConflict)
	if rounds := e.scalar(t, "SELECT count(*) FROM closing_proposals WHERE closing_id=$1", opened.ID); rounds != 1 {
		t.Fatalf("a refused proposal must write nothing: %d rounds", rounds)
	}
}

// TestClosurePersistsTheCommissionItOffered pins S20 on the database: two sold pieces of four
// cents pay one cent in all, because the rate is applied to the total of the period and
// rounded once. Per line it would have been two cents.
func TestClosurePersistsTheCommissionItOffered(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "0.00")
	e.sell(t, 1, 1, "0.04", sales.PaymentCash)
	e.sell(t, 2, 1, "0.04", sales.PaymentCash)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("0.00", "0.00", "0.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	proposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	offer := proposed.LatestRound().Payload
	if offer.SalesTotal != "0.08" || offer.CashSales != "0.08" || offer.CommissionAmount != "0.01" {
		t.Fatalf("the commission must be rounded once on the period total: %+v", offer)
	}
	// The closure records exactly the amount the branch was shown: one value, not an
	// approximation of it.
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the offer: %v", err)
	}
	if closed.SalesTotal != "0.08" || closed.CommissionAmount != "0.01" ||
		closed.CommissionRatePercent == nil || *closed.CommissionRatePercent != "12.50" {
		t.Fatalf("the closure must persist the offer it settled: %+v", closed)
	}
}

// TestProposeRefusesAnIncompleteCountOrNoRate pins the proposal's own refusals (rule 5 with
// S4 and S6): a pending variant or an uncounted drawer blocks the offer by name instead of
// creating a round the closure would refuse, and a branch without a configured rate opens
// its settlement but cannot propose it.
func TestProposeRefusesAnIncompleteCountOrNoRate(t *testing.T) {
	e := fixture(t)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	// A pending line blocks the offer and no round is written.
	if _, err := e.store.Count(e.ctx, warehouse(), opened.ID, []closings.Counted{{VariantID: 1, Quantity: 10}}); err != nil {
		t.Fatalf("the first line could not be counted: %v", err)
	}
	_, err = e.store.Propose(e.ctx, warehouse(), opened.ID)
	var pending *closings.CountPending
	if !errors.As(err, &pending) || pending.VariantID != 2 {
		t.Fatalf("a pending variant must be named: %v", err)
	}
	refused(t, err, closings.ErrClosureRefused)
	// The drawer must be counted too: a proposal states the cash it counted and the fund.
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, closings.CashDraft{
		ContributedCash: "0.00", ClosingCash: moneyPtr("10.00")}); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	_, err = e.store.Propose(e.ctx, warehouse(), opened.ID)
	var missing *closings.CashNotStated
	if !errors.As(err, &missing) {
		t.Fatalf("a drawer without a count cannot be proposed: %v", err)
	}
	if rounds := e.scalar(t, "SELECT count(*) FROM closing_proposals"); rounds != 0 {
		t.Fatalf("a refused proposal must write nothing: %d rounds", rounds)
	}
	if state := e.text(t, "SELECT status FROM branch_closings WHERE id=$1", opened.ID); state != "open" {
		t.Fatalf("a refused proposal must leave the settlement where it was: %q", state)
	}

	// A branch without a configured rate opens its settlement anyway and cannot propose it.
	third, err := e.store.Open(e.ctx, warehouse(), 3)
	if err != nil {
		t.Fatalf("the branch without a rate must still open its settlement: %v", err)
	}
	e.countAll(t, third.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), third.ID,
		draft("0.00", "0.00", "0.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	_, err = e.store.Propose(e.ctx, warehouse(), third.ID)
	refused(t, err, closings.ErrNoCommissionRate)
	// Once configured, the proposal freezes the rate of that branch.
	if _, err := e.store.ConfigureCommission(e.ctx, warehouse(), 3, "8.75"); err != nil {
		t.Fatalf("the third branch commission could not be configured: %v", err)
	}
	proposed, err := e.store.Propose(e.ctx, warehouse(), third.ID)
	if err != nil || proposed.CommissionRatePercent == nil || *proposed.CommissionRatePercent != "8.75" {
		t.Fatalf("each branch freezes the rate it was configured with: %+v %v", proposed, err)
	}
}

// TestRejectionAppliesNothing pins rule 8 with S14 and S17: any enabled account of the branch
// decides, a rejection states its reason, it applies nothing to the stock or the cash, it
// does not unfreeze the branch and it hands the settlement back to the warehouse for
// correction, with no limit of rounds.
func TestRejectionAppliesNothing(t *testing.T) {
	e := fixture(t)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	// A settlement that is not proposed has no round to decide.
	if _, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, ""); !errors.Is(err, closings.ErrStateConflict) {
		t.Fatalf("an open settlement has nothing to decide: %v", err)
	}
	if _, err := e.store.Count(e.ctx, warehouse(), opened.ID,
		[]closings.Counted{{VariantID: 1, Quantity: 7}, {VariantID: 2, Quantity: 6}}); err != nil {
		t.Fatalf("the count could not be recorded: %v", err)
	}
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("50.00", "0.00", "20.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}

	// Only an account of the branch decides: neither the warehouse nor another branch.
	for _, actor := range []auth.Identity{warehouse(), identity(3)} {
		if _, err := e.store.Decide(e.ctx, actor, opened.ID, closings.DecisionRejected, "no me corresponde"); !errors.Is(err, closings.ErrForbidden) {
			t.Fatalf("actor %+v must not decide the settlement: %v", actor, err)
		}
	}
	// A rejection states its reason, and only a real decision is a decision.
	if _, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionRejected, "   "); !errors.Is(err, closings.ErrInvalid) {
		t.Fatalf("a rejection without a reason must be refused: %v", err)
	}
	if _, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.Decision("maybe"), "no"); !errors.Is(err, closings.ErrInvalid) {
		t.Fatalf("an invented decision must be refused: %v", err)
	}
	if _, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "soborno"); !errors.Is(err, closings.ErrInvalid) {
		t.Fatalf("an acceptance carries no rejection reason: %v", err)
	}

	rejected, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionRejected, "  el conteo estaba mal  ")
	if err != nil {
		t.Fatalf("the branch must be able to reject: %v", err)
	}
	if rejected.Status != closings.StatusRejected || rejected.ClosedAt != nil {
		t.Fatalf("a rejection closes nothing and returns the settlement to the warehouse: %+v", rejected)
	}
	round := rejected.LatestRound()
	if round.Decision != closings.DecisionRejected || round.DecisionReason != "el conteo estaba mal" ||
		round.DecidedByAccountID == nil || *round.DecidedByAccountID != 2 || round.DecidedAt == nil {
		t.Fatalf("the rejection must be a version with author, date and reason: %+v", round)
	}
	// Nothing was applied: the stock, the ledger and the frozen branch are exactly as they
	// were, and no snapshot of the period was written.
	if existing, reserved := e.balance(t, 2, 1); existing != 10 || reserved != 0 {
		t.Fatalf("a rejection must not move the stock: %d/%d", existing, reserved)
	}
	if existing, _ := e.balance(t, 2, 2); existing != 4 {
		t.Fatalf("a rejection must not move the stock: %d", existing)
	}
	if movements := e.scalar(t, "SELECT count(*) FROM branch_cash_movements"); movements != 0 {
		t.Fatalf("a rejection must not write the cash ledger: %d movements", movements)
	}
	if frozen := e.scalar(t, "SELECT (branch_closure_blocker(2::smallint))::int"); frozen != 1 {
		t.Fatal("a rejected settlement still freezes its branch")
	}
	if rejected.SalesTotal != "0.00" || rejected.CommissionAmount != "0.00" {
		t.Fatalf("a rejection applies no period snapshot: %+v", rejected)
	}
	// It stays rejected: it never returns to open.
	if status := e.text(t, "SELECT status FROM branch_closings WHERE id=$1", opened.ID); status != "rejected" {
		t.Fatalf("a rejected settlement is not reopened: %q", status)
	}

	// The rejection hands the settlement back to the warehouse, so the cash draft is editable
	// again: the money the branch rejected can be corrected.
	corrected, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("50.00", "0.00", "10.00"))
	if err != nil || *corrected.ClosingCash != "10.00" || corrected.Status != closings.StatusRejected {
		t.Fatalf("a rejected settlement must accept a corrected draft: %+v %v", corrected, err)
	}
	// The warehouse corrects the count it was told about and proposes again, with no limit
	// of rounds; the rejected round stays exactly as it was decided.
	if _, err := e.store.Count(e.ctx, warehouse(), opened.ID,
		[]closings.Counted{{VariantID: 1, Quantity: 8}, {VariantID: 3, Quantity: 2}}); err != nil {
		t.Fatalf("a rejected settlement must accept a corrected count: %v", err)
	}
	reproposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("a second round must be proposable: %v", err)
	}
	if len(reproposed.Rounds) != 2 || reproposed.Rounds[1].Round != 2 ||
		reproposed.Rounds[1].Decision != closings.DecisionPending ||
		reproposed.Rounds[0].DecisionReason != "el conteo estaba mal" {
		t.Fatalf("the settlement must keep its whole round history: %+v", reproposed.Rounds)
	}
	if reproposed.Rounds[1].Payload.CountLines[0].CountedQuantity != 8 {
		t.Fatalf("the new round must offer the corrected count: %+v", reproposed.Rounds[1].Payload.CountLines)
	}

	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must be able to accept the second round: %v", err)
	}
	if closed.Status != closings.StatusClosed || closed.ClosedAt == nil {
		t.Fatalf("an acceptance closes the settlement: %+v", closed)
	}
	var history string
	if history = e.text(t, `SELECT string_agg(round||':'||decision||':'||
 Coalesce(nullif(decision_reason,''),'-'),',' ORDER BY round) FROM closing_proposals
 WHERE closing_id=$1`, opened.ID); history != "1:rejected:el conteo estaba mal,2:accepted:-" {
		t.Fatalf("both rounds must stay as they were decided: %q", history)
	}
	// Two decisions were taken and two rounds recorded, and nothing was rewritten.
	if rounds := e.scalar(t, "SELECT count(*) FROM closing_proposals WHERE closing_id=$1", opened.ID); rounds != 2 {
		t.Fatalf("a decision must never add or remove rounds: %d", rounds)
	}
}

// TestAcceptanceClosesAndAppliesTheCount pins rule 8 with S5, S8, S9 and S10: only an
// acceptance closes, the closure leaves the stock exactly as counted, the drawer's money is
// one ledger movement, the commission is in no cash identity, and the fund left behind is the
// cash the next period inherits.
func TestAcceptanceClosesAndAppliesTheCount(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "300.00")
	// The branch sells in the new period, in cash, and the admin finds the drawer short.
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the second period could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, closings.CashDraft{
		CountedCash: moneyPtr("250.00"), ContributedCash: "0.00", ClosingCash: moneyPtr("100.00"),
		Observation: "faltaron 150 que no se explican"}); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	proposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	if proposed.SalesTotal != "100.00" || proposed.CommissionAmount != "12.50" {
		t.Fatalf("the offer must state the period at proposal: %+v", proposed)
	}
	// Deciding a settlement that is not proposed has nothing to decide.
	if _, err := e.store.Decide(e.ctx, identity(2), opened.ID+1000, closings.DecisionAccepted, ""); !errors.Is(err, closings.ErrNotFound) {
		t.Fatalf("an unknown settlement is not found: %v", err)
	}

	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the offer: %v", err)
	}
	if closed.Status != closings.StatusClosed || closed.ClosedAt == nil {
		t.Fatalf("only an acceptance closes the settlement: %+v", closed)
	}
	// The closure records the period it settled: the sale ledger's money and the commission.
	if closed.SalesTotal != "100.00" || closed.CashSales != "100.00" ||
		closed.CommissionAmount != "12.50" || closed.CardTotal != "0.00" ||
		closed.TransferTotal != "0.00" || closed.QRTotal != "0.00" {
		t.Fatalf("the closure must persist the period it settled: %+v", closed)
	}
	// S8: the expected cash, the shortage and the transfer are derived on read, with signs,
	// and the commission takes no part in any of them (S9).
	if closed.ExpectedCash != "400.00" {
		t.Fatalf("expected cash must be the inherited fund plus the cash sales: %q", closed.ExpectedCash)
	}
	if closed.CashDifference == nil || string(*closed.CashDifference) != "-150.00" ||
		!closed.CashDifference.Negative() {
		t.Fatalf("a shortage must be persisted with its sign: %v", closed.CashDifference)
	}
	if closed.TakenCash == nil || string(*closed.TakenCash) != "150.00" {
		t.Fatalf("the warehouse takes the drawer minus the fund: %v", closed.TakenCash)
	}
	if closed.Observation != "faltaron 150 que no se explican" {
		t.Fatalf("the closure keeps the observation of the difference: %q", closed.Observation)
	}

	// The closure leaves the stock exactly as counted, in both directions.
	for variant, want := range map[int64]int64{1: 9, 2: 4} {
		if existing, reserved := e.balance(t, 2, variant); existing != want || reserved != 0 {
			t.Fatalf("variant %d must end at the counted quantity: %d/%d", variant, existing, reserved)
		}
	}
	// The drawer's money is one movement of the ledger, and the commission is not one: it is
	// reported and paid outside the system (S9).
	if ledger := e.text(t, `SELECT string_agg(kind||':'||amount||':'||description,',' ORDER BY id)
 FROM branch_cash_movements WHERE closing_id=$1`, opened.ID); ledger != "recaudacion:150.00:Recaudación de la rendición" {
		t.Fatalf("the closure must record exactly one cash movement: %q", ledger)
	}
	if commission := e.scalar(t, "SELECT count(*) FROM branch_cash_movements WHERE kind NOT IN ('gasto','recaudacion','aporte')"); commission != 0 {
		t.Fatalf("no cash movement may be a commission: %d", commission)
	}
	// The branch is unfrozen and a closed settlement is immutable.
	if frozen := e.scalar(t, "SELECT (branch_closure_blocker(2::smallint))::int"); frozen != 0 {
		t.Fatal("a closed settlement must unfreeze its branch")
	}
	if _, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, ""); !errors.Is(err, closings.ErrStateConflict) {
		t.Fatalf("a closed settlement cannot be decided again: %v", err)
	}
	if _, err := e.store.Count(e.ctx, warehouse(), opened.ID, []closings.Counted{{VariantID: 1, Quantity: 1}}); !errors.Is(err, closings.ErrCountFrozen) {
		t.Fatalf("a closed settlement keeps its count sheet: %v", err)
	}
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, draft("0.00", "0.00", "0.00")); !errors.Is(err, closings.ErrStateConflict) {
		t.Fatalf("a closed settlement is not a draft: %v", err)
	}
	// The fund left behind is the cash the next period inherits, and its period starts at
	// the closure instant.
	next, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the next period could not be opened: %v", err)
	}
	if next.OpeningCash != "100.00" || !next.PeriodStart.Equal(*closed.ClosedAt) {
		t.Fatalf("the next period must inherit the fund and the cut: %+v", next)
	}
}

// TestFirstSettlementRecordsTheDeclaredFund pins the resolved S10 of L13 on the first
// settlement of a branch: the admin declares the fund, the drawer is empty, and that money is
// one contribution of its own in the ledger — never an invented count and never a collection.
func TestFirstSettlementRecordsTheDeclaredFund(t *testing.T) {
	e := fixture(t)
	first := e.closeFirstSettlement(t, "500.00")
	closed, err := e.store.Read(e.ctx, warehouse(), first)
	if err != nil {
		t.Fatalf("the first settlement could not be read: %v", err)
	}
	if closed.OpeningCash != "0.00" || closed.SalesTotal != "0.00" || closed.CommissionAmount != "0.00" ||
		*closed.CountedCash != "0.00" || closed.ContributedCash != "500.00" ||
		*closed.ClosingCash != "500.00" {
		t.Fatalf("the first settlement starts from an empty till: %+v", closed)
	}
	if closed.ExpectedCash != "0.00" || string(*closed.CashDifference) != "0.00" ||
		string(*closed.TakenCash) != "0.00" {
		t.Fatalf("an empty drawer with nothing to take: %+v", closed)
	}
	if ledger := e.text(t, `SELECT string_agg(kind||':'||amount||':'||description,',' ORDER BY id)
 FROM branch_cash_movements WHERE closing_id=$1`, first); ledger != "aporte:500.00:Aporte de fondo de la rendición" {
		t.Fatalf("the declared fund must be one contribution: %q", ledger)
	}
}

// TestProposeReadsTheCashExpensesOfThePeriodLedger pins S8 and S12: the cash expenses of a
// settlement are the ones the branch recorded as they happened inside the period, never a
// number a caller types; the cash sales are the branch's own sales; the expected cash and the
// difference follow from those two facts; and the closure recomputes them with the same
// helper, so the offered period and the closed one can never differ.
func TestProposeReadsTheCashExpensesOfThePeriodLedger(t *testing.T) {
	e := fixture(t)
	// An expense recorded before the first settlement belongs to that first period: the first
	// period starts where the branch started, so the money it already paid out is part of the
	// drawer identity of the settlement that covers it (S8) -- leaving it out would overstate
	// the expected cash by money the branch no longer has in the till.
	e.expense(t, 2, "30.00", "Flete de la semana pasada")
	// The first settlement settles an empty period of sales but not of expenses: the branch has
	// no sale and one expense of 30.00 in its window, so the period states the expense it owes
	// and zero cash collected.
	first := e.closeFirstSettlement(t, "200.00")
	settled, err := e.store.Read(e.ctx, warehouse(), first)
	if err != nil || settled.CashExpenses != "30.00" || settled.CashSales != "0.00" {
		t.Fatalf("the first period must state the expense it covers: %+v %v", settled, err)
	}
	// The reason is S8's identity and not a changed number: expected = 0.00 inherited + 0.00
	// collected - 30.00 already spent, and the difference is the counted drawer against it.
	if settled.ExpectedCash != "-30.00" || settled.CashDifference == nil ||
		string(*settled.CashDifference) != "30.00" {
		t.Fatalf("the first period must derive its drawer from the expense it covers: %+v", settled)
	}
	// Two expenses inside the period the next settlement covers.
	e.expense(t, 2, "45.50", "Flete")
	e.expense(t, 2, "10.00", "Insumos")
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the next period could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)

	// The draft states the drawer only: the period's expenses survive it untouched, and the
	// settlement itself still says nothing about them.
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, draft("200.00", "0.00", "50.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if ledger := e.text(t, `SELECT string_agg(amount::text,',' ORDER BY id)
 FROM branch_cash_movements WHERE branch_location_id=2 AND kind='gasto'`); ledger != "30.00,45.50,10.00" {
		t.Fatalf("a draft must not touch the expense ledger: %q", ledger)
	}
	if row := e.text(t, "SELECT cash_expenses::text FROM branch_closings WHERE id=$1", opened.ID); row != "0.00" {
		t.Fatalf("a draft must not state the expenses of the period: %q", row)
	}

	proposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	offer := proposed.LatestRound().Payload
	// Only the two expenses of the window: 45.50 + 10.00, never the 30.00 before the period.
	if offer.CashExpenses != "55.50" || proposed.CashExpenses != "55.50" {
		t.Fatalf("the offer must state the expenses of its own window: %+v", offer.CashExpenses)
	}
	if offer.CashSales != "0.00" || proposed.CashSales != "0.00" {
		t.Fatalf("a period without sales collects no cash: %+v", offer.CashSales)
	}
	// S8: expected = inherited fund + cash sales - cash expenses, and the difference is the
	// counted drawer against it. Neither number is a column and neither states the money.
	if proposed.ExpectedCash != "144.50" {
		t.Fatalf("expected cash must be 200.00 + 0.00 - 55.50: %q", proposed.ExpectedCash)
	}
	if proposed.CashDifference == nil || string(*proposed.CashDifference) != "55.50" ||
		proposed.CashDifference.Negative() {
		t.Fatalf("the drawer holds 55.50 more than expected: %v", proposed.CashDifference)
	}
	if proposed.TakenCash == nil || string(*proposed.TakenCash) != "150.00" {
		t.Fatalf("the warehouse takes the drawer minus the fund: %v", proposed.TakenCash)
	}

	// The branch accepts, and the closure recomputes the very same period with the same
	// helper: the money the settlement closed with is the money it offered.
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the offer: %v", err)
	}
	if closed.CashExpenses != "55.50" || closed.CashSales != "0.00" ||
		closed.ExpectedCash != "144.50" || string(*closed.CashDifference) != "55.50" {
		t.Fatalf("the closure must persist the period it offered: %+v", closed)
	}
}

// draft is one cash draft of the drawer. It states exactly the four fields the admin owns —
// what it counted, its contribution, the fund it leaves and its observation — because the
// cash sales and the cash expenses of the period are the ledgers' own facts and no caller can
// type them (S8, S12).
// TestProposeReportsTheQRCollected pins S13 at the settlement: the QR money the branch
// collected in the period is reported on its own, next to the cash, card and transfer
// totals of the same window, and it is never added to the drawer.
func TestProposeReportsTheQRCollected(t *testing.T) {
	e := fixture(t)
	// The fourth method, stated by the text the database stores and derives.
	const qr = sales.PaymentMethod("qr")
	e.closeFirstSettlement(t, "0.00")
	// The period: one sale paid only by QR and one settled in cash and QR.
	e.sell(t, 1, 1, "100.00", qr)
	e.sellPayments(t, 1, 1, "60.00",
		sales.Payment{Method: qr, Amount: "40.00"},
		sales.Payment{Method: sales.PaymentCash, Amount: "20.00"})
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	zero, counted, fund := closings.Money("0.00"), closings.Money("20.00"), closings.Money("20.00")
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, closings.CashDraft{
		CountedCash: &counted, ContributedCash: zero, ClosingCash: &fund,
	}); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	proposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	// 140.00 of the period was collected by QR and 20.00 in cash; nothing by card or
	// transfer. The QR money is a total of its own, never cash.
	if proposed.QRTotal != "140.00" || proposed.CashSales != "20.00" ||
		proposed.CardTotal != "0.00" || proposed.TransferTotal != "0.00" {
		t.Fatalf("the offer must report the QR money on its own: %+v", proposed)
	}
	// The drawer only holds what was collected in cash, so the QR money enters no cash
	// identity: no expected cash, no difference and no settlement transfer.
	if proposed.ExpectedCash != "20.00" {
		t.Fatalf("the expected cash must be the cash collected only, got %q", proposed.ExpectedCash)
	}
	if proposed.TakenCash == nil || *proposed.TakenCash != "0.00" {
		t.Fatalf("the QR money must not move the settlement transfer: %v", proposed.TakenCash)
	}
	// The round the branch is asked to accept states the same QR money.
	round := proposed.LatestRound()
	if round == nil || round.Payload.QRTotal != "140.00" ||
		round.Payload.CashSales != "20.00" || round.Payload.SalesTotal != "160.00" {
		t.Fatalf("the offer payload must state the QR money of the period: %+v", round)
	}
	// The closure applies exactly the offer the branch accepted.
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must be able to accept the settlement: %v", err)
	}
	if closed.Status != closings.StatusClosed || closed.QRTotal != "140.00" ||
		closed.CashSales != "20.00" || closed.CardTotal != "0.00" ||
		closed.TransferTotal != "0.00" {
		t.Fatalf("the closed settlement must keep the QR total it offered: %+v", closed)
	}
}

func draft(counted, contributed, fund string) closings.CashDraft {
	return closings.CashDraft{CountedCash: moneyPtr(counted), ContributedCash: money(contributed),
		ClosingCash: moneyPtr(fund), Observation: "borrador de la mesa"}
}

// money canonicalizes one amount for the tests, so no fixture states text this vertical
// would refuse.
func money(text string) closings.Money {
	value, err := closings.ParseAmount(text)
	if err != nil {
		panic(err)
	}
	return value
}

// moneyPtr is the nullable variant of money.
func moneyPtr(text string) *closings.Money {
	value := money(text)
	return &value
}

// sheet renders one count sheet as variant:expected:counted, with a dash for a pending line.
func sheet(closing closings.Closing) string {
	parts := make([]string, 0, len(closing.CountLines))
	for _, line := range closing.CountLines {
		counted := "-"
		if line.CountedQuantity != nil {
			counted = fmt.Sprintf("%d", *line.CountedQuantity)
		}
		parts = append(parts, fmt.Sprintf("%d:%d:%s", line.VariantID, line.ExpectedQuantity, counted))
	}
	return strings.Join(parts, ",")
}

// TestListIsTheBranchOwnHistory pins the history read: one branch at a time, newest cut instant
// first, with the same page contract as the rest of the installation, and with the very same
// projection the single read publishes, so a row and its document can never disagree.
func TestListIsTheBranchOwnHistory(t *testing.T) {
	e := fixture(t)
	// The branch starts with its bootstrap settlement, which is closed, and then holds a live
	// one: the history has both states and both are rows of the same branch.
	first := e.closeFirstSettlement(t, "100.00")
	second, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the second settlement could not be opened: %v", err)
	}
	other, err := e.store.Open(e.ctx, warehouse(), 3)
	if err != nil {
		t.Fatalf("the settlement of the other branch could not be opened: %v", err)
	}

	page, err := e.store.List(e.ctx, warehouse(), 2, 1, 25)
	if err != nil {
		t.Fatalf("the warehouse must read the history of a branch: %v", err)
	}
	if page.Page != 1 || page.PageSize != 25 || page.TotalClosings != 2 || len(page.Closings) != 2 {
		t.Fatalf("the history of the branch is not the asked page: %+v", page)
	}
	// Newest cut instant first: the live settlement was opened after the closure.
	if page.Closings[0].ID != second.ID || page.Closings[1].ID != first {
		t.Fatalf("the history must be newest first: %d %d", page.Closings[0].ID, page.Closings[1].ID)
	}
	if page.Closings[0].Status != closings.StatusOpen || page.Closings[1].Status != closings.StatusClosed ||
		page.Closings[0].BranchID != 2 || page.Closings[1].BranchID != 2 {
		t.Fatalf("every row must be a settlement of the asked branch: %+v", page.Closings)
	}
	// The row is the header projection of the document, so the money is the same money and it
	// is already derived: the later period inherits the fund the first one left.
	if page.Closings[0].OpeningCash != "100.00" || page.Closings[0].ExpectedCash != "100.00" ||
		page.Closings[1].ClosingCash == nil || *page.Closings[1].ClosingCash != "100.00" ||
		page.Closings[1].CommissionAmount != "0.00" || page.Closings[1].CashDifference == nil ||
		*page.Closings[1].CashDifference != "0.00" || page.Closings[1].ClosedAt == nil {
		t.Fatalf("a row must carry the derived money of its own facts: %+v %+v",
			page.Closings[0], page.Closings[1])
	}
	// The sheet and the rounds of a document belong to the single read of it.
	for _, row := range page.Closings {
		if len(row.CountLines) != 0 || len(row.Rounds) != 0 {
			t.Fatalf("a history row must not unfold the document: %+v", row)
		}
	}
	document, err := e.store.Read(e.ctx, warehouse(), first)
	if err != nil || len(document.CountLines) == 0 || len(document.Rounds) != 1 {
		t.Fatalf("the single read must unfold the document it summarises: %+v %v", document, err)
	}
	if document.ExpectedCash != page.Closings[1].ExpectedCash ||
		document.CommissionAmount != page.Closings[1].CommissionAmount {
		t.Fatalf("a row and its document must publish the same money: %+v %+v",
			page.Closings[1], document)
	}

	// The total is the branch's own, so a page beyond the last one is legitimately empty.
	beyond, err := e.store.List(e.ctx, warehouse(), 2, 2, 10)
	if err != nil || beyond.TotalClosings != 2 || len(beyond.Closings) != 0 {
		t.Fatalf("a page beyond the last one must be empty: %+v %v", beyond, err)
	}
	// A page whose size covers the branch holds the same history, and the page size is echoed as
	// asked: two settlements never spill into a second page of ten.
	fits, err := e.store.List(e.ctx, warehouse(), 2, 1, 10)
	if err != nil || len(fits.Closings) != 2 || fits.PageSize != 10 || fits.TotalClosings != 2 ||
		fits.Closings[0].ID != page.Closings[0].ID || fits.Closings[1].ID != page.Closings[1].ID {
		t.Fatalf("a page must be one page of the branch total: %+v %v", fits, err)
	}

	// The other branch is its own history and never part of this one.
	otherPage, err := e.store.List(e.ctx, warehouse(), 3, 1, 25)
	if err != nil || otherPage.TotalClosings != 1 || len(otherPage.Closings) != 1 ||
		otherPage.Closings[0].ID != other.ID || otherPage.Closings[0].BranchID != 3 {
		t.Fatalf("each branch reads its own history: %+v %v", otherPage, err)
	}

	// A branch reads its own history and never another branch's, exactly like its setting.
	own, err := e.store.List(e.ctx, identity(2), 2, 1, 25)
	if err != nil || own.TotalClosings != 2 {
		t.Fatalf("a branch must read its own history: %+v %v", own, err)
	}
	refused(t, func() error { _, err := e.store.List(e.ctx, identity(2), 3, 1, 25); return err }(),
		closings.ErrForbidden)
	refused(t, func() error { _, err := e.store.List(e.ctx, identity(3), 2, 1, 25); return err }(),
		closings.ErrForbidden)

	// The page contract is the one of every history of this installation, and an unknown or
	// impossible branch is refused before any read.
	for _, bad := range []struct{ page, size int }{{0, 25}, {1_000_001, 25}, {1, 0}, {1, 15},
		{1, 100}, {1, 51}} {
		refused(t, func() error {
			_, err := e.store.List(e.ctx, warehouse(), 2, bad.page, bad.size)
			return err
		}(), closings.ErrInvalid)
	}
	refused(t, func() error { _, err := e.store.List(e.ctx, warehouse(), 99, 1, 25); return err }(),
		closings.ErrNotFound)
	refused(t, func() error { _, err := e.store.List(e.ctx, warehouse(), 1, 1, 25); return err }(),
		closings.ErrInvalid)
	// A retired branch is refused by name, exactly like an opening.
	e.retireBranch(t, 3)
	var retired *closings.RetiredBranch
	if _, err := e.store.List(e.ctx, warehouse(), 3, 1, 25); !errors.As(err, &retired) || retired.BranchID != 3 {
		t.Fatalf("a retired branch has no history: %v", err)
	}
}

// TestRecordExpenseIsTheBranchOwn pins S12 on the branch's own path: the branch records a small
// expense of its period with an amount and a description, with no previous approval and no
// settlement to name; the warehouse cannot record one on its behalf, because the till the
// expense comes out of is the branch's; and a recorded expense is immutable, so a wrong one is
// corrected by its opposite movement instead of being edited.
func TestRecordExpenseIsTheBranchOwn(t *testing.T) {
	e := fixture(t)

	// The branch records its own expense and reads it back with its own identity: the branch of
	// the movement is the account's own location, never a value the caller promises.
	expense := e.expense(t, 2, "45.5", "  Flete de la semana  ")
	if expense.ID < 1 || expense.BranchID != 2 || expense.Amount != "45.50" ||
		expense.Description != "Flete de la semana" || expense.CreatedByAccountID != 2 ||
		expense.OccurredAt.IsZero() {
		t.Fatalf("the expense is not the branch's own fact: %+v", expense)
	}
	// Another branch records in its own till and never in this one.
	if other := e.expense(t, 3, "5.00", "Agua"); other.BranchID != 3 || other.CreatedByAccountID != 3 {
		t.Fatalf("a branch records only its own expenses: %+v", other)
	}
	if ledger := e.text(t, `SELECT string_agg(branch_location_id||':'||kind||':'||amount::text||':'
 ||created_by_account_id::text,',' ORDER BY id) FROM branch_cash_movements`); ledger !=
		"2:gasto:45.50:2,3:gasto:5.00:3" {
		t.Fatalf("the ledger is not what the branches recorded: %q", ledger)
	}

	// The warehouse never records an expense: it is not the branch that owns the till, and the
	// database's own refusal is the named domain error, not a generic failure.
	_, err := e.store.RecordExpense(e.ctx, warehouse(), money("10.00"), "Flete del almacén")
	refused(t, err, closings.ErrNotBranchExpense)
	// An identity the provisioned accounts do not hold is refused before the database, and so is a
	// session still forced to change its password: neither moves the branch's money.
	_, err = e.store.RecordExpense(e.ctx, auth.Identity{AccountID: 2, Location: auth.Location{ID: 3}},
		money("10.00"), "Flete ajeno")
	refused(t, err, closings.ErrForbidden)
	_, err = e.store.RecordExpense(e.ctx, auth.Identity{AccountID: 2, Location: auth.Location{ID: 2},
		MustChangePassword: true}, money("10.00"), "Flete sin cambiar la clave")
	refused(t, err, closings.ErrForbidden)

	// Every malformed expense is refused before the database and writes nothing: the amount has
	// to be money the drawer can hold and the description a real one.
	for name, value := range map[string]struct{ amount, description string }{
		"zero":      {"0.00", "Flete"},
		"three_dec": {"1.005", "Flete"},
		"negative":  {"-1.00", "Flete"},
		"signed":    {"+1.00", "Flete"},
		"padded":    {"010.00", "Flete"},
		"text":      {"diez", "Flete"},
		"above":     {"10000000000.00", "Flete"},
		"empty":     {"10.00", ""},
		"blank":     {"10.00", "   "},
		"nul":       {"10.00", "a\x00b"},
		"too_long":  {"10.00", strings.Repeat("ñ", closings.MaxDescription+1)},
	} {
		if _, err := e.store.RecordExpense(e.ctx, identity(2), closings.Money(value.amount),
			value.description); !errors.Is(err, closings.ErrInvalid) {
			t.Fatalf("%s must be refused with ErrInvalid, got %v", name, err)
		}
	}
	if ledger := e.scalar(t, "SELECT count(*) FROM branch_cash_movements"); ledger != 2 {
		t.Fatalf("a refused expense must write nothing: %d movements", ledger)
	}

	// A recorded expense never moves: the ledger is append only, and the correction is its
	// opposite movement (S12).
	if _, err := e.pool.Exec(e.ctx, "UPDATE branch_cash_movements SET amount=1.00"); err == nil {
		t.Fatal("a recorded expense must not be editable")
	}
	if _, err := e.pool.Exec(e.ctx, "DELETE FROM branch_cash_movements"); err == nil {
		t.Fatal("a recorded expense must not be deletable")
	}
}

// TestExpenseChangesOnlyTheSettlementThatCoversIt pins S8 with S12: the expense of a window is
// subtracted from the expected cash of the settlement that covers it, so its difference moves
// with it, and it changes nothing of a settlement that is already closed.
func TestExpenseChangesOnlyTheSettlementThatCoversIt(t *testing.T) {
	e := fixture(t)
	first := e.closeFirstSettlement(t, "200.00")
	settled := e.text(t, `SELECT opening_cash||':'||cash_sales||':'||cash_expenses||':'||sales_total
 ||':'||commission_amount||':'||counted_cash||':'||closing_cash
 FROM branch_closings WHERE id=$1`, first)

	// The branch pays 45.50 out of the till in the period the next settlement covers, and sells
	// 100.00 in cash inside it.
	e.expense(t, 2, "45.50", "Flete")
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	// The expense belongs to the window of this settlement, so its document states it, and the
	// settlement the earlier period closed has none.
	if len(opened.Expenses) != 1 || opened.Expenses[0].Amount != "45.50" {
		t.Fatalf("the document must state the expenses of its own window: %+v", opened.Expenses)
	}
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("250.00", "0.00", "50.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	proposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	// S8: 200.00 inherited plus 100.00 collected in cash minus 45.50 paid out is the drawer the
	// branch is charged, so the 250.00 counted is 4.50 short of it. Without the expense the
	// expected drawer would be 300.00 and the shortage 50.00: the expense is what moved both.
	if proposed.CashExpenses != "45.50" || proposed.ExpectedCash != "254.50" ||
		proposed.CashDifference == nil || string(*proposed.CashDifference) != "-4.50" {
		t.Fatalf("the expense must be subtracted from the expected drawer: %+v", proposed)
	}
	if offer := proposed.LatestRound().Payload; offer.CashExpenses != "45.50" {
		t.Fatalf("the offer must state the expense it is subtracting: %+v", offer)
	}

	// The settlement the earlier period closed is exactly as it was: its expense total, its
	// expected drawer, its difference and its fund did not move, and it covers no expense.
	if after := e.text(t, `SELECT opening_cash||':'||cash_sales||':'||cash_expenses||':'||sales_total
 ||':'||commission_amount||':'||counted_cash||':'||closing_cash
 FROM branch_closings WHERE id=$1`, first); after != settled {
		t.Fatalf("a closed settlement must not move: %q, was %q", after, settled)
	}
	closedFirst, err := e.store.Read(e.ctx, warehouse(), first)
	if err != nil || len(closedFirst.Expenses) != 0 || closedFirst.CashExpenses != "0.00" ||
		closedFirst.ExpectedCash != "0.00" || *closedFirst.CashDifference != "0.00" {
		t.Fatalf("an expense belongs to the settlement that covers it, not to an earlier one: %+v %v",
			closedFirst, err)
	}

	// The closure persists the offer it accepted: the expense stays subtracted where it was.
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the settlement: %v", err)
	}
	if closed.CashExpenses != "45.50" || closed.ExpectedCash != "254.50" ||
		string(*closed.CashDifference) != "-4.50" || len(closed.Expenses) != 1 {
		t.Fatalf("the closed settlement must keep the expense it settled: %+v", closed)
	}
}

// TestExpenseIsRefusedWhileTheSettlementIsLive pins S12 with S3: an expense recorded while a
// settlement holds the branch is refused by name, because the till it would move is the one
// being counted; the refusal writes nothing and the settlement keeps the facts it froze.
func TestExpenseIsRefusedWhileTheSettlementIsLive(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "100.00")
	e.expense(t, 2, "20.00", "Flete del período")
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	before := e.text(t, `SELECT status||':'||opening_cash||':'||cash_sales||':'||cash_expenses||':'
 ||sales_total FROM branch_closings WHERE id=$1`, opened.ID)

	// The frozen branch cannot load an expense: the refusal names the freeze and never the
	// settlement it is reading.
	_, err = e.store.RecordExpense(e.ctx, identity(2), money("10.00"), "Agua")
	refused(t, err, closings.ErrBranchFrozen)

	// Nothing was written and no counter moved: the ledger holds the expenses of the open
	// period and the closure's own movements, and the settlement is untouched.
	if gastos := e.scalar(t, `SELECT count(*) FROM branch_cash_movements WHERE kind='gasto'`); gastos != 1 {
		t.Fatalf("a refused expense must write nothing: %d expenses", gastos)
	}
	if ledger := e.scalar(t, `SELECT count(*) FROM branch_cash_movements`); ledger != 2 {
		t.Fatalf("a refused expense must not move the ledger: %d movements", ledger)
	}
	if after := e.text(t, `SELECT status||':'||opening_cash||':'||cash_sales||':'||cash_expenses||':'
 ||sales_total FROM branch_closings WHERE id=$1`, opened.ID); after != before {
		t.Fatalf("a refused expense must leave the settlement alone: %q, was %q", after, before)
	}
	if frozen := e.scalar(t, "SELECT (branch_closure_blocker(2::smallint))::int"); frozen != 1 {
		t.Fatal("the refusal must not unfreeze the branch")
	}
	// Once the settlement is closed the branch operates again and records its own expenses,
	// which belong to the period the next settlement will cover.
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("100.00", "0.00", "20.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	if _, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, ""); err != nil {
		t.Fatalf("the branch must accept the settlement: %v", err)
	}
	if _, err := e.store.RecordExpense(e.ctx, identity(2), money("10.00"), "Agua"); err != nil {
		t.Fatalf("a closed settlement must free its branch: %v", err)
	}
	closed, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil || len(closed.Expenses) != 1 || closed.Expenses[0].Amount != "20.00" {
		t.Fatalf("an expense recorded after the closure belongs to no closed window: %+v %v",
			closed.Expenses, err)
	}
}

// TestReadPublishesTheExpensesOfItsWindow pins S12 on the document: a settlement publishes the
// expenses of its own window with their amount and description, not only their total, so the
// warehouse reads what it is subtracting and the branch what it is being charged for.
func TestReadPublishesTheExpensesOfItsWindow(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "100.00")
	// Two expenses of this branch inside the period and one of another branch: the document is
	// one settlement of one branch.
	flete := e.expense(t, 2, "45.50", "Flete")
	insumos := e.expense(t, 2, "10.00", "Insumos")
	e.expense(t, 3, "99.00", "Flete de la otra sucursal")
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	assertExpenses := func(document closings.Closing) {
		t.Helper()
		if len(document.Expenses) != 2 {
			t.Fatalf("the document must list the expenses of its window: %+v", document.Expenses)
		}
		if document.Expenses[0].ID != flete.ID || document.Expenses[0].Amount != "45.50" ||
			document.Expenses[0].Description != "Flete" ||
			document.Expenses[1].ID != insumos.ID || document.Expenses[1].Amount != "10.00" ||
			document.Expenses[1].Description != "Insumos" {
			t.Fatalf("the listed expenses are not the ledger of the window: %+v", document.Expenses)
		}
		for _, expense := range document.Expenses {
			if expense.BranchID != 2 || expense.CreatedByAccountID != 2 || expense.OccurredAt.IsZero() ||
				expense.OccurredAt.Before(document.PeriodStart) || !expense.OccurredAt.Before(document.CutAt) {
				t.Fatalf("a listed expense must be a fact of the window of its own branch: %+v", expense)
			}
		}
	}
	assertExpenses(opened)

	// The list is the ledger, not the total: the total is the offer's, so it is still zero while
	// the warehouse holds the settlement, and the proposal freezes it.
	if opened.CashExpenses != "0.00" {
		t.Fatalf("a held settlement states no period total: %q", opened.CashExpenses)
	}
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("44.50", "0.00", "10.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	proposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	if proposed.CashExpenses != "55.50" || proposed.ExpectedCash != "44.50" {
		t.Fatalf("the proposal must freeze the total of the listed expenses: %+v", proposed)
	}
	assertExpenses(proposed)

	// The single read unfolds the document; a history row publishes its expenses as an empty
	// list, exactly like the sheet and the rounds.
	document, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be read: %v", err)
	}
	assertExpenses(document)
	page, err := e.store.List(e.ctx, warehouse(), 2, 1, 25)
	if err != nil || len(page.Closings) != 2 || len(page.Closings[0].Expenses) != 0 {
		t.Fatalf("a history row must not unfold the document: %+v %v", page, err)
	}
	// A closed settlement keeps the expenses it settled readable.
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the settlement: %v", err)
	}
	assertExpenses(closed)
	if closed.CashExpenses != "55.50" {
		t.Fatalf("the closed settlement must keep the total it settled: %q", closed.CashExpenses)
	}
}

// reserveStock promises units of one variant of a branch to a transfer and leaves the
// reservation open, which is the state a settlement can find and must refuse: the branch sends
// the units back to the warehouse and the warehouse approves, so the reservation is the
// transfer's own and the branch's stock is the only thing that changed (S3, LC007).
func (e *env) reserveStock(t *testing.T, branch int, variant, quantity int64) int64 {
	t.Helper()
	promises := transfers.New(e.pool)
	created, err := promises.Create(e.ctx, identity(branch), transfers.CreateInput{
		Kind: transfers.SendToWarehouse, CounterpartyID: 1,
		RetryKey: "reserve-the-units-of-a-settlement",
		Items:    []transfers.Line{{VariantID: variant, Quantity: quantity}},
	})
	if err != nil {
		t.Fatalf("the transfer reservation could not be created: %v", err)
	}
	if _, err := promises.Approve(e.ctx, warehouse(), created.Request.ID); err != nil {
		t.Fatalf("the transfer reservation could not be approved: %v", err)
	}
	return created.Request.ID
}

// awaitWaitingLock waits until a statement of this database is waiting for a table lock, which is
// how the proposal race below is armed without a sleep: a proposal that still waits for the sale
// ledger of the period has already read the count sheet and has not yet reached the database's
// transition.
func (e *env) awaitWaitingLock(t *testing.T, table string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int64
		if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM pg_locks
 WHERE relation=$1::regclass AND NOT granted`, table).Scan(&waiting); err != nil {
			t.Fatalf("the waiting lock could not be read: %v", err)
		}
		if waiting > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no statement ever waited for the %s table", table)
}

// TestClosureRefusesAVariantThatMovedByName pins LC018: a variant whose stock is no longer the
// quantity the count sheet photographed refuses the closure, and the refusal names that variant
// so the warehouse knows which line of the sheet is stale (S5). It is a conflict the operator
// answers by recounting, never an outage; nothing is applied, and putting the stock back is what
// unblocks the very same closure.
func TestClosureRefusesAVariantThatMovedByName(t *testing.T) {
	e := fixture(t)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("100.00", "0.00", "20.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	// A counted variant no longer holds what the sheet photographed. The freeze guards refuse
	// every branch operation while the settlement is open (S3), so this is the state a bypassed
	// guard leaves -- exactly the state the closure's own check exists for.
	if _, err := e.pool.Exec(e.ctx, `UPDATE inventory_balances SET existing=existing+1
 WHERE location_id=2 AND variant_id=2`); err != nil {
		t.Fatal("the branch stock could not be moved behind the settlement")
	}
	_, err = e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	var moved *closings.StockMoved
	if !errors.As(err, &moved) || moved.VariantID != 2 {
		t.Fatalf("a variant that moved must be refused by name: %v", err)
	}
	refused(t, err, closings.ErrStockMoved)
	// Nothing was applied: the drawer's money was not written, the stock is where it moved to and
	// the settlement is still the offer the branch was shown.
	if movements := e.scalar(t, `SELECT count(*) FROM branch_cash_movements
 WHERE closing_id=$1`, opened.ID); movements != 0 {
		t.Fatalf("a refused closure must write no cash movement: %d", movements)
	}
	if existing, _ := e.balance(t, 2, 2); existing != 5 {
		t.Fatalf("a refused closure must not apply the count: variant 2 is %d", existing)
	}
	if existing, _ := e.balance(t, 2, 1); existing != 10 {
		t.Fatalf("a refused closure must not apply the count: variant 1 is %d", existing)
	}
	if state := e.text(t, "SELECT status FROM branch_closings WHERE id=$1", opened.ID); state != "proposed" {
		t.Fatalf("a refused closure must leave the settlement proposed: %q", state)
	}
	// Restoring the photographed quantity is what closes the same settlement: the refusal was
	// the stale count and not a broken document.
	if _, err := e.pool.Exec(e.ctx, `UPDATE inventory_balances SET existing=4
 WHERE location_id=2 AND variant_id=2`); err != nil {
		t.Fatal("the branch stock could not be restored")
	}
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil || closed.Status != closings.StatusClosed {
		t.Fatalf("a restored branch must close: %+v %v", closed, err)
	}
}

// TestClosureRefusesAnOpenReservationByName pins LC007 with S5: a variant the branch still owes
// to a transfer blocks the closure and is named by the refusal, even when the count covers the
// reservation, because a reserved unit is stock the branch already promised.
func TestClosureRefusesAnOpenReservationByName(t *testing.T) {
	e := fixture(t)
	// The branch promises two units of variant 1 to the warehouse before the settlement freezes
	// it, so the reservation is the transfer's own and not a column this test typed.
	e.reserveStock(t, 2, 1, 2)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("100.00", "0.00", "20.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	_, err = e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	var reserved *closings.ReservedStock
	if !errors.As(err, &reserved) || reserved.VariantID != 1 {
		t.Fatalf("an open reservation must be refused by naming the variant: %v", err)
	}
	refused(t, err, closings.ErrReservedStock)
	// Nothing was applied: the reservation is intact, no money moved and the settlement is still
	// proposed.
	if existing, held := e.balance(t, 2, 1); existing != 10 || held != 2 {
		t.Fatalf("a refused closure must keep the reservation: %d/%d", existing, held)
	}
	if movements := e.scalar(t, `SELECT count(*) FROM branch_cash_movements
 WHERE closing_id=$1`, opened.ID); movements != 0 {
		t.Fatalf("a refused closure must write no cash movement: %d", movements)
	}
	if state := e.text(t, "SELECT status FROM branch_closings WHERE id=$1", opened.ID); state != "proposed" {
		t.Fatalf("a refused closure must leave the settlement proposed: %q", state)
	}
}

// TestProposalRaceIsAConflictNotAnOutage pins LC019: the count sheet can stop being complete in
// the window between the store's own check of the proposal and the database's transition. The
// refusal is a conflict that names the variant, because the operator re-reads the settlement and
// proposes again; reporting an outage would hide a document that is perfectly readable.
func TestProposalRaceIsAConflictNotAnOutage(t *testing.T) {
	e := fixture(t)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("100.00", "0.00", "20.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	// The rounds of the settlement are held, so the proposal stops after its last read of the
	// count sheet and before the database's transition. A line that becomes pending then is a
	// real race and not a scenario the store invents.
	blocker, err := e.pool.Begin(e.ctx)
	if err != nil {
		t.Fatalf("the blocking transaction could not start: %v", err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err := blocker.Exec(e.ctx, "LOCK TABLE closing_proposals IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatalf("the proposal rounds could not be held: %v", err)
	}
	proposed := make(chan error, 1)
	go func() {
		_, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
		proposed <- err
	}()
	e.awaitWaitingLock(t, "closing_proposals")
	if _, err := e.pool.Exec(e.ctx, `UPDATE closing_count_lines SET counted_quantity=NULL
 WHERE closing_id=$1 AND variant_id=2`, opened.ID); err != nil {
		t.Fatalf("the counted line could not be made pending again: %v", err)
	}
	if err := blocker.Commit(e.ctx); err != nil {
		t.Fatalf("the proposal rounds could not be released: %v", err)
	}
	err = <-proposed
	var stale *closings.StaleProposal
	if !errors.As(err, &stale) || stale.VariantID != 2 {
		t.Fatalf("the raced proposal must be refused by naming the pending variant: %v", err)
	}
	refused(t, err, closings.ErrProposalStale)
	// No round was written and the settlement is where it was: the operator counts the line and
	// proposes the very same settlement again.
	if rounds := e.scalar(t, `SELECT count(*) FROM closing_proposals WHERE closing_id=$1`,
		opened.ID); rounds != 0 {
		t.Fatalf("a refused proposal must write no round: %d", rounds)
	}
	if state := e.text(t, "SELECT status FROM branch_closings WHERE id=$1", opened.ID); state != "open" {
		t.Fatalf("a refused proposal must leave the settlement open: %q", state)
	}
	if _, err := e.store.Count(e.ctx, warehouse(), opened.ID,
		[]closings.Counted{{VariantID: 2, Quantity: 4}}); err != nil {
		t.Fatalf("the pending line could not be counted again: %v", err)
	}
	again, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil || again.Status != closings.StatusProposed || len(again.Rounds) != 1 {
		t.Fatalf("the settlement must be proposable again: %+v %v", again, err)
	}
}

// closePeriod walks one settlement of branch 2 after the first one to its closure: the period is
// opened, the sheet is counted with what the fixture holds, the drawer, the contribution and the
// fund are stated through the store's own draft, and the branch accepts the offer. It returns the
// closed document, which is what a correction corrects (S16).
func (e *env) closePeriod(t *testing.T, counted, contributed, fund string) closings.Closing {
	t.Helper()
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, closings.CashDraft{
		CountedCash: moneyPtr(counted), ContributedCash: money(contributed),
		ClosingCash: moneyPtr(fund), Observation: "caja del período"}); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the period could not be proposed: %v", err)
	}
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil || closed.Status != closings.StatusClosed {
		t.Fatalf("the branch must accept the offer: %+v %v", closed, err)
	}
	return closed
}

// drawer is a correction of the counted cash and nothing else, which is the fourth value S16
// names beside the count sheet, the commission and the fund.
func drawer(amount string) closings.CorrectionOffer {
	return closings.CorrectionOffer{CountedCash: moneyPtr(amount)}
}

// journalOf is the correction journal of one settlement as one value, so a test states exactly
// which deltas an acceptance applied -- kind, variant and the difference -- and proves that a
// refusal applied none.
func (e *env) journalOf(t *testing.T, closing int64) string {
	t.Helper()
	return e.text(t, `SELECT coalesce(string_agg(kind||':'||coalesce(variant_id::text,'0')||':'
 ||coalesce(quantity_delta::text,amount_delta::text),',' ORDER BY id),'')
 FROM closing_correction_effects WHERE closing_id=$1`, closing)
}

// balanceText is the whole balance matrix as one value, so "the correction moved no stock" is one
// comparison instead of a promise about every row.
func (e *env) balanceText(t *testing.T) string {
	t.Helper()
	return e.text(t, `SELECT coalesce(string_agg(location_id||':'||variant_id||':'||existing||':'
 ||reserved,',' ORDER BY location_id,variant_id),'') FROM inventory_balances`)
}

// ledgerOf is the branch's cash ledger as one value, so "the correction moved no money" is one
// comparison of the facts the branch signed.
func (e *env) ledgerOf(t *testing.T) string {
	t.Helper()
	return e.text(t, `SELECT coalesce(string_agg(kind||':'||amount||':'
 ||coalesce(closing_id::text,'-')||':'||description,',' ORDER BY id),'') FROM branch_cash_movements`)
}

// TestCorrectionOfTheCountedCashPublishesTheCorrectedDifference pins the fourth value of S16 on
// the store's own path: the warehouse proposes a correction of the counted cash with a mandatory
// reason, only the branch decides it, and the acceptance journals the delta without moving a peso
// -- the closed row keeps the drawer the branch signed while the document publishes the corrected
// difference, the corrected drawer and the corrected amount the warehouse took, with the
// correction and its reason beside them so a corrected number is legible as one.
func TestCorrectionOfTheCountedCashPublishesTheCorrectedDifference(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "300.00")
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	closed := e.closePeriod(t, "250.00", "0.00", "100.00")
	// The period collected 100 in cash over an inherited fund of 300, so the drawer should hold
	// 400 and the admin found 250: a shortage of 150, and 150 taken out of the till.
	if closed.ExpectedCash != "400.00" || closed.CashDifference == nil ||
		string(*closed.CashDifference) != "-150.00" || closed.TakenCash == nil ||
		string(*closed.TakenCash) != "150.00" {
		t.Fatalf("the fixture must close with the money it was signed with: %+v", closed)
	}
	ledger, stock := e.ledgerOf(t), e.balanceText(t)
	before := e.text(t, `SELECT counted_cash||':'||closing_cash||':'||commission_amount||':'||status
 FROM branch_closings WHERE id=$1`, closed.ID)

	// A branch never proposes a correction, neither of its own settlement nor of another
	// branch's: a correction is the warehouse's reading of the cut it performed (LC012).
	for _, actor := range []auth.Identity{identity(2), identity(3)} {
		refused(t, func() error {
			_, err := e.store.ProposeCorrection(e.ctx, actor, closed.ID, drawer("300.00"), "la caja estaba mal")
			return err
		}(), closings.ErrForbidden)
	}
	// The reason is mandatory, the offer has to state something, and every amount is canonical
	// money: a value this vertical would round is refused instead of applied (S20).
	refused(t, func() error {
		_, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID, drawer("300.00"), "   ")
		return err
	}(), closings.ErrInvalid)
	refused(t, func() error {
		_, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID, closings.CorrectionOffer{}, "sin nada")
		return err
	}(), closings.ErrInvalid)
	refused(t, func() error {
		rounded := closings.Money("300.555")
		_, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID,
			closings.CorrectionOffer{CountedCash: &rounded}, "media unidad")
		return err
	}(), closings.ErrInvalid)
	refused(t, func() error {
		_, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID+1000, drawer("300.00"), "otro cierre")
		return err
	}(), closings.ErrNotFound)
	if corrections := e.scalar(t, "SELECT count(*) FROM closing_corrections"); corrections != 0 {
		t.Fatalf("a refused proposal must write nothing: %d corrections", corrections)
	}

	// The warehouse proposes the corrected drawer with its reason, and nothing is applied yet.
	pending, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID, drawer("300.00"),
		"  el conteo de la caja estaba mal  ")
	if err != nil {
		t.Fatalf("the warehouse must propose a correction: %v", err)
	}
	if pending.Status != closings.CorrectionProposed || pending.ClosingID != closed.ID ||
		pending.Reason != "el conteo de la caja estaba mal" || pending.ProposedByAccountID != 1 ||
		pending.DecidedAt != nil || len(pending.Effects) != 0 || pending.Payload.CountedCash == nil ||
		*pending.Payload.CountedCash != "300.00" {
		t.Fatalf("the pending correction must state its offer and its reason: %+v", pending)
	}
	if journal := e.journalOf(t, closed.ID); journal != "" {
		t.Fatalf("a proposed correction applies nothing: %q", journal)
	}
	// One correction at a time: the warehouse waits for the branch.
	refused(t, func() error {
		_, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID, drawer("310.00"), "otra")
		return err
	}(), closings.ErrCorrectionPending)
	// Only an enabled account of the branch decides, and an acceptance carries no rejection reason.
	for _, actor := range []auth.Identity{warehouse(), identity(3)} {
		refused(t, func() error {
			_, err := e.store.DecideCorrection(e.ctx, actor, pending.ID, closings.DecisionAccepted, "")
			return err
		}(), closings.ErrForbidden)
	}
	refused(t, func() error {
		_, err := e.store.DecideCorrection(e.ctx, identity(2), pending.ID, closings.DecisionAccepted, "soborno")
		return err
	}(), closings.ErrInvalid)
	refused(t, func() error {
		_, err := e.store.DecideCorrection(e.ctx, identity(2), pending.ID, closings.DecisionRejected, "  ")
		return err
	}(), closings.ErrInvalid)
	refused(t, func() error {
		_, err := e.store.DecideCorrection(e.ctx, identity(2), pending.ID, closings.Decision("maybe"), "no")
		return err
	}(), closings.ErrInvalid)
	refused(t, func() error {
		_, err := e.store.DecideCorrection(e.ctx, identity(2), pending.ID+1000, closings.DecisionAccepted, "")
		return err
	}(), closings.ErrNotFound)

	accepted, err := e.store.DecideCorrection(e.ctx, identity(2), pending.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the correction: %v", err)
	}
	if accepted.Status != closings.CorrectionAccepted || accepted.DecidedAt == nil ||
		accepted.DecidedByAccountID == nil || *accepted.DecidedByAccountID != 2 ||
		len(accepted.Effects) != 1 {
		t.Fatalf("the acceptance must be one version with its applied delta: %+v", accepted)
	}
	effect := accepted.Effects[0]
	if effect.Kind != closings.CorrectionKindCountedCash || effect.AmountDelta == nil ||
		*effect.AmountDelta != "50.00" || effect.VariantID != nil || effect.QuantityDelta != nil {
		t.Fatalf("the drawer delta must be one amount of its own kind: %+v", effect)
	}
	if journal := e.journalOf(t, closed.ID); journal != "counted_cash:0:50.00" {
		t.Fatalf("exactly one drawer delta must be journalled, got %q", journal)
	}
	// A decided correction is final: it is not decided again (LC013).
	refused(t, func() error {
		_, err := e.store.DecideCorrection(e.ctx, identity(2), pending.ID, closings.DecisionRejected, "tarde")
		return err
	}(), closings.ErrCorrectionDecided)

	// The published document follows the journal: the corrected drawer, the corrected difference
	// and the corrected amount taken out of the till, with the commission still the settled one
	// and the expected cash untouched.
	document, err := e.store.Read(e.ctx, warehouse(), closed.ID)
	if err != nil {
		t.Fatalf("the corrected settlement could not be read: %v", err)
	}
	if document.CountedCash == nil || *document.CountedCash != "300.00" ||
		document.CashDifference == nil || string(*document.CashDifference) != "-100.00" ||
		document.TakenCash == nil || string(*document.TakenCash) != "200.00" ||
		document.ExpectedCash != "400.00" || document.ClosingCash == nil ||
		*document.ClosingCash != "100.00" || document.CommissionAmount != "12.50" ||
		document.Status != closings.StatusClosed {
		t.Fatalf("the document must publish the corrected drawer: %+v", document)
	}
	// A client can tell which number is the result of a correction: the accepted correction is
	// published with its reason and the delta it applied.
	if len(document.Corrections) != 1 {
		t.Fatalf("the accepted correction must be published with the document: %+v", document.Corrections)
	}
	published := document.Corrections[0]
	if published.ID != pending.ID || published.Reason != "el conteo de la caja estaba mal" ||
		published.Status != closings.CorrectionAccepted || published.DecidedByAccountID == nil ||
		*published.DecidedByAccountID != 2 || len(published.Effects) != 1 ||
		*published.Effects[0].AmountDelta != "50.00" {
		t.Fatalf("the published correction must carry its reason and its delta: %+v", published)
	}
	// The settlement's own row still states what the branch signed, and the correction moved no
	// money and no stock: the drawer holds what it holds.
	if after := e.text(t, `SELECT counted_cash||':'||closing_cash||':'||commission_amount||':'||status
 FROM branch_closings WHERE id=$1`, closed.ID); after != before {
		t.Fatalf("the closed settlement must keep the numbers it was signed with: %q before %q", after, before)
	}
	if after := e.ledgerOf(t); after != ledger {
		t.Fatalf("a drawer correction must not write the cash ledger: %q before %q", after, ledger)
	}
	if after := e.balanceText(t); after != stock {
		t.Fatalf("a drawer correction must not move stock: %q before %q", after, stock)
	}
	// The history row is the same money as the document, so no row can disagree with it.
	page, err := e.store.List(e.ctx, warehouse(), 2, 1, 25)
	if err != nil {
		t.Fatalf("the history of the branch could not be read: %v", err)
	}
	if len(page.Closings) != 2 || page.Closings[0].ID != closed.ID ||
		page.Closings[0].CountedCash == nil || *page.Closings[0].CountedCash != "300.00" ||
		page.Closings[0].CashDifference == nil || string(*page.Closings[0].CashDifference) != "-100.00" {
		t.Fatalf("the history must publish the corrected money of the document: %+v", page.Closings[0])
	}
	// The branch reads its own corrected settlement, and its own correction is not published to
	// another branch.
	own, err := e.store.Read(e.ctx, identity(2), closed.ID)
	if err != nil || len(own.Corrections) != 1 {
		t.Fatalf("the branch must read the correction of its own settlement: %+v %v", own, err)
	}
	refused(t, func() error { _, err := e.store.Read(e.ctx, identity(3), closed.ID); return err }(),
		closings.ErrNotFound)
}

// TestPendingCorrectionIsPublishedWithItsStatus pins the surface half of S16 that the store owns:
// a correction the branch still has to decide is published with the document, with its status, its
// reason, its payload and the account that proposed it, because otherwise no screen of the branch
// could know that something awaits a decision. The numbers it would change stay the signed ones
// until the acceptance, and an accepted correction keeps being published exactly as it was, with
// the deltas it applied (S16).
func TestPendingCorrectionIsPublishedWithItsStatus(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "300.00")
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	closed := e.closePeriod(t, "250.00", "0.00", "100.00")

	// A closure with no correction publishes none: the document never invents a correction.
	fresh, err := e.store.Read(e.ctx, identity(2), closed.ID)
	if err != nil || len(fresh.Corrections) != 0 {
		t.Fatalf("a settlement with no correction must publish none: %+v %v", fresh.Corrections, err)
	}

	pending, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID, closings.CorrectionOffer{
		CountedQuantities: []closings.Counted{{VariantID: 1, Quantity: 3}},
		CountedCash:       moneyPtr("300.00"),
	}, "  conté mal la caja y una batería  ")
	if err != nil {
		t.Fatalf("the warehouse must propose a correction: %v", err)
	}
	// Both the branch that has to decide it and the warehouse that proposed it read it as a pending
	// version of the closed settlement, with its author and its stated values and no delta at all.
	for _, actor := range []auth.Identity{identity(2), warehouse()} {
		document, err := e.store.Read(e.ctx, actor, closed.ID)
		if err != nil {
			t.Fatalf("the settlement could not be read: %v", err)
		}
		if len(document.Corrections) != 1 {
			t.Fatalf("the pending correction must be published: %+v", document.Corrections)
		}
		published := document.Corrections[0]
		if published.ID != pending.ID || published.ClosingID != closed.ID ||
			published.Status != closings.CorrectionProposed ||
			published.Reason != "conté mal la caja y una batería" ||
			published.ProposedByAccountID != 1 || published.ProposedAt.IsZero() ||
			published.DecidedByAccountID != nil || published.DecidedAt != nil ||
			published.DecisionReason != "" || len(published.Effects) != 0 {
			t.Fatalf("the pending correction must state its offer and its author: %+v", published)
		}
		if published.Payload.CountedCash == nil || *published.Payload.CountedCash != "300.00" ||
			len(published.Payload.CountedQuantities) != 1 ||
			published.Payload.CountedQuantities[0].VariantID != 1 ||
			published.Payload.CountedQuantities[0].Quantity != 3 {
			t.Fatalf("the pending correction must publish what it would change: %+v", published.Payload)
		}
		// A decision that has not been taken applies nothing: the document keeps the signed drawer.
		if document.CountedCash == nil || *document.CountedCash != "250.00" ||
			document.CashDifference == nil || string(*document.CashDifference) != "-150.00" ||
			document.TakenCash == nil || string(*document.TakenCash) != "150.00" ||
			document.Status != closings.StatusClosed {
			t.Fatalf("a pending correction must change no published number: %+v", document)
		}
	}
	if journal := e.journalOf(t, closed.ID); journal != "" {
		t.Fatalf("a pending correction applies no delta: %q", journal)
	}
	// An accepted correction keeps the shape it already published, and the pending one follows it:
	// the document carries both with their own status instead of one replacing the other.
	if _, err := e.store.DecideCorrection(e.ctx, identity(2), pending.ID, closings.DecisionAccepted, ""); err != nil {
		t.Fatalf("the branch must accept the correction: %v", err)
	}
	second, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID,
		closings.CorrectionOffer{CommissionAmount: moneyPtr("20.00")}, "la comisión estaba mal")
	if err != nil {
		t.Fatalf("the warehouse must propose a second correction: %v", err)
	}
	document, err := e.store.Read(e.ctx, identity(2), closed.ID)
	if err != nil || len(document.Corrections) != 2 {
		t.Fatalf("the document must publish the accepted correction and the pending one: %+v %v",
			document.Corrections, err)
	}
	accepted, next := document.Corrections[0], document.Corrections[1]
	if accepted.ID != pending.ID || accepted.Status != closings.CorrectionAccepted ||
		accepted.DecidedByAccountID == nil || *accepted.DecidedByAccountID != 2 ||
		accepted.DecidedAt == nil || len(accepted.Effects) != 2 {
		t.Fatalf("the accepted correction must keep the deltas it applied: %+v", accepted)
	}
	if next.ID != second.ID || next.Status != closings.CorrectionProposed ||
		next.DecidedAt != nil || len(next.Effects) != 0 ||
		next.Payload.CommissionAmount == nil || *next.Payload.CommissionAmount != "20.00" {
		t.Fatalf("the pending correction must follow the accepted one: %+v", next)
	}
	// The accepted one is what the numbers follow; the pending commission is still not applied.
	if document.CountedCash == nil || *document.CountedCash != "300.00" ||
		document.CommissionAmount != "12.50" {
		t.Fatalf("only the accepted correction moves a published number: %+v", document)
	}
}

// TestRejectedCorrectionChangesNothing pins the other half of S16: a rejection states its reason,
// applies nothing, keeps the settlement closed and the branch operating, and leaves room for the
// next round -- the warehouse corrects again and the branch accepts what it can.
func TestRejectedCorrectionChangesNothing(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "300.00")
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	closed := e.closePeriod(t, "250.00", "0.00", "100.00")
	ledger, stock := e.ledgerOf(t), e.balanceText(t)

	// One correction states the count sheet and the drawer together, which is the round the branch
	// decides as a whole (S14).
	proposed, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID, closings.CorrectionOffer{
		CountedQuantities: []closings.Counted{{VariantID: 1, Quantity: 20}},
		CountedCash:       moneyPtr("400.00"),
	}, "el conteo y la caja estaban mal")
	if err != nil {
		t.Fatalf("the warehouse must propose a correction of both facts: %v", err)
	}
	rejected, err := e.store.DecideCorrection(e.ctx, identity(2), proposed.ID,
		closings.DecisionRejected, "  el conteo estaba bien  ")
	if err != nil {
		t.Fatalf("the branch must reject the correction: %v", err)
	}
	if rejected.Status != closings.CorrectionRejected || rejected.DecisionReason != "el conteo estaba bien" ||
		rejected.DecidedByAccountID == nil || *rejected.DecidedByAccountID != 2 || len(rejected.Effects) != 0 {
		t.Fatalf("a rejection must be one version with its reason and no delta: %+v", rejected)
	}
	// Nothing was applied: no journal row, no stock, no money, and the settlement is still the one
	// the branch signed.
	if journal := e.journalOf(t, closed.ID); journal != "" {
		t.Fatalf("a rejected correction must apply no delta: %q", journal)
	}
	if after := e.balanceText(t); after != stock {
		t.Fatalf("a rejected correction must not move stock: %q before %q", after, stock)
	}
	if after := e.ledgerOf(t); after != ledger {
		t.Fatalf("a rejected correction must not write the ledger: %q before %q", after, ledger)
	}
	document, err := e.store.Read(e.ctx, warehouse(), closed.ID)
	if err != nil {
		t.Fatalf("the settlement could not be read: %v", err)
	}
	if *document.CountedCash != "250.00" || string(*document.CashDifference) != "-150.00" ||
		len(document.Corrections) != 0 || document.Status != closings.StatusClosed {
		t.Fatalf("a rejection must change nothing the document publishes: %+v", document)
	}
	var state string
	if state = e.text(t, `SELECT status||':'||decision_reason FROM closing_corrections WHERE id=$1`,
		proposed.ID); state != "rejected:el conteo estaba bien" {
		t.Fatalf("the rejection must stay recorded with its reason: %q", state)
	}
	if frozen := e.scalar(t, "SELECT (branch_closure_blocker(2::smallint))::int"); frozen != 0 {
		t.Fatal("a correction must never freeze the branch")
	}

	// No limit of rounds: the warehouse corrects again and the branch accepts it.
	again, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID, drawer("400.00"),
		"la caja sí estaba mal")
	if err != nil {
		t.Fatalf("a correction after a rejection must be proposable: %v", err)
	}
	if _, err := e.store.DecideCorrection(e.ctx, identity(2), again.ID, closings.DecisionAccepted, ""); err != nil {
		t.Fatalf("the branch must accept the next correction: %v", err)
	}
	corrected, err := e.store.Read(e.ctx, warehouse(), closed.ID)
	if err != nil || corrected.CountedCash == nil || *corrected.CountedCash != "400.00" ||
		corrected.CashDifference == nil || *corrected.CashDifference != "0.00" ||
		len(corrected.Corrections) != 1 {
		t.Fatalf("the accepted correction must publish the corrected drawer: %+v %v", corrected, err)
	}
}

// TestCorrectionNeedsAClosedSettlement pins the door of S16: the count sheet and the drawer of a
// live settlement are corrected by its own rounds, so a correction is refused with its own code
// and names the settlement -- never an outage -- and nothing is written. A payload the closed
// settlement cannot take, like a variant its sheet never counted, is refused as a payload.
func TestCorrectionNeedsAClosedSettlement(t *testing.T) {
	e := fixture(t)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	// An open settlement has no closure to correct, and the refusal names it.
	_, err = e.store.ProposeCorrection(e.ctx, warehouse(), opened.ID, drawer("100.00"), "todavía no cerró")
	var notClosed *closings.CorrectionNotClosed
	if !errors.As(err, &notClosed) || notClosed.ClosingID != opened.ID {
		t.Fatalf("a correction of an open settlement must be refused by name: %v", err)
	}
	refused(t, err, closings.ErrCorrectionNotClosed)
	// Neither does a proposed or a rejected one: it is the same document, still live.
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, draft("100.00", "0.00", "20.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	refused(t, func() error {
		_, err := e.store.ProposeCorrection(e.ctx, warehouse(), opened.ID, drawer("100.00"), "ya lo decidimos")
		return err
	}(), closings.ErrCorrectionNotClosed)
	if corrections := e.scalar(t, "SELECT count(*) FROM closing_corrections"); corrections != 0 {
		t.Fatalf("a refused correction must write nothing: %d corrections", corrections)
	}

	// The settlement the branch rejected is still live: a correction is proposed for a closed one
	// only, and the branch has already answered the offer it was shown.
	if _, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionRejected, "el conteo estaba mal"); err != nil {
		t.Fatalf("the branch must reject the offer: %v", err)
	}
	refused(t, func() error {
		_, err := e.store.ProposeCorrection(e.ctx, warehouse(), opened.ID, drawer("100.00"), "otra vez no")
		return err
	}(), closings.ErrCorrectionNotClosed)
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement must be proposable again: %v", err)
	}
	if _, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, ""); err != nil {
		t.Fatalf("the branch must accept the offer: %v", err)
	}

	// A variant the closed settlement never counted has no recorded quantity to take a difference
	// against, so the proposal is refused as a payload (LC021) -- a fact only the closed sheet
	// knows, which is why the store does not guess it.
	closed, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil || closed.Status != closings.StatusClosed {
		t.Fatalf("the settlement must be closed before it is corrected: %+v %v", closed, err)
	}
	_, err = e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID, closings.CorrectionOffer{
		CountedQuantities: []closings.Counted{{VariantID: 3, Quantity: 1}},
	}, "un variant que no estaba")
	refused(t, err, closings.ErrCorrectionPayload)
	// A count line and a drawer in one correction is the shape of S14 and it is admitted.
	mixed, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID, closings.CorrectionOffer{
		CountedQuantities: []closings.Counted{{VariantID: 1, Quantity: 8}},
		CountedCash:       moneyPtr("120.00"),
	}, "el conteo y la caja")
	if err != nil || len(mixed.Payload.CountedQuantities) != 1 ||
		*mixed.Payload.CountedCash != "120.00" || mixed.Payload.ClosingCash != nil {
		t.Fatalf("the whole offer must be stored as proposed: %+v %v", mixed, err)
	}
	accepted, err := e.store.DecideCorrection(e.ctx, identity(2), mixed.ID, closings.DecisionAccepted, "")
	if err != nil || len(accepted.Effects) != 2 {
		t.Fatalf("an accepted correction must journal each fact it moved: %+v %v", accepted, err)
	}
	if journal := e.journalOf(t, closed.ID); journal != "stock:1:-2,counted_cash:0:20.00" {
		t.Fatalf("the stock and the drawer must be two deltas of their own, got %q", journal)
	}
}

// TestCorrectionFundLandsOnce pins the fund delta of 036 through the store's own path: the
// corrected fund is the opening cash of the next period, applied exactly once, and once that
// period exists the fund is refused with its own code (LC022) while the drawer of the same
// settlement is still correctable, because it moves no money of the next period.
func TestCorrectionFundLandsOnce(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "300.00")
	closed := e.closePeriod(t, "400.00", "0.00", "100.00")
	ledger := e.ledgerOf(t)

	fund, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID,
		closings.CorrectionOffer{ClosingCash: moneyPtr("60.00")}, "el fondo era 60")
	if err != nil {
		t.Fatalf("the warehouse must propose a fund correction: %v", err)
	}
	accepted, err := e.store.DecideCorrection(e.ctx, identity(2), fund.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the fund correction: %v", err)
	}
	if len(accepted.Effects) != 1 || accepted.Effects[0].Kind != closings.CorrectionKindFund ||
		*accepted.Effects[0].AmountDelta != "-40.00" {
		t.Fatalf("the fund delta must be journalled: %+v", accepted.Effects)
	}
	// The corrected fund is the drawer chain's: the document publishes it and the amount taken out
	// of the till that follows from it, while the ledger keeps the movement it made.
	document, err := e.store.Read(e.ctx, warehouse(), closed.ID)
	if err != nil || document.ClosingCash == nil || *document.ClosingCash != "60.00" ||
		document.TakenCash == nil || string(*document.TakenCash) != "340.00" ||
		*document.CountedCash != "400.00" {
		t.Fatalf("the document must publish the corrected fund: %+v %v", document, err)
	}
	if after := e.ledgerOf(t); after != ledger {
		t.Fatalf("a fund correction must not write the cash ledger: %q before %q", after, ledger)
	}
	// The next period opens with the corrected fund, and the delta is not applied again.
	next, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil || next.OpeningCash != "60.00" {
		t.Fatalf("the next period must inherit the corrected fund: %+v %v", next, err)
	}
	// Once that period started there is no coherent place for a second fund delta, and the refusal
	// is the correction's own code instead of an outage.
	late, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID,
		closings.CorrectionOffer{ClosingCash: moneyPtr("80.00")}, "el fondo era 80")
	if err != nil {
		t.Fatalf("the warehouse must be able to propose it: %v", err)
	}
	before := e.journalOf(t, closed.ID)
	_, err = e.store.DecideCorrection(e.ctx, identity(2), late.ID, closings.DecisionAccepted, "")
	refused(t, err, closings.ErrCorrectionFundStarted)
	if after := e.journalOf(t, closed.ID); after != before {
		t.Fatalf("a refused fund correction must apply no delta: %q before %q", after, before)
	}
	if status := e.text(t, "SELECT status FROM closing_corrections WHERE id=$1", late.ID); status != "proposed" {
		t.Fatalf("a refused fund correction stays pending for the branch to reject: %q", status)
	}
	// The drawer of the closed settlement is still correctable: it moves no money of the period
	// that already started.
	if _, err := e.store.DecideCorrection(e.ctx, identity(2), late.ID, closings.DecisionRejected, "ya hay otro período"); err != nil {
		t.Fatalf("the branch must be able to reject it: %v", err)
	}
	drawerCorrection, err := e.store.ProposeCorrection(e.ctx, warehouse(), closed.ID, drawer("410.00"),
		"la caja era 410")
	if err != nil {
		t.Fatalf("the drawer must still be correctable: %v", err)
	}
	if _, err := e.store.DecideCorrection(e.ctx, identity(2), drawerCorrection.ID, closings.DecisionAccepted, ""); err != nil {
		t.Fatalf("the drawer correction must be accepted: %v", err)
	}
	corrected, err := e.store.Read(e.ctx, warehouse(), closed.ID)
	if err != nil || *corrected.CountedCash != "410.00" || *corrected.ClosingCash != "60.00" {
		t.Fatalf("the corrected drawer must build on the corrected fund: %+v %v", corrected, err)
	}
	// The delta lands once: the period that already started keeps the fund it inherited.
	if opening := e.text(t, "SELECT opening_cash::text FROM branch_closings WHERE id=$1", next.ID); opening != "60.00" {
		t.Fatalf("the started period must keep its opening cash: %q", opening)
	}
}
