package closings_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/closings"
	"luson/api/internal/config"
	"luson/api/internal/pricing"
	"luson/api/internal/purchases"
	"luson/api/internal/sales"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

// env is one isolated database with the settlement store on top of the trial catalogue.
// Without an admitted LUSON_TEST_PG_MANIFEST every test below fails closed at testpg.Open
// and that is the expected local outcome.
type env struct {
	ctx       context.Context
	pool      *pgxpool.Pool
	store     *closings.Store
	sales     *sales.Store
	prices    *pricing.Store
	purchases *purchases.Store
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
	e := &env{ctx: ctx, pool: p, store: closings.New(p), sales: sales.New(p), prices: pricing.New(p),
		purchases: purchases.New(p)}
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

// product writes one other product of the catalogue with one typed field per name, the way the
// catalogue writes it (055): a free name, no battery shape and one polarity-less variant. It returns
// the variant the count sheet names, so a sheet of the second kind is written by the real triggers.
func (e *env) product(t *testing.T, name string, fieldNames ...string) int64 {
	t.Helper()
	var entry int64
	if err := e.pool.QueryRow(e.ctx, `INSERT INTO catalog_entries(kind,name) VALUES('other',$1)
 RETURNING id`, name).Scan(&entry); err != nil {
		t.Fatalf("product fixture %q failed: %v", name, err)
	}
	for index, field := range fieldNames {
		if _, err := e.pool.Exec(e.ctx, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,unit,number_value)
 VALUES($1,$2,'number','L',$3)`, entry, field, index+1); err != nil {
			t.Fatalf("product field fixture %q failed: %v", field, err)
		}
	}
	var variant int64
	if err := e.pool.QueryRow(e.ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1)
 RETURNING id`, entry).Scan(&variant); err != nil {
		t.Fatalf("product variant fixture %q failed: %v", name, err)
	}
	return variant
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
		Customer: sales.Customer{Name: "Cliente de sucursal", Phone: "700-00000",
			Document: "CI-123456"},
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

// contribute funds the till of one branch through the branch's own path: an aporte is a movement of
// its book like any other, and it is the one direction the drawer never refuses, so it is what makes a
// pay-out reachable on a till that inherited nothing (S1, S3).
func (e *env) contribute(t *testing.T, branch int, amount, description string) closings.Expense {
	t.Helper()
	contribution, err := e.store.RecordCashMovement(e.ctx, identity(branch), "aporte",
		closings.Money(amount), description)
	if err != nil {
		t.Fatalf("the branch contribution %q could not be recorded: %v", description, err)
	}
	return contribution
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

// livePeriod walks the branch to a settlement the warehouse still holds over a period that has
// money of every source: one sale paid in cash and one by each electronic method, and one expense
// the branch recorded before the cut. It is the state a read has to fill in from the ledgers.
func (e *env) livePeriod(t *testing.T) closings.Closing {
	t.Helper()
	e.closeFirstSettlement(t, "500.00")
	const qr = sales.PaymentMethod("qr")
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	e.sell(t, 2, 1, "50.00", sales.PaymentCard)
	e.sell(t, 1, 1, "20.00", sales.PaymentTransfer)
	e.sell(t, 2, 1, "30.00", qr)
	// The expense is recorded before the cut, because the ledger of the branch is closed while its
	// settlement holds it: the period's only expense is the one already spent out of the till.
	e.expense(t, 2, "12.50", "Flete del período")
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("610.00", "0.00", "110.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	return opened
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

// TestCommissionsAreWhatThePanelReads pins S2 and S4 of the commission panel: the configured
// commissions of every branch come back in one call, with the account that fixed each rate and
// the moment it did, and a branch the warehouse never configured is absent instead of invented.
func TestCommissionsAreWhatThePanelReads(t *testing.T) {
	e := fixture(t)

	// The panel of a fresh installation has nothing to show, never one entry per branch with
	// no rate: a branch without a configuration is what blocks its settlement.
	if _, err := e.pool.Exec(e.ctx, `DELETE FROM branch_settings`); err != nil {
		t.Fatalf("the fixture settings could not be cleared: %v", err)
	}
	if _, err := e.pool.Exec(e.ctx, `UPDATE auth_accounts SET display_name='Almacén' WHERE id=1`); err != nil {
		t.Fatalf("the fixture name could not be set: %v", err)
	}
	configured, err := e.store.Commissions(e.ctx, warehouse())
	if err != nil || len(configured) != 0 {
		t.Fatalf("no branch has a configured commission yet: %+v %v", configured, err)
	}

	for _, branch := range []struct {
		id   int64
		rate string
	}{{2, "4.5"}, {3, "100.00"}} {
		if _, err := e.store.ConfigureCommission(e.ctx, warehouse(), branch.id, closings.Percent(branch.rate)); err != nil {
			t.Fatalf("the warehouse must configure branch %d: %v", branch.id, err)
		}
	}
	configured, err = e.store.Commissions(e.ctx, warehouse())
	if err != nil {
		t.Fatalf("the warehouse must read the configured commissions: %v", err)
	}
	if len(configured) != 2 {
		t.Fatalf("the panel reads one entry per configured branch: %+v", configured)
	}
	if configured[0].BranchID != 2 || configured[0].Rate != "4.50" ||
		configured[1].BranchID != 3 || configured[1].Rate != "100.00" {
		t.Fatalf("the configured rates are not what the warehouse wrote: %+v", configured)
	}
	// The audit the panel shows beside each rate: which account fixed it, and when.
	if configured[0].UpdatedBy != "Almacén" || configured[0].UpdatedAt.IsZero() {
		t.Fatalf("the commission does not say who fixed it and when: %+v", configured[0])
	}

	// Only the warehouse reads the panel: a branch reads no list of rates, and neither does
	// an identity that is not an account at all.
	_, err = e.store.Commissions(e.ctx, identity(2))
	refused(t, err, closings.ErrForbidden)
	_, err = e.store.Commissions(e.ctx, auth.Identity{})
	refused(t, err, closings.ErrForbidden)

	// A changed rate replaces the configured one: the list never grows a second entry.
	if _, err := e.store.ConfigureCommission(e.ctx, warehouse(), 2, "5"); err != nil {
		t.Fatalf("the warehouse must change a configured commission: %v", err)
	}
	configured, err = e.store.Commissions(e.ctx, warehouse())
	if err != nil || len(configured) != 2 || configured[0].Rate != "5.00" {
		t.Fatalf("the changed commission is not what the warehouse wrote: %+v %v", configured, err)
	}

	// A retired branch keeps no place in the panel: deleting it from the directory takes its rate
	// out of the list instead of leaving an entry the panel cannot place.
	e.retireBranch(t, 3)
	configured, err = e.store.Commissions(e.ctx, warehouse())
	if err != nil || len(configured) != 1 || configured[0].BranchID != 2 {
		t.Fatalf("a retired branch is not a configured branch: %+v %v", configured, err)
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
	// The snapshot opens counted at its own number (S1): the sheet of a live settlement never
	// states a missing quantity, so the warehouse only writes the lines that disagree.
	for _, line := range opened.CountLines {
		want := map[int64]int64{1: 10, 2: 4}[line.VariantID]
		if line.ExpectedQuantity != want || line.CountedQuantity == nil || *line.CountedQuantity != want {
			t.Fatalf("variant %d: expected %d counted at the open, got %+v", line.VariantID, want, line)
		}
		if line.Identity.Kind != catalog.BatteryKind || line.Identity.Battery == nil ||
			line.Identity.Battery.Brand == "" || line.Identity.Battery.Model == "" ||
			line.Identity.Battery.Polarity == "" || line.Identity.Battery.Capacity == "" {
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

// TestOpenReadsBothKindsOfTheCountSheet pins S2, S5 and S12. The sheet of the cut seeds every variant
// the branch holds, so a branch with product stock has a product line, and the read must publish it
// with the identity of its kind instead of failing closed. A battery line keeps publishing exactly
// what it published before the second kind existed, so a settlement written under the old contract
// reads the same, and a product line is still written with the quantity the database snapshotted.
func TestOpenReadsBothKindsOfTheCountSheet(t *testing.T) {
	e := fixture(t)
	product := e.product(t, "Agua acidulada", "volumen")
	e.seedStock(t, 2, map[int64]int64{1: 10, product: 3})
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("a branch that holds a product must publish its settlement: %v", err)
	}
	if len(opened.CountLines) != 2 {
		t.Fatalf("the sheet must list the battery and the product: %+v", opened.CountLines)
	}
	battery, other := opened.CountLines[0], opened.CountLines[1]
	// The battery line of an old settlement still states brand, model, capacity and polarity, and
	// nothing of the second kind.
	if battery.Identity.Kind != catalog.BatteryKind || battery.Identity.Battery == nil ||
		battery.Identity.Fields != nil || battery.Identity.Battery.Brand == "" ||
		battery.Identity.Battery.Model == "" || battery.Identity.Battery.Polarity == "" ||
		battery.Identity.Battery.Capacity == "" ||
		battery.Identity.Name != catalog.BatteryName(battery.Identity.Battery.Brand,
			battery.Identity.Battery.Model) ||
		battery.Identity.Detail != catalog.BatteryDetail(battery.Identity.Battery.Capacity,
			battery.Identity.Battery.Polarity) {
		t.Fatalf("the battery line must keep its battery identity: %+v", battery)
	}
	if battery.ExpectedQuantity != 10 || battery.CountedQuantity == nil || *battery.CountedQuantity != 10 {
		t.Fatalf("the battery line must keep its snapshot: %+v", battery)
	}
	// The product line states its own identity -- the name it is sold by and the detail the catalogue
	// composes of its typed fields -- and no battery attribute at all.
	if other.Identity.Kind != catalog.OtherKind || other.Identity.Battery != nil ||
		other.Identity.Name != "Agua acidulada" || other.Identity.Detail != "volumen: 1 L" ||
		len(other.Identity.Fields) != 1 {
		t.Fatalf("the product line must state its own identity: %+v", other)
	}
	// The expected quantity is the snapshot the database took of the branch balance, for both kinds
	// (S5): it is never stated by the caller.
	if other.ExpectedQuantity != 3 || other.CountedQuantity == nil || *other.CountedQuantity != 3 {
		t.Fatalf("the product line must carry the balance the trigger seeded: %+v", other)
	}
	// Counting a product is writing a line like any other, and the expected quantity does not follow
	// the count.
	counted, err := e.store.Count(e.ctx, warehouse(), opened.ID,
		[]closings.Counted{{VariantID: product, Quantity: 1}})
	if err != nil {
		t.Fatalf("a product must be counted like a battery: %v", err)
	}
	if len(counted.CountLines) != 2 || counted.CountLines[1].ExpectedQuantity != 3 ||
		counted.CountLines[1].CountedQuantity == nil || *counted.CountLines[1].CountedQuantity != 1 {
		t.Fatalf("the count must be recorded against the snapshot: %+v", counted.CountLines)
	}
	// Reading the same document again says the same: the sheet is a fact of the cut, not a live read.
	read, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement of a branch with products must be legible: %v", err)
	}
	if !reflect.DeepEqual(read.CountLines, counted.CountLines) {
		t.Fatalf("the sheet must read the same twice: %+v then %+v", counted.CountLines, read.CountLines)
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

	// The admin counts a seeded line and a variant the system did not have at all: the snapshot
	// of the second one is zero, and it was never a caller value. The line it never names keeps
	// the quantity the opener seeded into it (S1), so it is the agreement, not a pending duty.
	counted, err := e.store.Count(e.ctx, warehouse(), opened.ID,
		[]closings.Counted{{VariantID: 1, Quantity: 7}, {VariantID: 3, Quantity: 2}})
	if err != nil {
		t.Fatalf("the warehouse must record what it counted: %v", err)
	}
	if got := sheet(counted); got != "1:10:7,2:4:4,3:0:2" {
		t.Fatalf("the count sheet is not the snapshot plus the counted quantities: %q", got)
	}

	// A recount only changes what was counted, never the expected snapshot.
	again, err := e.store.Count(e.ctx, warehouse(), opened.ID, []closings.Counted{{VariantID: 1, Quantity: 8}})
	if err != nil || sheet(again) != "1:10:8,2:4:4,3:0:2" {
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

// TestProposeRefusesAnUndrawnDrawerOrNoRate pins the proposal's own refusals that the assumed
// count leaves standing (rule 5 with S4 and S6): an uncounted drawer blocks the offer by name
// instead of creating a round the closure would refuse, and a branch without a configured rate
// opens its settlement but cannot propose it. The sheet is no longer one of them, because the
// opener seeds it: the pending refusal is pinned on its own true footing below.
func TestProposeRefusesAnUndrawnDrawerOrNoRate(t *testing.T) {
	e := fixture(t)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	// The drawer must be counted: a proposal states the cash it counted and the fund, and a
	// draft that states the fund alone blocks it with no round written.
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

// TestProposeRefusesAPendingLineOfASheetWrittenBeforeTheSeeding pins the pending refusal for what
// it now is (S1, S3): the opener seeds every line with the expected quantity, so no writer of this
// version can leave a line pending and the guards survive as the safety net of a document written
// before that seeding. The line is made pending by the same direct statement the raced proposal
// uses, because that is the only way left to reach the state.
func TestProposeRefusesAPendingLineOfASheetWrittenBeforeTheSeeding(t *testing.T) {
	e := fixture(t)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	// The drawer is stated, so the sheet is the only fact that can refuse the offer.
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("100.00", "0.00", "20.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if _, err := e.pool.Exec(e.ctx, `UPDATE closing_count_lines SET counted_quantity=NULL
 WHERE closing_id=$1 AND variant_id=2`, opened.ID); err != nil {
		t.Fatalf("the seeded line could not be made pending again: %v", err)
	}
	_, err = e.store.Propose(e.ctx, warehouse(), opened.ID)
	var pending *closings.CountPending
	if !errors.As(err, &pending) || pending.VariantID != 2 {
		t.Fatalf("a pending variant must be named: %v", err)
	}
	refused(t, err, closings.ErrClosureRefused)
	if rounds := e.scalar(t, "SELECT count(*) FROM closing_proposals"); rounds != 0 {
		t.Fatalf("a refused proposal must write nothing: %d rounds", rounds)
	}
	if state := e.text(t, "SELECT status FROM branch_closings WHERE id=$1", opened.ID); state != "open" {
		t.Fatalf("a refused proposal must leave the settlement where it was: %q", state)
	}
	// Counting the one line lifts the guard and the very same settlement is offered.
	if _, err := e.store.Count(e.ctx, warehouse(), opened.ID,
		[]closings.Counted{{VariantID: 2, Quantity: 4}}); err != nil {
		t.Fatalf("the pending line could not be counted: %v", err)
	}
	proposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil || proposed.Status != closings.StatusProposed || len(proposed.Rounds) != 1 {
		t.Fatalf("the settlement must be proposable once the line is counted: %+v %v", proposed, err)
	}
}

// TestProposeNeedsNoCountEdit pins the new default at the store level (S1, S3): a settlement is
// opened, its drawer is drafted and it is proposed with no Count call at all, and the offer carries
// the quantity the opener seeded for every line. Proposing therefore never asks the warehouse to
// rewrite the sheet with what the system already had, and the document the branch decides states
// no missing quantity.
func TestProposeNeedsNoCountEdit(t *testing.T) {
	e := fixture(t)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("100.00", "0.00", "20.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	proposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("a settlement whose drawer is stated must be proposable without a count edit: %v", err)
	}
	round := proposed.LatestRound()
	if proposed.Status != closings.StatusProposed || round == nil || len(proposed.Rounds) != 1 {
		t.Fatalf("the proposal must leave the settlement proposed with its round: %+v", proposed)
	}
	want := map[int64]int64{1: 10, 2: 4}
	if len(round.Payload.CountLines) != len(want) {
		t.Fatalf("the offer must state every seeded line: %+v", round.Payload.CountLines)
	}
	for _, line := range round.Payload.CountLines {
		if line.ExpectedQuantity != want[line.VariantID] || line.CountedQuantity != line.ExpectedQuantity {
			t.Fatalf("variant %d: the offer must carry the seeded quantity, got %+v", line.VariantID, line)
		}
	}
	for _, line := range proposed.CountLines {
		if line.CountedQuantity == nil || *line.CountedQuantity != want[line.VariantID] {
			t.Fatalf("variant %d: no live sheet states a missing quantity, got %+v", line.VariantID, line)
		}
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
	// The till spends nothing it does not hold, so the branch funds it before it pays anything out: the
	// aporte is a movement of the first period like the expense it makes reachable (S1, S3).
	e.contribute(t, 2, "30.00", "Fondo de la caja de la semana")
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
	// The reason is S8's identity and not a changed number: expected = 30.00 put into the till +
	// 0.00 collected - 30.00 already spent, and the difference is the counted drawer against it.
	if settled.ExpectedCash != "0.00" || settled.CashDifference == nil ||
		string(*settled.CashDifference) != "0.00" {
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

// assertPeriodMoney pins the money of the period of livePeriod as a settlement publishes it:
// 200.00 sold in all, of which 100.00 was collected in cash and the rest by card, transfer and QR
// (50.00, 20.00 and 30.00), one expense of 12.50 and the 12.50% the fixture configures, which is
// 25.00 of commission. The drawer identity follows from those facts alone: 500.00 inherited plus
// 100.00 collected minus 12.50 spent is 587.50 of expected cash, and no electronic method enters
// it (S2, S8, S13).
func assertPeriodMoney(t *testing.T, closing closings.Closing, state string) {
	t.Helper()
	if closing.SalesTotal != "200.00" || closing.CashSales != "100.00" ||
		closing.CashExpenses != "12.50" || closing.CardTotal != "50.00" ||
		closing.TransferTotal != "20.00" || closing.QRTotal != "30.00" ||
		closing.CommissionAmount != "25.00" {
		t.Fatalf("a %s settlement must publish the money of its period: %+v", state, closing)
	}
	if closing.ExpectedCash != "587.50" {
		t.Fatalf("a %s settlement must expect 500.00 + 100.00 - 12.50, got %q", state,
			closing.ExpectedCash)
	}
}

// TestOpenSettlementPublishesThePeriodOfItsWindow pins S1 and the first half of S3 on the read:
// while the warehouse has not proposed, the six period columns of the row are drafts the database
// never wrote, so the read publishes them derived from the same window the proposal will use
// instead of repeating their zeros -- the drawer expectation of a period the branch did sell can
// no longer read zero.
func TestOpenSettlementPublishesThePeriodOfItsWindow(t *testing.T) {
	e := fixture(t)
	opened := e.livePeriod(t)

	// The columns of the row are still the zeros the insert left: nothing was frozen by opening.
	if stored := e.text(t, `SELECT sales_total::text||'/'||cash_sales::text||'/'||cash_expenses::text
  ||'/'||card_total::text||'/'||transfer_total::text||'/'||qr_total::text||'/'||commission_amount::text
 FROM branch_closings WHERE id=$1`, opened.ID); stored != "0.00/0.00/0.00/0.00/0.00/0.00/0.00" {
		t.Fatalf("an open row holds no frozen offer: %q", stored)
	}

	live, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be read: %v", err)
	}
	if live.Status != closings.StatusOpen || live.CommissionRatePercent != nil {
		t.Fatalf("nothing is frozen before the proposal: %+v", live)
	}
	assertPeriodMoney(t, live, "open")
	// The drawer is the number the admin counted against the derived expectation, and the
	// commission is reported beside it, never subtracted (S9).
	if live.CashDifference == nil || string(*live.CashDifference) != "22.50" ||
		live.TakenCash == nil || string(*live.TakenCash) != "500.00" {
		t.Fatalf("the derived drawer must follow the derived period: %+v", live)
	}
	// The branch reads the same document before the proposal: one row, one period (S3).
	branch, err := e.store.Read(e.ctx, identity(2), opened.ID)
	if err != nil || branch.ExpectedCash != live.ExpectedCash ||
		branch.SalesTotal != live.SalesTotal || branch.CashSales != live.CashSales ||
		branch.CashExpenses != live.CashExpenses || branch.CommissionAmount != live.CommissionAmount {
		t.Fatalf("both surfaces must read the period of the same ledgers: %+v %v", branch, err)
	}
}

// TestProposalFreezesThePeriodTheDraftPublished pins the second half of S3 -- the discrepancy the
// operator reported -- and S4: the numbers the warehouse reads while the settlement is open are
// exactly the ones the proposal freezes, so the two surfaces agree before and after proposing; and
// a closed settlement keeps publishing the frozen columns even after the configured rate changes,
// because what the branch signed is history.
func TestProposalFreezesThePeriodTheDraftPublished(t *testing.T) {
	e := fixture(t)
	opened := e.livePeriod(t)
	drafted, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the open settlement could not be read: %v", err)
	}
	assertPeriodMoney(t, drafted, "open")

	proposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	if proposed.Status != closings.StatusProposed || proposed.CommissionRatePercent == nil ||
		*proposed.CommissionRatePercent != "12.50" {
		t.Fatalf("the proposal must freeze the configured rate: %+v", proposed)
	}
	// The frozen row states the very numbers the draft derived, and so does the offer the branch
	// is asked to accept.
	assertPeriodMoney(t, proposed, "proposed")
	offer := proposed.LatestRound().Payload
	if offer.SalesTotal != drafted.SalesTotal || offer.CashSales != drafted.CashSales ||
		offer.CashExpenses != drafted.CashExpenses || offer.CardTotal != drafted.CardTotal ||
		offer.TransferTotal != drafted.TransferTotal || offer.QRTotal != drafted.QRTotal ||
		offer.CommissionAmount != drafted.CommissionAmount {
		t.Fatalf("the offer must state the period the draft published: %+v %+v", offer, drafted)
	}

	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil || closed.Status != closings.StatusClosed {
		t.Fatalf("the branch must accept the offer: %+v %v", closed, err)
	}
	assertPeriodMoney(t, closed, "closed")

	// S4: the settled period is the history its branch signed. A later rate would pay 198.00 on the
	// same 200.00, and the closed settlement keeps the 25.00 it froze, with the rate it froze.
	if _, err := e.store.ConfigureCommission(e.ctx, warehouse(), 2, "99.00"); err != nil {
		t.Fatalf("the configured rate could not be changed: %v", err)
	}
	if settings, err := e.store.ReadSettings(e.ctx, warehouse(), 2); err != nil ||
		settings.CommissionRatePercent != "99.00" {
		t.Fatalf("the branch must be configured with the new rate: %+v %v", settings, err)
	}
	if naive, err := closings.Commission("200.00", "99.00"); err != nil || naive != "198.00" {
		t.Fatalf("the changed rate must be a different commission, not the same one: %q %v", naive, err)
	}
	after, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the closed settlement could not be read again: %v", err)
	}
	assertPeriodMoney(t, after, "closed")
	if after.CommissionRatePercent == nil || *after.CommissionRatePercent != "12.50" {
		t.Fatalf("a closed settlement keeps the rate it signed: %+v", after)
	}
	if frozen := e.text(t, `SELECT commission_amount::text||'/'||commission_rate_percent::text
 FROM branch_closings WHERE id=$1`, opened.ID); frozen != "25.00/12.50" {
		t.Fatalf("a closed row must keep the offer it frozen: %q", frozen)
	}
}

// TestListPublishesTheOpenPeriodOfTheDocument pins that the history of a branch publishes, row by
// row, the same derived period as the document it summarises: a list row that disagreed with its
// own settlement would be a defect of the surface and not a cheaper read (S1, S3).
func TestListPublishesTheOpenPeriodOfTheDocument(t *testing.T) {
	e := fixture(t)
	opened := e.livePeriod(t)

	page, err := e.store.List(e.ctx, warehouse(), 2, 1, 25)
	if err != nil {
		t.Fatalf("the history of the branch could not be read: %v", err)
	}
	if len(page.Closings) != 2 || page.Closings[0].ID != opened.ID ||
		page.Closings[0].Status != closings.StatusOpen {
		t.Fatalf("the live settlement must be the newest row of the history: %+v", page.Closings)
	}
	row := page.Closings[0]
	assertPeriodMoney(t, row, "listed open")
	document, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be read: %v", err)
	}
	if row.SalesTotal != document.SalesTotal || row.CashSales != document.CashSales ||
		row.CashExpenses != document.CashExpenses || row.CardTotal != document.CardTotal ||
		row.TransferTotal != document.TransferTotal || row.QRTotal != document.QRTotal ||
		row.CommissionAmount != document.CommissionAmount || row.ExpectedCash != document.ExpectedCash {
		t.Fatalf("a list row must publish the period of its document: %+v %+v", row, document)
	}
}

// TestListDerivesTheOpenPeriodAfterItsCursorIsClosed pins the deadlock a page of one connection
// exposes: a derivation issued inside the loop that still holds the cursor of the same pool waits
// for a connection the cursor itself holds, so the list endpoint never answers. The store reads
// every row of the page first and derives afterwards, so one connection is enough, and the open
// row still publishes the money of its period (S1, S3).
func TestListDerivesTheOpenPeriodAfterItsCursorIsClosed(t *testing.T) {
	e := fixture(t)
	opened := e.livePeriod(t)
	// A pool of a single connection: the page holds a row cursor on it, so a derivation that ran
	// while that cursor was open would have nothing left to run on.
	config := e.pool.Config().Copy()
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(e.ctx, config)
	if err != nil {
		t.Fatalf("the single-connection pool could not be built: %v", err)
	}
	t.Cleanup(pool.Close)
	// A short deadline, so the regression fails the test instead of hanging the suite.
	ctx, cancel := context.WithTimeout(e.ctx, 5*time.Second)
	defer cancel()
	page, err := closings.New(pool).List(ctx, warehouse(), 2, 1, 25)
	if err != nil {
		t.Fatalf("a page must be read on one connection: %v", err)
	}
	if len(page.Closings) != 2 || page.Closings[0].ID != opened.ID ||
		page.Closings[0].Status != closings.StatusOpen {
		t.Fatalf("the live settlement must be the newest row of the history: %+v", page.Closings)
	}
	// The derivation still runs after the cursor is closed: dropping it would make the deadlock
	// disappear by publishing the zeros nobody wrote.
	if row := page.Closings[0]; row.CashSales != "100.00" || row.ExpectedCash != "587.50" {
		t.Fatalf("an open row must publish the money of its period: %+v", row)
	}
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

	// Each till is funded before it pays anything out, because the drawer spends only what it holds (S1).
	e.contribute(t, 2, "45.50", "Fondo de la caja")
	e.contribute(t, 3, "5.00", "Fondo de la otra sucursal")
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
		"2:aporte:45.50:2,3:aporte:5.00:3,2:gasto:45.50:2,3:gasto:5.00:3" {
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
	// The four rows of the fixture are the two contributions that fund the tills and the two expenses.
	if ledger := e.scalar(t, "SELECT count(*) FROM branch_cash_movements"); ledger != 4 {
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
	// The other branch funds its own till first, so its expense lands in its own book and never here (S1).
	e.contribute(t, 3, "99.00", "Fondo de la otra sucursal")
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

	// The list is the ledger, and the total of a settlement the warehouse still holds is derived
	// from it (S1), so the admin reads the exact amount the proposal is about to freeze instead of a
	// zero that would understate the drawer; the proposal then freezes that same 55.50.
	if opened.CashExpenses != "55.50" || opened.ExpectedCash != "44.50" {
		t.Fatalf("a held settlement publishes the total of its own ledger: %+v", opened)
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

// purchase registers one real purchase of branch 2 through the purchase store, paid in cash from
// the purchase fund, so the settlement reads the documents exactly as the branch wrote them. One
// used battery at the price the test states makes the total and the cash of the document the same
// number, which is what the envelope of the settlement has to sum.
func (e *env) purchase(t *testing.T, key, cash string) purchases.Document {
	t.Helper()
	document, err := e.purchases.Create(e.ctx, identity(2), purchases.CreateInput{
		OperationKey: key,
		UsedLines:    []purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 1, UnitPrice: purchases.Money(cash)}},
		PaidCash:     purchases.Money(cash),
		PaidTransfer: "0.00",
	})
	if err != nil {
		t.Fatalf("the purchase %q could not be registered: %v", key, err)
	}
	return document
}

// fundLoad writes one `aporte` of the branch's purchase fund: the money the warehouse loads into it
// so the branch can buy. The fund of a branch is its book and nothing else (S5, S7), so a test whose
// period spends from the fund states the load it spends instead of relying on a fund that is not
// there. It is the ledger's own admission path -- an account of the branch, a positive amount and a
// branch that is not frozen -- so the row is one the product could have written.
func (e *env) fundLoad(t *testing.T, branch int, amount, description string) {
	t.Helper()
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,
 amount,description,created_by_account_id) VALUES($1,'aporte',$2::numeric,$3,$4)`,
		int16(branch), amount, description, identity(branch).AccountID); err != nil {
		t.Fatalf("the load of %s into the fund of branch %d must be admitted: %v", amount, branch, err)
	}
}

// TestPurchaseFundDerivesOpeningPurchasesAndDifference pins S1, S3, S5 and S11 at the store: the
// envelope of one settlement opens with the amount the previous closure left in it, its purchases
// are the documents of its own window net of their counter-documents, its expectation follows from
// those two numbers, and its difference is published only once the envelope was counted. The
// envelope is drafted through the drawer draft, becomes the offer when the settlement is proposed
// and is refused afterwards, and the amount left behind is what opens the next period.
func TestPurchaseFundDerivesOpeningPurchasesAndDifference(t *testing.T) {
	e := fixture(t)
	// The first settlement of the branch closes with an envelope of its own: the drawer is settled
	// as every other test settles it, and the purchase fund is counted and left at 300.00.
	first, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the first settlement could not be opened: %v", err)
	}
	e.countAll(t, first.ID)
	zero, contribution, envelope := closings.Money("0.00"), closings.Money("500.00"), closings.Money("300.00")
	drafted, err := e.store.SaveCash(e.ctx, warehouse(), first.ID, closings.CashDraft{
		CountedCash: &zero, ContributedCash: contribution, ClosingCash: &contribution,
		Observation: "arranque de la sucursal", PurchaseFundCounted: &envelope,
		PurchaseFundCash: &envelope,
	})
	if err != nil {
		t.Fatalf("the draft must state the purchase fund: %v", err)
	}
	// Before the proposal the envelope is a draft, and its difference is derived against the
	// expectation of its own window: no previous closure and no purchases, so 0.00 of expectation.
	if drafted.PurchaseFundOpening != "0.00" || drafted.PurchasesTotal != "0.00" ||
		drafted.PurchasesCash != "0.00" || drafted.PurchaseFundExpected != "0.00" ||
		drafted.PurchaseFundCounted == nil || *drafted.PurchaseFundCounted != "300.00" ||
		drafted.PurchaseFundDifference == nil || *drafted.PurchaseFundDifference != "300.00" ||
		drafted.PurchaseFundCash == nil || *drafted.PurchaseFundCash != "300.00" {
		t.Fatalf("the envelope of a first settlement is not derived: %+v", drafted)
	}
	// The drawer is untouched by the second envelope: its three identities are still its own.
	if drafted.ExpectedCash != "0.00" || *drafted.CashDifference != "0.00" ||
		*drafted.TakenCash != "0.00" || drafted.ClosingCash == nil || *drafted.ClosingCash != "500.00" {
		t.Fatalf("the purchase fund must not move the drawer: %+v", drafted)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), first.ID); err != nil {
		t.Fatalf("the first settlement could not be proposed: %v", err)
	}
	closed, err := e.store.Decide(e.ctx, identity(2), first.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the first settlement: %v", err)
	}
	if closed.PurchaseFundCounted == nil || *closed.PurchaseFundCounted != "300.00" ||
		closed.PurchaseFundCash == nil || *closed.PurchaseFundCash != "300.00" {
		t.Fatalf("the closure must keep the envelope of the offer: %+v", closed)
	}

	// The branch buys inside the period: two documents and the counter-document of the first one,
	// which is stored with its negative amounts and therefore subtracts from both sums (S3, S11).
	charged := e.purchase(t, "closings-fund-period-01", "120.50")
	e.purchase(t, "closings-fund-period-02", "50.00")
	if _, err := e.purchases.Reverse(e.ctx, identity(2), charged.ID, "closings-fund-reverse-01",
		"la batería no servía"); err != nil {
		t.Fatalf("the counter-document could not be registered: %v", err)
	}

	// The next settlement opens with the amount the previous closure left and states the purchases
	// of its own window: 120.50 - 120.50 + 50.00 of cash, and 250.00 of expectation.
	second, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the second settlement could not be opened: %v", err)
	}
	e.countAll(t, second.ID)
	read, err := e.store.Read(e.ctx, warehouse(), second.ID)
	if err != nil {
		t.Fatalf("the second settlement could not be read: %v", err)
	}
	if read.PurchaseFundOpening != "300.00" || read.PurchasesTotal != "50.00" ||
		read.PurchasesCash != "50.00" || read.PurchaseFundExpected != "250.00" {
		t.Fatalf("the envelope of the period is not the one its own documents state: %+v", read)
	}
	if read.PurchaseFundCounted != nil || read.PurchaseFundDifference != nil ||
		read.PurchaseFundCash != nil {
		t.Fatalf("an envelope nobody counted states no count, no difference and no new amount: %+v", read)
	}
	if read.OpeningCash != "500.00" {
		t.Fatalf("the drawer must still inherit its own fund: %q", read.OpeningCash)
	}

	// The envelope is drafted through the drawer draft, and the new amount is not capped by what was
	// counted: the warehouse brings money from outside the branch (S5, S6).
	drafter, err := e.store.SaveCash(e.ctx, warehouse(), second.ID, closings.CashDraft{
		CountedCash: moneyPtr("500.00"), ContributedCash: "0.00", ClosingCash: moneyPtr("100.00"),
		Observation: "contado en persona", PurchaseFundCounted: moneyPtr("240.00"),
		PurchaseFundCash: moneyPtr("400.00"),
	})
	if err != nil {
		t.Fatalf("the drawer draft must state the envelope: %v", err)
	}
	if drafter.PurchaseFundCounted == nil || *drafter.PurchaseFundCounted != "240.00" ||
		drafter.PurchaseFundDifference == nil || *drafter.PurchaseFundDifference != "-10.00" ||
		drafter.PurchaseFundCash == nil || *drafter.PurchaseFundCash != "400.00" ||
		drafter.PurchaseFundExpected != "250.00" {
		t.Fatalf("the difference of the envelope is the count against its expectation: %+v", drafter)
	}

	// Proposing turns the draft into the offer, and the round states the envelope the branch decides.
	proposed, err := e.store.Propose(e.ctx, warehouse(), second.ID)
	if err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	round := proposed.LatestRound()
	if proposed.PurchaseFundCounted == nil || *proposed.PurchaseFundCounted != "240.00" ||
		proposed.PurchaseFundCash == nil || *proposed.PurchaseFundCash != "400.00" || round == nil ||
		round.Payload.PurchaseFundCounted == nil || *round.Payload.PurchaseFundCounted != "240.00" ||
		round.Payload.PurchaseFundCash == nil || *round.Payload.PurchaseFundCash != "400.00" {
		t.Fatalf("the proposal must offer the envelope it froze: %+v", proposed)
	}
	// Nothing changes the envelope after the offer: the draft is closed and the database refuses a
	// write that would move it with the state machine.
	_, err = e.store.SaveCash(e.ctx, warehouse(), second.ID, closings.CashDraft{
		CountedCash: moneyPtr("500.00"), ContributedCash: "0.00", ClosingCash: moneyPtr("100.00"),
		PurchaseFundCounted: moneyPtr("1.00"), PurchaseFundCash: moneyPtr("1.00"),
	})
	refused(t, err, closings.ErrStateConflict)
	var database *pgconn.PgError
	_, err = e.pool.Exec(e.ctx, `UPDATE branch_closings
 SET status='closed',purchase_fund_cash=999.00 WHERE id=$1`, second.ID)
	if !errors.As(err, &database) || database.Code != "LC005" {
		t.Fatalf("the database must refuse an envelope that moves with the closure: %v", err)
	}
	if stored := e.text(t, `SELECT coalesce(purchase_fund_cash::text,'')||'/'||coalesce(purchase_fund_counted::text,'')
 FROM branch_closings WHERE id=$1`, second.ID); stored != "400.00/240.00" {
		t.Fatalf("a refused write must leave the envelope as it was: %q", stored)
	}
	accepted, err := e.store.Decide(e.ctx, identity(2), second.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the offer: %v", err)
	}
	if accepted.Status != closings.StatusClosed || accepted.PurchaseFundCounted == nil ||
		*accepted.PurchaseFundCounted != "240.00" || accepted.PurchaseFundCash == nil ||
		*accepted.PurchaseFundCash != "400.00" {
		t.Fatalf("the closed settlement must keep the envelope it offered: %+v", accepted)
	}

	// What the warehouse left opens the next period, and a period with no purchases of its own
	// reports zero and no difference at all.
	third, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the third settlement could not be opened: %v", err)
	}
	empty, err := e.store.Read(e.ctx, warehouse(), third.ID)
	if err != nil {
		t.Fatalf("the third settlement could not be read: %v", err)
	}
	if empty.PurchaseFundOpening != "400.00" || empty.PurchasesTotal != "0.00" ||
		empty.PurchasesCash != "0.00" || empty.PurchaseFundExpected != "400.00" {
		t.Fatalf("the amount left behind opens the next period: %+v", empty)
	}
	if empty.PurchaseFundCounted != nil || empty.PurchaseFundDifference != nil {
		t.Fatalf("a period with no purchases and no count states no difference: %+v", empty)
	}
	// A history row reads its own predecessor and never the envelope of a later closure: the first
	// settlement of the branch has none and the second one inherited 300.00, whatever closed after
	// them.
	firstAgain, err := e.store.Read(e.ctx, warehouse(), first.ID)
	if err != nil {
		t.Fatalf("the first settlement could not be read again: %v", err)
	}
	if firstAgain.PurchaseFundOpening != "0.00" || firstAgain.PurchasesTotal != "0.00" ||
		firstAgain.PurchaseFundExpected != "0.00" {
		t.Fatalf("a history row must read its own predecessor: %+v", firstAgain)
	}
	secondAgain, err := e.store.Read(e.ctx, warehouse(), second.ID)
	if err != nil {
		t.Fatalf("the second settlement could not be read again: %v", err)
	}
	if secondAgain.PurchaseFundOpening != "300.00" || secondAgain.PurchasesCash != "50.00" ||
		secondAgain.PurchaseFundExpected != "250.00" {
		t.Fatalf("the second settlement must keep the envelope of its own period: %+v", secondAgain)
	}
}

// TestPurchaseFundKeepsTheSignOfANegativeNet pins S3 and S11 where the sign is the answer: a window
// that spent more than it inherited reports a negative expectation, and a window whose counter-document
// is larger than its purchases gives money back, so both sums are negative and the expectation that
// follows is larger than the inheritance. Both are read, never refused as an outage.
func TestPurchaseFundKeepsTheSignOfANegativeNet(t *testing.T) {
	e := fixture(t)
	// The first settlement declares no envelope, so the branch loads the fund it buys with: the book of
	// the fund is the only money a purchase can spend (S5, S7), and a branch that loads nothing buys
	// nothing.
	e.closeFirstSettlement(t, "500.00")
	e.fundLoad(t, 2, "120.50", "Carga de fondo para la compra del período")
	bought := e.purchase(t, "closings-fund-negative-01", "120.50")
	second, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the second settlement could not be opened: %v", err)
	}
	short, err := e.store.Read(e.ctx, warehouse(), second.ID)
	if err != nil {
		t.Fatalf("a window that spent more than it inherited must be readable: %v", err)
	}
	// 0.00 inherited minus 120.50 of purchases: a shortage states its negative expectation.
	if short.PurchaseFundOpening != "0.00" || short.PurchasesCash != "120.50" ||
		short.PurchaseFundExpected != "-120.50" {
		t.Fatalf("an envelope that spent more than it inherited is short: %+v", short)
	}
	// The closure leaves 300.00 in the envelope, which is what the next period inherits.
	e.countAll(t, second.ID)
	zero, contribution, left := closings.Money("0.00"), closings.Money("500.00"), closings.Money("300.00")
	if _, err := e.store.SaveCash(e.ctx, warehouse(), second.ID, closings.CashDraft{
		CountedCash: &zero, ContributedCash: contribution, ClosingCash: &contribution,
		PurchaseFundCash: &left,
	}); err != nil {
		t.Fatalf("the second cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), second.ID); err != nil {
		t.Fatalf("the second settlement could not be proposed: %v", err)
	}
	if _, err := e.store.Decide(e.ctx, identity(2), second.ID, closings.DecisionAccepted, ""); err != nil {
		t.Fatalf("the branch must accept the second settlement: %v", err)
	}
	// The branch returns that battery once its period is closed, so the counter-document is the only
	// document of the new window and both sums are negative by construction (S3, S11).
	if _, err := e.purchases.Reverse(e.ctx, identity(2), bought.ID,
		"closings-fund-negative-reverse", "la batería no servía"); err != nil {
		t.Fatalf("the counter-document could not be registered: %v", err)
	}
	third, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the third settlement could not be opened: %v", err)
	}
	read, err := e.store.Read(e.ctx, warehouse(), third.ID)
	if err != nil {
		t.Fatalf("a window net of counter-documents must stay readable: %v", err)
	}
	// 300.00 inherited plus the 120.50 the period gave back: the expectation follows the signed net.
	if read.PurchasesTotal != "-120.50" || read.PurchasesCash != "-120.50" ||
		read.PurchaseFundOpening != "300.00" || read.PurchaseFundExpected != "420.50" {
		t.Fatalf("the expectation must follow the signed purchases: %+v", read)
	}
}

// fundBook is the one arithmetic of the purchase fund: the signed sum of `purchase_fund_ledger`, read
// where it lives, so a test never computes the fund a second way.
func (e *env) fundBook(t *testing.T, branch int) string {
	t.Helper()
	return e.text(t, `SELECT coalesce(sum(effective),0)::numeric(12,2)::text
 FROM purchase_fund_ledger WHERE branch_location_id=$1`, branch)
}

// closeFundWindow opens, counts, proposes and closes one settlement of branch 2 with the stated
// drawer and purchase fund, so a test of the fund states only the two amounts it is about.
func (e *env) closeFundWindow(t *testing.T, counted, envelope string) closings.Closing {
	t.Helper()
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	zero, contribution, held := closings.Money("0.00"), closings.Money(counted),
		closings.Money(envelope)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, closings.CashDraft{
		CountedCash: &zero, ContributedCash: contribution, ClosingCash: &contribution,
		PurchaseFundCounted: &held, PurchaseFundCash: &held, Observation: "fondo del período",
	}); err != nil {
		t.Fatalf("the fund of the period could not be drafted: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the period could not be proposed: %v", err)
	}
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the period: %v", err)
	}
	return closed
}

// pastFundSettlement writes a settlement and the fund's book around it the way a database that closed
// it before a closure settled the fund through its book carries them: a load dated before the
// closure, the settlement with the envelope it published, and -- when the closure of that database
// wrote the movement reconciling the book -- the row that names it. The past is written with the
// guards off on purpose: a closure of this version always writes its movement, so the only way to
// state a settlement that closed without one is to write the rows it left.
//
// The numbers are chosen so the two sources disagree -- the book at the settlement's instant holds
// 500.00, or 250.00 loaded and 50.00 returned, while the acta states 300.00 -- because that is what
// tells a reader which of the two a closed acta is published from.
func (e *env) pastFundSettlement(t *testing.T, branch int, stated string, named bool) int64 {
	t.Helper()
	tx, err := e.pool.Begin(e.ctx)
	if err != nil {
		t.Fatalf("the settlement of the past could not be written: %v", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(e.ctx)) }()
	if _, err := tx.Exec(e.ctx, `SET LOCAL session_replication_role = replica`); err != nil {
		t.Fatalf("the guards could not be stepped around for a settlement of the past: %v", err)
	}
	// The book of the branch before the closure: money that settlement did not settle, which is what a
	// read of the book would publish instead of the number the acta signed.
	load := "500.00"
	if named {
		load = "250.00"
	}
	if _, err := tx.Exec(e.ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,
 description,occurred_at,created_by_account_id)
 VALUES($1::smallint,'aporte',$2::numeric,'Carga de fondo anterior a la rendición',
 now()-interval '3 hours',$3::integer)`, int16(branch), load, branch); err != nil {
		t.Fatalf("the load of the past could not be written: %v", err)
	}
	var id int64
	var closedAt time.Time
	if err := tx.QueryRow(e.ctx, `INSERT INTO branch_closings(branch_location_id,status,
 period_start,cut_at,closed_at,commission_rate_percent,counted_cash,contributed_cash,closing_cash,
 purchase_fund_counted,purchase_fund_cash,opened_by_account_id)
 VALUES($1::smallint,'closed',now()-interval '4 hours',now()-interval '2 hours',
 now()-interval '2 hours',12.50,500.00,0.00,500.00,$2::numeric,$2::numeric,1)
 RETURNING id,closed_at`, int16(branch), stated).Scan(&id, &closedAt); err != nil {
		t.Fatalf("the settlement of the past could not be written: %v", err)
	}
	if named {
		// The movement its closure wrote, naming the settlement: the surplus it took back, with the
		// instant of the closure it shares and the kind that states the direction.
		description := fmt.Sprintf("Devolución del fondo de la rendición %d", id)
		if _, err := tx.Exec(e.ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,
 description,occurred_at,created_by_account_id,closing_id)
 VALUES($1::smallint,'devolucion',50.00,$2,$3,$4::integer,$5::bigint)`,
			int16(branch), description, closedAt, branch, id); err != nil {
			t.Fatalf("the movement of the closure of the past could not be written: %v", err)
		}
	}
	if err := tx.Commit(e.ctx); err != nil {
		t.Fatalf("the settlement of the past could not be committed: %v", err)
	}
	return id
}

// TestClosingSettlesTheFundThroughItsLedger proves S9 on a live database: the amount a settlement
// takes back is a movement of the fund's book -- a `devolucion` of the difference against what the
// book held, signed by the settlement's own opener -- and the balance after the closure is exactly
// that amount. The acta publishes the book's sum, so the two numbers of the fund cannot differ.
func TestClosingSettlesTheFundThroughItsLedger(t *testing.T) {
	e := fixture(t)
	// The warehouse loads the fund the branch operates with: a book is the only money a branch holds
	// for purchases (S5, S7).
	e.fundLoad(t, 2, "500.00", "Carga de fondo del período")
	if before := e.fundBook(t, 2); before != "500.00" {
		t.Fatalf("the load must be the fund's whole book, got %s", before)
	}
	// The settlement leaves 300.00 of the 500.00 the book holds.
	closed := e.closeFundWindow(t, "500.00", "300.00")
	var kind, amount, description string
	var actor int
	if err := e.pool.QueryRow(e.ctx, `SELECT kind,amount::text,description,created_by_account_id
 FROM branch_fund_movements WHERE branch_location_id=2 AND closing_id IS NOT NULL`).
		Scan(&kind, &amount, &description, &actor); err != nil {
		t.Fatalf("the closure must write the fund it leaves: %v", err)
	}
	// The movement is the difference, not the stated amount -- writing 300.00 would count the fund
	// twice -- and its direction is a kind, so the amount stays positive (S6, migration 052).
	if kind != "devolucion" || amount != "200.00" || actor != 1 {
		t.Fatalf("the closure writes the difference as the kind of its direction, got %s %s %d",
			kind, amount, actor)
	}
	if !strings.Contains(description, "rendición") {
		t.Fatalf("the movement must name the settlement it comes from, got %q", description)
	}
	// The balance after the closure is the amount the acta states, and both are the book's sum.
	book := e.fundBook(t, 2)
	if book != "300.00" {
		t.Fatalf("the fund after the closure must be the amount it leaves, got %s", book)
	}
	if closed.PurchaseFundCash == nil || string(*closed.PurchaseFundCash) != book ||
		closed.PurchaseFundCounted == nil || string(*closed.PurchaseFundCounted) != "300.00" {
		t.Fatalf("the acta must publish the book it settled: %+v with the book at %s",
			closed.PurchaseFundCash, book)
	}
	// The document of a later read states the same number: the closure is history and the book is one
	// arithmetic, so nothing recomputes it.
	again := mustRead(t, e, closed.ID)
	if again.PurchaseFundCash == nil || string(*again.PurchaseFundCash) != book {
		t.Fatalf("the acta must keep publishing the book it settled, got %+v", again.PurchaseFundCash)
	}
	// And the amount it leaves opens the next period, exactly as the drawer's fund does.
	next, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the next period could not be opened: %v", err)
	}
	if opening := mustRead(t, e, next.ID).PurchaseFundOpening; string(opening) != book {
		t.Fatalf("the fund left behind must open the next period, got %s want %s", opening, book)
	}
	t.Logf("051: the closure writes the fund it leaves and the book is the number")
}

// TestUnstatedFundPublishesTheBook proves S7 and the one arithmetic of S9 where the two can be told
// apart: a settlement whose warehouse stated no amount leaves the column of 044 empty, and the acta
// still publishes what the fund holds, because an unstated fund is zero -- the book's own sum -- and
// not unknown. No movement is written to say it: the book already says it.
func TestUnstatedFundPublishesTheBook(t *testing.T) {
	e := fixture(t)
	e.fundLoad(t, 2, "500.00", "Carga de fondo del período")
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	zero, contribution := closings.Money("0.00"), closings.Money("500.00")
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, closings.CashDraft{
		CountedCash: &zero, ContributedCash: contribution, ClosingCash: &contribution,
		Observation: "el fondo no se declaró",
	}); err != nil {
		t.Fatalf("the drawer of the period could not be drafted: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the period could not be proposed: %v", err)
	}
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the period: %v", err)
	}
	// The column is empty, as the warehouse left it, and the acta publishes the book: 500.00.
	if stated := e.text(t, `SELECT coalesce(purchase_fund_cash::text,'-')
 FROM branch_closings WHERE id=$1`, closed.ID); stated != "-" {
		t.Fatalf("an unstated fund must stay unstated in the column, got %q", stated)
	}
	if closed.PurchaseFundCash == nil || string(*closed.PurchaseFundCash) != "500.00" {
		t.Fatalf("the acta of an unstated fund must publish the book, got %+v", closed.PurchaseFundCash)
	}
	if written := e.scalar(t, `SELECT count(*) FROM branch_fund_movements
 WHERE branch_location_id=2 AND closing_id IS NOT NULL`); written != 0 {
		t.Fatalf("an unstated fund writes no movement, got %d", written)
	}
	// The history row of the same settlement states the same number, from the same place.
	if again := mustRead(t, e, closed.ID); again.PurchaseFundCash == nil ||
		string(*again.PurchaseFundCash) != "500.00" {
		t.Fatalf("a history row must publish the same book, got %+v", again.PurchaseFundCash)
	}
	t.Logf("051: an unstated fund is the book's sum and not an unknown")
}

// TestClosingStatesTheFundDownToZeroAndNeverBelow proves S6 at the closure: a settlement may leave
// less than the book holds -- the warehouse takes the surplus back, which is a `devolucion` of the
// difference -- and the fund follows to the stated amount, down to zero. A statement below zero is
// refused by the column of the settlement itself, so no closure can drive the fund negative.
func TestClosingStatesTheFundDownToZeroAndNeverBelow(t *testing.T) {
	e := fixture(t)
	e.fundLoad(t, 2, "500.00", "Carga de fondo del período")
	// The first settlement leaves 120.00: 380.00 go back with the warehouse.
	first := e.closeFundWindow(t, "500.00", "120.00")
	if book := e.fundBook(t, 2); book != "120.00" {
		t.Fatalf("a statement below the book must be written, got %s", book)
	}
	if first.PurchaseFundCash == nil || string(*first.PurchaseFundCash) != "120.00" {
		t.Fatalf("the acta must publish the amount the settlement leaves: %+v", first.PurchaseFundCash)
	}
	// The second settlement leaves nothing at all: the fund closes to zero and never below it.
	second := e.closeFundWindow(t, "120.00", "0.00")
	if book := e.fundBook(t, 2); book != "0.00" {
		t.Fatalf("a settlement that leaves nothing closes the fund to zero, got %s", book)
	}
	if second.PurchaseFundCash == nil || string(*second.PurchaseFundCash) != "0.00" {
		t.Fatalf("the acta of a closed fund states zero: %+v", second.PurchaseFundCash)
	}
	// The whole history of the book is read as a running balance: no instant of it is negative, which
	// is the rule S6 states and the admission of the ledger enforces.
	if negative := e.scalar(t, `SELECT count(*) FROM (SELECT sum(effective) OVER (ORDER BY id)
   AS running FROM purchase_fund_ledger WHERE branch_location_id=2) history WHERE running < 0`); negative != 0 {
		t.Fatalf("the fund of the branch must never read negative, got %d instants", negative)
	}
	// A statement below zero cannot even be stored: the settlement's own column of 044 refuses it, so
	// the domain has no way to declare a fund that would take the book under zero.
	live, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the live period could not be opened: %v", err)
	}
	_, err = e.pool.Exec(e.ctx, `UPDATE branch_closings SET purchase_fund_cash=-1.00 WHERE id=$1`, live.ID)
	var database *pgconn.PgError
	if !errors.As(err, &database) || database.Code != "23514" {
		t.Fatalf("a negative fund statement must be refused by the column, got %v", err)
	}
	if book := e.fundBook(t, 2); book != "0.00" {
		t.Fatalf("a refused statement must leave the book as it was, got %s", book)
	}
	t.Logf("051: the fund follows the statement down to zero and no statement can pass it")
}

// TestFundCorrectionAfterTheClosureAppendsItsMovement proves the append-only half of S9 and S5: the
// fund a settlement settled is never rewritten. A correction states the load differently by
// appending its own `correccion`, the balance follows the sum, the closed acta keeps the number it
// settled and the next period inherits the corrected book.
func TestFundCorrectionAfterTheClosureAppendsItsMovement(t *testing.T) {
	e := fixture(t)
	e.fundLoad(t, 2, "500.00", "Carga de fondo del período")
	closed := e.closeFundWindow(t, "500.00", "300.00")
	var kind, amount string
	if err := e.pool.QueryRow(e.ctx, `SELECT kind,amount::text FROM branch_fund_movements
 WHERE branch_location_id=2 AND closing_id IS NOT NULL`).Scan(&kind, &amount); err != nil {
		t.Fatalf("the closure must write the fund it leaves: %v", err)
	}
	// The movement states the difference, not the amount the settlement leaves -- writing 300.00 would
	// count the fund twice -- and the direction is the kind's, so the amount is positive (052).
	if kind != "devolucion" || amount != "200.00" {
		t.Fatalf("the closure writes the difference as the kind of its direction, got %s %s",
			kind, amount)
	}
	var load int64
	if err := e.pool.QueryRow(e.ctx, `SELECT id FROM branch_fund_movements
 WHERE branch_location_id=2 AND kind='aporte'`).Scan(&load); err != nil {
		t.Fatalf("the load of the period must be a row of the book: %v", err)
	}
	before := e.text(t, `SELECT coalesce(string_agg(kind||':'||amount,',' ORDER BY id),'')
 FROM branch_fund_movements WHERE branch_location_id=2`)
	// The load of the period was 50.00 less than the book recorded, so the fund holds 50.00 more than
	// it should: the branch appends the correction that answers it, and the row it answers is left
	// exactly as it was written.
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,
 amount,description,created_by_account_id,corrects_id)
 VALUES(2,'correccion',50.00,'Corrección de la carga del período',2,$1)`, load); err != nil {
		t.Fatalf("the branch must be able to correct the fund it settled: %v", err)
	}
	if book := e.fundBook(t, 2); book != "250.00" {
		t.Fatalf("the balance must follow the correction, got %s", book)
	}
	// Append only: the closure's own movement is still there with the amount it stated.
	if after := e.text(t, `SELECT coalesce(string_agg(kind||':'||amount,',' ORDER BY id),'')
 FROM branch_fund_movements WHERE branch_location_id=2`); !strings.HasPrefix(after, before) ||
		after == before {
		t.Fatalf("a correction appends its movement and rewrites none: %q after %q", after, before)
	}
	// The closed acta is history: it keeps publishing the fund it settled, because that is the number
	// the branch signed and the book at its own instant cannot change.
	if acta := mustRead(t, e, closed.ID); acta.PurchaseFundCash == nil ||
		string(*acta.PurchaseFundCash) != "300.00" {
		t.Fatalf("the closed acta must keep the fund it settled, got %+v", acta.PurchaseFundCash)
	}
	// The correction is a fact of the period that follows and not a rewrite of the closed one: the new
	// period opens with the fund the settlement left -- history does not move -- and its own window
	// carries the corrected book.
	next, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the next period could not be opened: %v", err)
	}
	read := mustRead(t, e, next.ID)
	if read.PurchaseFundOpening != "300.00" || read.PurchasesCash != "0.00" ||
		read.PurchaseFundExpected != "300.00" {
		t.Fatalf("the new period must open with the fund the settlement left: %+v", read)
	}
	// The next closure states the fund the book holds, so its acta publishes the corrected number and
	// no movement is needed to say it: the sum already reaches it.
	e.countAll(t, next.ID)
	zero, contribution, held := closings.Money("0.00"), closings.Money("300.00"),
		closings.Money("250.00")
	if _, err := e.store.SaveCash(e.ctx, warehouse(), next.ID, closings.CashDraft{
		CountedCash: &zero, ContributedCash: contribution, ClosingCash: &contribution,
		PurchaseFundCounted: &held, PurchaseFundCash: &held, Observation: "fondo corregido",
	}); err != nil {
		t.Fatalf("the fund of the next period could not be drafted: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), next.ID); err != nil {
		t.Fatalf("the next period could not be proposed: %v", err)
	}
	thereafter, err := e.store.Decide(e.ctx, identity(2), next.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the next period: %v", err)
	}
	if thereafter.PurchaseFundCash == nil || string(*thereafter.PurchaseFundCash) != "250.00" {
		t.Fatalf("the next acta must publish the corrected book: %+v", thereafter.PurchaseFundCash)
	}
	if written := e.scalar(t, `SELECT count(*) FROM branch_fund_movements
 WHERE branch_location_id=2 AND closing_id IS NOT NULL`); written != 1 {
		t.Fatalf("a settlement that states the book writes no movement, got %d statements", written)
	}
	if book := e.fundBook(t, 2); book != "250.00" {
		t.Fatalf("the book must hold the corrected fund after the second closure, got %s", book)
	}
	t.Logf("052: a fund correction appends its movement and the balance follows")
}

// TestClosedActaIsNeverRecalculated proves finding 3 and S5 on a live database: a closed settlement
// publishes the fund it settled, and a book that holds other rows never rewrites it. A settlement is
// read from the book only when its own closure wrote the movement that reconciled the book to it --
// the row that names it -- so the acta of a settlement closed before that rule existed (051) keeps
// the number it published, and the opening of the next period is that same number and not the sum of
// rows the settlement never settled.
func TestClosedActaIsNeverRecalculated(t *testing.T) {
	e := fixture(t)
	// A settlement closed before a closure settled the fund through its book: its closure wrote no
	// movement of the fund, and the branch's book already held 500.00 at its instant. The acta
	// published 300.00, and that is the number it keeps.
	legacy := e.pastFundSettlement(t, 2, "300.00", false)
	if book := e.fundBook(t, 2); book != "500.00" {
		t.Fatalf("the book of the past must hold what it held, got %s", book)
	}
	acta := mustRead(t, e, legacy)
	if acta.PurchaseFundCash == nil || string(*acta.PurchaseFundCash) != "300.00" {
		t.Fatalf("a closed acta keeps the fund it published, got %+v", acta.PurchaseFundCash)
	}
	// The next period opens with the same number and never with the book: the acta and the opening are
	// one read of one closure (S5, S9).
	next, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the next period could not be opened: %v", err)
	}
	opened, err := e.store.Read(e.ctx, warehouse(), next.ID)
	if err != nil {
		t.Fatalf("the next period could not be read: %v", err)
	}
	if opened.PurchaseFundOpening != "300.00" {
		t.Fatalf("the next period opens with the fund its predecessor published, got %s",
			opened.PurchaseFundOpening)
	}
	// The history row of the same settlement publishes the same number, from the same read.
	page, err := e.store.List(e.ctx, warehouse(), 2, 1, 25)
	if err != nil {
		t.Fatalf("the history could not be read: %v", err)
	}
	listed := false
	for _, row := range page.Closings {
		if row.ID != legacy {
			continue
		}
		listed = true
		if row.PurchaseFundCash == nil || string(*row.PurchaseFundCash) != "300.00" {
			t.Fatalf("a history row of the past must publish the fund it settled, got %+v",
				row.PurchaseFundCash)
		}
	}
	if !listed {
		t.Fatalf("the settlement of the past must be part of the history")
	}

	// A settlement whose own closure wrote the movement that reconciled the book is published from the
	// book: the row that names it is the proof that its closure landed the book on what it stated. The
	// state below disagrees on purpose -- the acta states 300.00 while the book holds 200.00 -- because
	// a closure of this version makes the two agree by construction, and the source of the number would
	// then be invisible.
	settled := e.pastFundSettlement(t, 3, "300.00", true)
	if book := e.fundBook(t, 3); book != "200.00" {
		t.Fatalf("the book of the settlement of the past must hold what it held, got %s", book)
	}
	fromBook := mustRead(t, e, settled)
	if fromBook.PurchaseFundCash == nil || string(*fromBook.PurchaseFundCash) != "200.00" {
		t.Fatalf("the acta of a reconciled closure is published from the book, got %+v",
			fromBook.PurchaseFundCash)
	}

	// And the settlements this version closes carry their own movement: the next closure of branch 2
	// states 300.00, names itself in the row it writes, and its acta publishes the sum at its instant --
	// which is exactly the amount it left.
	e.countAll(t, next.ID)
	zero, contribution, left := closings.Money("0.00"), closings.Money("500.00"),
		closings.Money("300.00")
	if _, err := e.store.SaveCash(e.ctx, warehouse(), next.ID, closings.CashDraft{
		CountedCash: &zero, ContributedCash: contribution, ClosingCash: &contribution,
		PurchaseFundCounted: &left, PurchaseFundCash: &left, Observation: "fondo del período",
	}); err != nil {
		t.Fatalf("the fund of the next period could not be drafted: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), next.ID); err != nil {
		t.Fatalf("the next period could not be proposed: %v", err)
	}
	closed, err := e.store.Decide(e.ctx, identity(2), next.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the next period: %v", err)
	}
	if written := e.scalar(t, `SELECT count(*) FROM branch_fund_movements WHERE closing_id=$1`,
		closed.ID); written != 1 {
		t.Fatalf("the closure must write the movement that names it, got %d rows", written)
	}
	if closed.PurchaseFundCash == nil || string(*closed.PurchaseFundCash) != e.fundBook(t, 2) {
		t.Fatalf("the acta of a closure is the book it left, got %+v with the book at %s",
			closed.PurchaseFundCash, e.fundBook(t, 2))
	}
	t.Logf("052: a closed acta is never recalculated by the book")
}

// TestPurchaseFundDifferenceDoesNotBlockButAPendingCountStillDoes pins the informational character
// of the envelope's difference (S8, S5): a fund counted below its expectation never blocks the
// proposal, exactly like the cash difference, while a pending line of the count sheet still does.
func TestPurchaseFundDifferenceDoesNotBlockButAPendingCountStillDoes(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	// The envelope is counted short: 20.00 against an expectation of 0.00, because the previous
	// closure left no purchase fund and the period bought nothing.
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, closings.CashDraft{
		CountedCash: moneyPtr("500.00"), ContributedCash: "0.00", ClosingCash: moneyPtr("100.00"),
		PurchaseFundCounted: moneyPtr("20.00"), PurchaseFundCash: moneyPtr("20.00"),
	}); err != nil {
		t.Fatalf("the envelope must be draftable: %v", err)
	}
	// A pending line still refuses the offer, and the envelope has no part in that refusal.
	if _, err := e.pool.Exec(e.ctx, `UPDATE closing_count_lines SET counted_quantity=NULL
 WHERE closing_id=$1 AND variant_id=2`, opened.ID); err != nil {
		t.Fatalf("the seeded line could not be made pending again: %v", err)
	}
	_, err = e.store.Propose(e.ctx, warehouse(), opened.ID)
	var pending *closings.CountPending
	if !errors.As(err, &pending) || pending.VariantID != 2 {
		t.Fatalf("a pending variant must still refuse the offer: %v", err)
	}
	refused(t, err, closings.ErrClosureRefused)
	// The same settlement, with the line counted, is offered with the difference of the envelope
	// published and unblocking.
	if _, err := e.store.Count(e.ctx, warehouse(), opened.ID,
		[]closings.Counted{{VariantID: 2, Quantity: 4}}); err != nil {
		t.Fatalf("the pending line could not be counted: %v", err)
	}
	proposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("a fund difference must never block the proposal: %v", err)
	}
	if proposed.PurchaseFundCounted == nil || *proposed.PurchaseFundCounted != "20.00" ||
		proposed.PurchaseFundDifference == nil || *proposed.PurchaseFundDifference != "20.00" ||
		proposed.PurchaseFundExpected != "0.00" {
		t.Fatalf("the difference of the envelope must be published with its sign: %+v", proposed)
	}
	// The branch accepts it: the difference is reported, never a refusal, and the drawer keeps its
	// own identities untouched by the second envelope.
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil || closed.Status != closings.StatusClosed ||
		closed.PurchaseFundDifference == nil || *closed.PurchaseFundDifference != "20.00" ||
		*closed.CashDifference != "0.00" || *closed.TakenCash != "400.00" {
		t.Fatalf("a difference of the envelope must not block the closure: %+v %v", closed, err)
	}
}

// purchaseLines registers one purchase of branch 2 with the lines the test states, paid in cash for
// the amount it states -- which is the sum of the line amounts the document derives -- so a fixture
// writes the documents the branch really writes, scrap and used lines alike.
func (e *env) purchaseLines(t *testing.T, key, cash string,
	used []purchases.UsedLineInput, scrap []purchases.ScrapLineInput) purchases.Document {
	t.Helper()
	document, err := e.purchases.Create(e.ctx, identity(2), purchases.CreateInput{
		OperationKey: key,
		UsedLines:    used,
		ScrapLines:   scrap,
		PaidCash:     purchases.Money(cash),
		PaidTransfer: "0.00",
	})
	if err != nil {
		t.Fatalf("the purchase %q could not be registered: %v", key, err)
	}
	return document
}

// materialSheet is one settlement's sheet as a value, so a test proves the whole published shape with
// one comparison: the kind, the key, the unit, the expected quantity, the counted one and the two
// derived numbers, line by line in the order the document publishes them.
func materialSheet(t *testing.T, closing closings.Closing) []string {
	t.Helper()
	sheet := make([]string, 0, len(closing.MaterialLines))
	for _, line := range closing.MaterialLines {
		key := ""
		switch {
		case line.Model != nil:
			key = *line.Model
		case line.MaterialID != nil:
			key = fmt.Sprintf("%d/%s", *line.MaterialID, *line.Material)
		}
		sheet = append(sheet, fmt.Sprintf("%s:%s:%s:%s:%s:%s:%s", line.Kind, key, line.Unit,
			line.Expected, optionalQuantity(line.Counted), optionalDifference(line.Difference),
			optionalQuantity(line.Delivered)))
	}
	return sheet
}

// optionalQuantity renders a quantity that may still be pending, which is exactly the JSON null of
// the contract.
func optionalQuantity(quantity *closings.Quantity) string {
	if quantity == nil {
		return "-"
	}
	return string(*quantity)
}

// optionalDifference renders a difference that may still be unknown.
func optionalDifference(difference *closings.SignedQuantity) string {
	if difference == nil {
		return "-"
	}
	return difference.String()
}

// TestMaterialSheetIsTheThirdAccountOfTheDocument pins S7 and S8 at the store: the sheet of a
// settlement is what its period bought -- the sum of the used quantity per model and of the kilos per
// material of the purchases of its own window -- against what the warehouse counted, in the order the
// document publishes (the used lines by model, then the scrap ones by material id), with the
// difference of every counted line and the quantity that goes to the warehouse. A line nobody counted
// stays pending and states no difference and no delivery, and it blocks nothing: the settlement closes
// with it and keeps exactly the count it signed.
func TestMaterialSheetIsTheThirdAccountOfTheDocument(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	e.fundLoad(t, 2, "200.00", "Carga de fondo para las compras del período")
	// The period buys two used models in one document and two materials in another: 6 + 4 units and
	// 12.500 + 4.250 kilograms, which is what the shelf is expected to hold at the cut.
	e.purchaseLines(t, "closings-materials-used-01", "80.00", []purchases.UsedLineInput{
		{Model: "NS60ZL", Quantity: 6, UnitPrice: "10.00"},
		{Model: "12N6,5_3B", Quantity: 4, UnitPrice: "5.00"},
	}, nil)
	e.purchaseLines(t, "closings-materials-scrap-01", "33.50", nil, []purchases.ScrapLineInput{
		{MaterialID: 1, Kg: "12.500", PricePerKg: "2.00"},
		{MaterialID: 3, Kg: "4.250", PricePerKg: "2.00"},
	})
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	read, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be read: %v", err)
	}
	// The expected quantity is the period's own purchases, the order is the document's, and a line the
	// warehouse has not counted states a count, a difference and a delivery of null.
	want := []string{
		"used:12N6,5_3B:unit:4:-:-:-",
		"used:NS60ZL:unit:6:-:-:-",
		"scrap:1/Cobre:kg:12.500:-:-:-",
		"scrap:3/Plomo:kg:4.250:-:-:-",
	}
	if got := materialSheet(t, read); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("the sheet must be the purchases of the period, got %v want %v", got, want)
	}
	// The history publishes the same sheet: one derivation for the document and its rows (S8).
	page, err := e.store.List(e.ctx, warehouse(), 2, 1, 25)
	if err != nil || len(page.Closings) != 2 {
		t.Fatalf("the history could not be read: %+v %v", page, err)
	}
	if got := materialSheet(t, page.Closings[0]); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("a history row must publish the sheet of its own document, got %v want %v", got, want)
	}

	// The warehouse counts: one model short, one exactly, one material over, and the lead left
	// pending. The difference is informed with its sign and the delivery is everything counted (S8, S9).
	counted, err := e.store.CountMaterials(e.ctx, warehouse(), read.ID, []closings.MaterialCounted{
		{Kind: closings.MaterialKindUsed, Model: "12N6,5_3B", Quantity: "3"},
		{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "6"},
		{Kind: closings.MaterialKindScrap, MaterialID: 1, Quantity: "13.500"},
	})
	if err != nil {
		t.Fatalf("the material sheet could not be counted: %v", err)
	}
	want = []string{
		"used:12N6,5_3B:unit:4:3:-1:3",
		"used:NS60ZL:unit:6:6:0:6",
		"scrap:1/Cobre:kg:12.500:13.500:1.000:13.500",
		"scrap:3/Plomo:kg:4.250:-:-:-",
	}
	if got := materialSheet(t, counted); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("the counted sheet is not the one the warehouse stated, got %v want %v", got, want)
	}
	// The same request stated twice leaves the same sheet: counting this sheet is idempotent.
	again, err := e.store.CountMaterials(e.ctx, warehouse(), read.ID, []closings.MaterialCounted{
		{Kind: closings.MaterialKindScrap, MaterialID: 1, Quantity: "13.500"},
	})
	if err != nil || strings.Join(materialSheet(t, again), ",") != strings.Join(want, ",") {
		t.Fatalf("the same count twice must leave the same sheet: %v %v", materialSheet(t, again), err)
	}
	// The pending lead line blocks nothing: the settlement is proposed and closed with it, and the
	// closure publishes exactly the counts the branch signed (S9).
	if _, err := e.store.SaveCash(e.ctx, warehouse(), read.ID,
		draft("500.00", "0.00", "100.00")); err != nil {
		t.Fatalf("the drawer draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), read.ID); err != nil {
		t.Fatalf("a pending material line must never block the proposal: %v", err)
	}
	closed, err := e.store.Decide(e.ctx, identity(2), read.ID, closings.DecisionAccepted, "")
	if err != nil || closed.Status != closings.StatusClosed {
		t.Fatalf("the branch must accept the settlement: %+v %v", closed, err)
	}
	if got := materialSheet(t, closed); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("the closure must keep the sheet it was offered, got %v want %v", got, want)
	}
	// A closed settlement's sheet never moves, and the store refuses the write by its own state.
	refused(t, func() error {
		_, err := e.store.CountMaterials(e.ctx, warehouse(), read.ID, []closings.MaterialCounted{
			{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "5"},
		})
		return err
	}(), closings.ErrCountFrozen)
	if got := e.text(t, `SELECT coalesce(counted_quantity::text,'-') FROM closing_material_lines
 WHERE closing_id=$1 AND model='NS60ZL'`, read.ID); got != "6.000" {
		t.Fatalf("a refused count must leave the sheet as it was: %q", got)
	}
}

// TestMaterialDraftIsValidatedLikeTheCountSheet pins the shape half of S8 at the store: the request
// states the key of each line and its count and nothing else, every line is the canonical quantity of
// its unit, a material outside the reference table is refused, and the sheet of a settlement is
// written whole or not at all. Only the warehouse counts it, and only while it holds the settlement.
func TestMaterialDraftIsValidatedLikeTheCountSheet(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	e.fundLoad(t, 2, "100.00", "Carga de fondo para las compras del período")
	e.purchaseLines(t, "closings-materials-draft-01", "20.00",
		[]purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "10.00"}}, nil)
	e.purchaseLines(t, "closings-materials-draft-02", "3.00", nil,
		[]purchases.ScrapLineInput{{MaterialID: 2, Kg: "1.500", PricePerKg: "2.00"}})
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	seeded := materialSheet(t, opened)
	// Every refusal below is a request error, and none of them writes a line: the sheet is the seed.
	for name, wrong := range map[string][]closings.MaterialCounted{
		"a negative count":           {{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "-1"}},
		"a fraction of a battery":    {{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "1.5"}},
		"a padded unit count":        {{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "02"}},
		"two decimals of scrap":      {{Kind: closings.MaterialKindScrap, MaterialID: 2, Quantity: "1.50"}},
		"a model that is not one":    {{Kind: closings.MaterialKindUsed, Model: "ns60zl", Quantity: "2"}},
		"a material that is not one": {{Kind: closings.MaterialKindScrap, MaterialID: 99, Quantity: "1.500"}},
		"the key of the other kind":  {{Kind: closings.MaterialKindUsed, MaterialID: 2, Quantity: "2"}},
		"an unknown kind":            {{Kind: closings.MaterialKind("battery"), Model: "NS60ZL", Quantity: "2"}},
		"the same key twice": {
			{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "2"},
			{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "1"},
		},
		"nothing at all": {},
	} {
		if _, err := e.store.CountMaterials(e.ctx, warehouse(), opened.ID, wrong); !errors.Is(err, closings.ErrInvalid) {
			t.Fatalf("%s must be refused as a request error, got %v", name, err)
		}
	}
	if got := materialSheet(t, mustRead(t, e, opened.ID)); strings.Join(got, ",") != strings.Join(seeded, ",") {
		t.Fatalf("a refused count must write nothing, got %v want %v", got, seeded)
	}
	// The sheet belongs to the warehouse and to a settlement that exists.
	valid := []closings.MaterialCounted{{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "2"}}
	if _, err := e.store.CountMaterials(e.ctx, identity(2), opened.ID, valid); !errors.Is(err, closings.ErrForbidden) {
		t.Fatalf("only the warehouse counts this sheet, got %v", err)
	}
	if _, err := e.store.CountMaterials(e.ctx, warehouse(), opened.ID+1, valid); !errors.Is(err, closings.ErrNotFound) {
		t.Fatalf("an unknown settlement has no sheet, got %v", err)
	}
	// Once proposed the sheet is the offer the branch decides, exactly like the count sheet of the
	// stock (LC004, LC025).
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("500.00", "0.00", "100.00")); err != nil {
		t.Fatalf("the drawer draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	if _, err := e.store.CountMaterials(e.ctx, warehouse(), opened.ID, valid); !errors.Is(err, closings.ErrCountFrozen) {
		t.Fatalf("a proposed settlement's sheet is frozen, got %v", err)
	}
}

// mustRead reads one settlement of the fixture, failing the test when it cannot.
func mustRead(t *testing.T, e *env, id int64) closings.Closing {
	t.Helper()
	closing, err := e.store.Read(e.ctx, warehouse(), id)
	if err != nil {
		t.Fatalf("the settlement could not be read: %v", err)
	}
	return closing
}

// TestMaterialSheetRefusesAKeyThePeriodNeverBought proves the sheet is the opening's own fact: the
// warehouse counts the lines the period bought, and a key the seed never created is refused instead
// of stored with a zero expectation that would publish a difference nobody counted against. The
// case that matters is a settlement already open when the sheet arrived: it has no seeded line, so
// nothing of it can be counted into a false shortfall.
func TestMaterialSheetRefusesAKeyThePeriodNeverBought(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	e.fundLoad(t, 2, "100.00", "Carga de fondo para las compras del período")
	e.purchaseLines(t, "closings-materials-unknown-01", "20.00", []purchases.UsedLineInput{
		{Model: "NS60ZL", Quantity: 2, UnitPrice: "10.00"},
	}, nil)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	before := e.readMaterialSheet(t, opened.ID)
	_, err = e.store.CountMaterials(e.ctx, warehouse(), opened.ID, []closings.MaterialCounted{
		{Kind: closings.MaterialKindUsed, Model: "XX99", Quantity: "1"},
	})
	if !errors.Is(err, closings.ErrInvalid) {
		t.Fatalf("a model the period never bought must be refused, got %v", err)
	}
	if after := e.readMaterialSheet(t, opened.ID); after != before {
		t.Fatalf("a refused count must write nothing, got %q before %q", after, before)
	}
	// The key the period did buy is still countable, and only its count moves.
	if _, err := e.store.CountMaterials(e.ctx, warehouse(), opened.ID, []closings.MaterialCounted{
		{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "1"},
	}); err != nil {
		t.Fatalf("the seeded line must be countable: %v", err)
	}
	if got := e.readMaterialSheet(t, opened.ID); got != "used:NS60ZL:unit:2:1:-1:1" {
		t.Fatalf("the seeded line must keep its expectation, got %q", got)
	}
}

// TestMaterialSheetIsReadInByteOrder pins the order the sheet is published in: the models of the used
// lines sort by bytes, the same comparison the read revalidates with, so a database collation that
// orders punctuation differently can never turn a valid sheet into an unreadable settlement.
func TestMaterialSheetIsReadInByteOrder(t *testing.T) {
	source, err := os.ReadFile("store.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(source), `line.model COLLATE "C"`) {
		t.Fatal("the material sheet must order its models by bytes, the same order it revalidates")
	}
}

// readMaterialSheet is the sheet of one settlement as one value, read through the public document so a
// test compares what the screens are published, never a query of its own.
func (e *env) readMaterialSheet(t *testing.T, id int64) string {
	t.Helper()
	read, err := e.store.Read(e.ctx, warehouse(), id)
	if err != nil {
		t.Fatalf("the settlement could not be read: %v", err)
	}
	return strings.Join(materialSheet(t, read), ",")
}

// book records one movement of the branch's own book straight into the ledger, with exactly the
// shape the database's own admission admits: an account of that branch, a positive amount, a real
// description, the instant the database stamps and -- for a correction -- the movement it answers.
// The store gains its own paths for aportes, recaudaciones and corrections in T3, so the reads
// below are tested against a ledger the domain already admits and never against a shape it refuses.
func (e *env) book(t *testing.T, branch int, kind, amount, description string, corrects *int64) int64 {
	t.Helper()
	var id int64
	if err := e.pool.QueryRow(e.ctx, `INSERT INTO branch_cash_movements(
  branch_location_id,kind,amount,description,created_by_account_id,corrects_id)
 VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
		branch, kind, amount, description, branch, corrects).Scan(&id); err != nil {
		t.Fatalf("the ledger movement %q could not be recorded: %v", description, err)
	}
	return id
}

// correction answers one movement of the branch's book with the compensating row of its own kind,
// which is how an immutable ledger states a wrong row (S6).
func (e *env) correction(t *testing.T, branch int, corrects int64, amount, description string) int64 {
	t.Helper()
	return e.book(t, branch, "correccion", amount, description, &corrects)
}

// TestPeriodExpensesAreNetOfTheirCorrections pins S4 and S13 on the period totals: the expense of a
// window is the net of the effects it holds, so a correction of a gasto lowers the expense of the
// period that holds both, and the proposal and the closure state that same net instead of a total
// one reader derives and another forgets.
func TestPeriodExpensesAreNetOfTheirCorrections(t *testing.T) {
	e := fixture(t)
	// The previous period closed at 500.00 in the drawer, so the drawer of this one is known.
	e.closeFirstSettlement(t, "500.00")
	flete := e.expense(t, 2, "100.00", "Flete")
	correction := e.correction(t, 2, flete.ID, "40.00", "Flete mal cargado")
	if correction <= flete.ID {
		t.Fatalf("the correction must be a later row of the ledger: %d after %d", correction, flete.ID)
	}
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("440.00", "0.00", "40.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}

	proposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	// 100.00 paid out and 40.00 of it corrected back is 60.00 of the drawer: the correction is not a
	// second expense and not a number the total can ignore.
	if proposed.CashExpenses != "60.00" {
		t.Fatalf("the period expense must be the net of its corrections: %q", proposed.CashExpenses)
	}
	if offer := proposed.LatestRound().Payload; offer.CashExpenses != "60.00" {
		t.Fatalf("the offer must state the net expense it subtracts: %q", offer.CashExpenses)
	}
	// S4: expected = 500.00 inherited + 0.00 collected - 60.00 net expense.
	if proposed.ExpectedCash != "440.00" {
		t.Fatalf("the drawer must be charged the net expense: %q", proposed.ExpectedCash)
	}

	// The closure recomputes the same period with the same read, so the closed document states the
	// net it offered and never the two rows separately.
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the offer: %v", err)
	}
	if closed.CashExpenses != "60.00" || closed.ExpectedCash != "440.00" {
		t.Fatalf("the closed settlement must keep the net expense it settled: %+v", closed)
	}
}

// TestExpensesPublishTheCorrectionsOfTheirWindow pins S13 on the list beside the total: the ledger
// rows a settlement publishes are the rows its total was computed from, so a correction appears
// beside the gasto it answers, with its own kind, its own positive amount and the movement it names.
func TestExpensesPublishTheCorrectionsOfTheirWindow(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	flete := e.expense(t, 2, "100.00", "Flete")
	correction := e.correction(t, 2, flete.ID, "40.00", "Flete mal cargado")
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	assertExpenses := func(document closings.Closing) {
		t.Helper()
		if len(document.Expenses) != 2 {
			t.Fatalf("the document must list the gasto and its correction: %+v", document.Expenses)
		}
		gasto, fixed := document.Expenses[0], document.Expenses[1]
		if gasto.ID != flete.ID || gasto.Kind != "gasto" || gasto.CorrectsID != nil ||
			gasto.Amount != "100.00" {
			t.Fatalf("the first row must be the gasto the branch recorded: %+v", gasto)
		}
		// The amount of a correction is the positive amount it states: the sign is the view's own
		// reading and never a second shape stored in the ledger (S13).
		if fixed.ID != correction || fixed.Kind != "correccion" || fixed.CorrectsID == nil ||
			*fixed.CorrectsID != flete.ID || fixed.Amount != "40.00" {
			t.Fatalf("the second row must be the correction of that gasto: %+v", fixed)
		}
		if document.CashExpenses != "60.00" {
			t.Fatalf("the total of the listed rows must be their net: %q", document.CashExpenses)
		}
	}
	assertExpenses(opened)
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("440.00", "0.00", "40.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	proposed, err := e.store.Propose(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	assertExpenses(proposed)
	read, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be read: %v", err)
	}
	assertExpenses(read)
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil {
		t.Fatalf("the branch must accept the settlement: %v", err)
	}
	assertExpenses(closed)
}

// TestCashLedgerStatesTheDrawerOfTheWindow pins S4 and S13 on the book of the screen: it opens at the
// amount the last closed settlement left in the drawer, collects the cash sales made after that cut,
// lists every movement of the period oldest first with the sign the ledger view states, and derives
// one expectation from exactly those three terms.
func TestCashLedgerStatesTheDrawerOfTheWindow(t *testing.T) {
	e := fixture(t)
	first := e.closeFirstSettlement(t, "500.00")
	cut, err := e.store.Read(e.ctx, warehouse(), first)
	if err != nil {
		t.Fatalf("the closed settlement could not be read: %v", err)
	}
	// After the cut the branch sells in cash and writes its book: a gasto, the correction of that
	// gasto, an aporte and a recaudacion, which is every direction the drawer can move.
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	flete := e.expense(t, 2, "30.00", "Flete")
	e.correction(t, 2, flete.ID, "10.00", "Flete mal cargado")
	e.book(t, 2, "aporte", "50.00", "Cambio para el cajón", nil)
	e.book(t, 2, "recaudacion", "20.00", "Retiro entre rendiciones", nil)

	book, err := e.store.CashLedger(e.ctx, identity(2), nil, nil)
	if err != nil {
		t.Fatalf("the branch must read its own drawer: %v", err)
	}
	// The window starts at the cut of the last closed settlement and has no end.
	if book.Since == nil || !book.Since.Equal(cut.CutAt) || book.Until != nil {
		t.Fatalf("the book must open at the cut of the last closure: %+v", book)
	}
	if book.Opening != "500.00" || book.Sales != "100.00" {
		t.Fatalf("the book must state the drawer it inherited and the cash it collected: %+v", book)
	}
	if len(book.Movements) != 4 {
		t.Fatalf("the book must list every movement of the period: %+v", book.Movements)
	}
	want := []struct{ kind, effect string }{
		{"gasto", "-30.00"}, {"correccion", "10.00"}, {"aporte", "50.00"}, {"recaudacion", "-20.00"},
	}
	for i, expected := range want {
		movement := book.Movements[i]
		if movement.Kind != expected.kind || movement.Effective != closings.Signed(expected.effect) {
			t.Fatalf("row %d is not %s with %s: %+v", i, expected.kind, expected.effect, movement)
		}
		if movement.BranchID != 2 || movement.CreatedByAccountID != 2 ||
			movement.OccurredAt.IsZero() || movement.Description == "" {
			t.Fatalf("row %d must be a fact of this branch: %+v", i, movement)
		}
	}
	// The correction carries the direction of what it answers, and the amount stays positive.
	if book.Movements[1].CorrectsID == nil || *book.Movements[1].CorrectsID != flete.ID ||
		book.Movements[1].EffectKind != "gasto" || book.Movements[1].Amount != "10.00" {
		t.Fatalf("the correction must name the gasto it answers: %+v", book.Movements[1])
	}
	// S13: the expectation is one arithmetic over the rows the book publishes.
	if book.Effective != "10.00" {
		t.Fatalf("the signed effect of the window is -30.00 +10.00 +50.00 -20.00: %q", book.Effective)
	}
	opening, ok := closings.Signed(book.Opening).Cents()
	if !ok {
		t.Fatalf("the published opening is not canonical money: %q", book.Opening)
	}
	sold, ok := closings.Signed(book.Sales).Cents()
	if !ok {
		t.Fatalf("the published sales are not canonical money: %q", book.Sales)
	}
	effect, ok := book.Effective.Cents()
	if !ok {
		t.Fatalf("the published effect is not a signed amount: %q", book.Effective)
	}
	expected, ok := book.Expected.Cents()
	if !ok || expected != opening+sold+effect {
		t.Fatalf("expected must be opening + sales + effective: %q", book.Expected)
	}
	if book.Expected != "610.00" {
		t.Fatalf("500.00 inherited + 100.00 collected + 10.00 of movements: %q", book.Expected)
	}

	// A window that starts at an explicit instant inherits no drawer: the opening is the amount the
	// last settled period left and it belongs to the cut, so the book states the window's own
	// movement and never a balance it cannot know.
	window, err := e.store.CashLedger(e.ctx, identity(2), book.Since, nil)
	if err != nil {
		t.Fatalf("an explicit window must be read: %v", err)
	}
	if window.Since == nil || !window.Since.Equal(*book.Since) || window.Opening != "0.00" ||
		window.Sales != "100.00" || window.Expected != "110.00" {
		t.Fatalf("an explicit window states no inherited drawer: %+v", window)
	}
	// An empty window is an empty book, never a zero that hides a whole history.
	until := *book.Since
	empty, err := e.store.CashLedger(e.ctx, identity(2), nil, &until)
	if err != nil || len(empty.Movements) != 0 || empty.Opening != "500.00" || empty.Sales != "0.00" {
		t.Fatalf("a window before the cut holds nothing: %+v %v", empty, err)
	}
}

// TestCashLedgerLeavesTheSettlementsTransfersOutOfTheBook pins S5: the aporte a closure writes is the
// contribution of the Almacén and the recaudacion it writes is the money it takes, and both are the
// acta's own facts. The book of the period is the rows the branch wrote, so a transfer of a
// settlement is absent from the list and from the expectation -- otherwise the drawer would count
// that money twice.
func TestCashLedgerLeavesTheSettlementsTransfersOutOfTheBook(t *testing.T) {
	e := fixture(t)
	first := e.closeFirstSettlement(t, "500.00")
	// The closure did write its own movement: the contribution of 500.00 into the drawer.
	if transfers := e.scalar(t, `SELECT count(*) FROM branch_cash_movements
 WHERE closing_id=$1 AND kind='aporte' AND amount=500.00`, first); transfers != 1 {
		t.Fatalf("the closure must have written the contribution of its settlement: %d", transfers)
	}
	book, err := e.store.CashLedger(e.ctx, identity(2), nil, nil)
	if err != nil {
		t.Fatalf("the branch must read its own drawer: %v", err)
	}
	if len(book.Movements) != 0 {
		t.Fatalf("a transfer of a settlement is not a movement of the period: %+v", book.Movements)
	}
	// 500.00 in the drawer and nothing counted twice: the contribution is already the opening.
	if book.Opening != "500.00" || book.Effective != "0.00" || book.Expected != "500.00" {
		t.Fatalf("the acta's contribution must not enter the expectation: %+v", book)
	}

	// The same kind and amount written by the branch is a movement of the period and does count.
	e.book(t, 2, "aporte", "50.00", "Cambio para el cajón", nil)
	book, err = e.store.CashLedger(e.ctx, identity(2), nil, nil)
	if err != nil {
		t.Fatalf("the branch must read its own drawer: %v", err)
	}
	if len(book.Movements) != 1 || book.Movements[0].Kind != "aporte" ||
		book.Movements[0].Amount != "50.00" || book.Effective != "50.00" ||
		book.Expected != "550.00" {
		t.Fatalf("a movement of the period must enter the book and its expectation: %+v", book)
	}
}

// TestCashLedgerIsTheBranchOwn pins S12 on the book: the drawer is the one the session works, so the
// warehouse has no drawer to read here, an identity the provisioned accounts do not hold is refused,
// a session still forced to change its password does not read the branch's money, and a window that
// ends before it starts is an invalid request instead of an empty answer.
func TestCashLedgerIsTheBranchOwn(t *testing.T) {
	e := fixture(t)
	_, err := e.store.CashLedger(e.ctx, warehouse(), nil, nil)
	refused(t, err, closings.ErrForbidden)
	_, err = e.store.CashLedger(e.ctx, auth.Identity{}, nil, nil)
	refused(t, err, closings.ErrForbidden)
	_, err = e.store.CashLedger(e.ctx, auth.Identity{AccountID: 2, Location: auth.Location{ID: 3}},
		nil, nil)
	refused(t, err, closings.ErrForbidden)
	_, err = e.store.CashLedger(e.ctx, auth.Identity{AccountID: 2, Location: auth.Location{ID: 2},
		MustChangePassword: true}, nil, nil)
	refused(t, err, closings.ErrForbidden)

	// A range that ends before it starts describes no period at all.
	from, to := time.Now(), time.Now().Add(-time.Hour)
	_, err = e.store.CashLedger(e.ctx, identity(2), &from, &to)
	refused(t, err, closings.ErrInvalid)

	// A branch that never closed a settlement starts at zero and at no instant, exactly like the
	// drawer of today: the window is everything it ever did.
	book, err := e.store.CashLedger(e.ctx, identity(2), nil, nil)
	if err != nil {
		t.Fatalf("the branch must read its own drawer: %v", err)
	}
	if book.Since != nil || book.Until != nil || book.Opening != "0.00" ||
		book.Sales != "0.00" || book.Effective != "0.00" || book.Expected != "0.00" ||
		len(book.Movements) != 0 {
		t.Fatalf("a branch that never closed inherits nothing: %+v", book)
	}
}

// TestCashLedgerTotalCoversTheWholeWindow pins S4 and S13 on a window longer than the book publishes: the
// list keeps the newest rows and says so, and the signed effect beside it is the sum of every row of the
// window -- never the sum of the part of the window the list kept, which is a total that looks right and
// is not.
func TestCashLedgerTotalCoversTheWholeWindow(t *testing.T) {
	e := fixture(t)
	// The till inherits the fund the bootstrap settlement left, because the drawer spends only what it
	// holds (S1): 600.00 pays the 100.00 row and the 500 rows of 1.00 below. The inheritance is not a
	// movement of the window, so it enters the expectation as the opening and never as an effect.
	e.closeFirstSettlement(t, "600.00")
	// The oldest row of the window is the one the bound drops and the only amount that differs, so a
	// total summed over the published rows is off by exactly this amount.
	oldest := e.book(t, 2, "gasto", "100.00", "Compra de la tienda", nil)
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO branch_cash_movements(
  branch_location_id,kind,amount,description,created_by_account_id)
 SELECT 2,'gasto',1.00,'Gasto '||row,2 FROM generate_series(1,500) row`); err != nil {
		t.Fatalf("the window could not be filled: %v", err)
	}
	if rows := e.scalar(t, `SELECT count(*) FROM branch_cash_movements
 WHERE branch_location_id=2 AND closing_id IS NULL`); rows != 501 {
		t.Fatalf("the window must hold 501 rows: %d", rows)
	}

	book, err := e.store.CashLedger(e.ctx, identity(2), nil, nil)
	if err != nil {
		t.Fatalf("the branch must read its own drawer: %v", err)
	}
	// The list is the newest rows of the window and states that it is a window of them.
	if len(book.Movements) != 500 || !book.Truncated {
		t.Fatalf("the book must publish the newest 500 rows and say it truncated: %d %t",
			len(book.Movements), book.Truncated)
	}
	for _, movement := range book.Movements {
		if movement.ID == oldest {
			t.Fatalf("the dropped row must not be published: %+v", movement)
		}
	}
	// The total is the whole window: -100.00 dropped from the list and 500 x 1.00 published, and the
	// expectation is the 600.00 the till inherited plus that whole effect.
	if book.Effective != "-600.00" || book.Expected != "0.00" {
		t.Fatalf("the total must cover every row of the window: %q %q", book.Effective, book.Expected)
	}

	// A window that holds fewer rows than the bound is the whole book and is never truncated.
	after := time.Now().Add(time.Minute)
	narrow, err := e.store.CashLedger(e.ctx, identity(2), &after, nil)
	if err != nil {
		t.Fatalf("an explicit window must be read: %v", err)
	}
	if narrow.Truncated || len(narrow.Movements) != 0 || narrow.Effective != "0.00" ||
		narrow.Expected != "0.00" {
		t.Fatalf("an empty window is a book of nothing: %+v", narrow)
	}
}

// TestRecordCashMovementIsTheBranchOwn pins S1, S2 and S12 on the write of a movement of the period: the
// three kinds the branch records are its own rows, the warehouse has no drawer to write, another branch
// writes only its own, and a malformed shape or a frozen branch writes nothing at all.
func TestRecordCashMovementIsTheBranchOwn(t *testing.T) {
	e := fixture(t)
	// The till holds the 12.50 the gasto below spends, and the aporte of the loop puts it back, so every
	// kind of the loop is reachable on a drawer that never goes negative (S1, S3).
	e.contribute(t, 2, "12.50", "Fondo de la caja operativa")
	for _, kind := range []string{"gasto", "aporte", "recaudacion"} {
		movement, err := e.store.RecordCashMovement(e.ctx, identity(2), kind,
			closings.Money("12.50"), "Movimiento de la caja operativa")
		if err != nil {
			t.Fatalf("the branch must record its own %q: %v", kind, err)
		}
		if movement.ID < 1 || movement.BranchID != 2 || movement.Kind != kind ||
			movement.Amount != "12.50" || movement.Description != "Movimiento de la caja operativa" ||
			movement.CreatedByAccountID != 2 || movement.OccurredAt.IsZero() ||
			movement.CorrectsID != nil {
			t.Fatalf("the recorded %q is not a movement of this branch's book: %+v", kind, movement)
		}
	}
	// The warehouse has no drawer of its own.
	_, err := e.store.RecordCashMovement(e.ctx, warehouse(), "gasto",
		closings.Money("1.00"), "Flete del almacén")
	refused(t, err, closings.ErrNotBranchExpense)
	// Every branch writes its own rows and reads them as its own.
	other, err := e.store.RecordCashMovement(e.ctx, identity(3), "aporte",
		closings.Money("5.00"), "Cambio de la otra sucursal")
	if err != nil || other.BranchID != 3 || other.CreatedByAccountID != 3 {
		t.Fatalf("a branch records only its own movements: %+v %v", other, err)
	}
	// A correction is not a direction the branch states here, and a shape the ledger never admits is
	// refused before the database is touched.
	for _, tc := range []struct{ kind, amount, description string }{
		{"correccion", "1.00", "Corrijo el flete"},
		{"devolucion", "1.00", "Flete"},
		{"gasto", "0.00", "Flete"},
		{"gasto", "-1.00", "Flete"},
		{"gasto", "1.234", "Flete"},
		{"gasto", "1.00", "   "},
		{"gasto", "1.00", strings.Repeat("ñ", closings.MaxDescription+1)},
	} {
		_, err := e.store.RecordCashMovement(e.ctx, identity(2), tc.kind,
			closings.Money(tc.amount), tc.description)
		refused(t, err, closings.ErrInvalid)
	}
	// A session still forced to change its password does not move the branch's money.
	_, err = e.store.RecordCashMovement(e.ctx, auth.Identity{AccountID: 2,
		Location: auth.Location{ID: 2}, MustChangePassword: true}, "gasto",
		closings.Money("1.00"), "Flete")
	refused(t, err, closings.ErrForbidden)
	// A frozen branch writes no movement of the period, exactly like it records no expense (S9).
	if _, err := e.store.Open(e.ctx, warehouse(), 2); err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	written := e.scalar(t, `SELECT count(*) FROM branch_cash_movements WHERE branch_location_id=2`)
	_, err = e.store.RecordCashMovement(e.ctx, identity(2), "aporte",
		closings.Money("1.00"), "Cambio del cajón")
	refused(t, err, closings.ErrBranchFrozen)
	if after := e.scalar(t, `SELECT count(*) FROM branch_cash_movements
 WHERE branch_location_id=2`); after != written {
		t.Fatalf("a refused movement wrote a row: %d after %d", after, written)
	}
}

// TestCashCorrectionRefusalsAreNotOutages pins S6 and S7 on the write of a correction: a target the book
// may not answer is a request error and a set of corrections above the corrected amount is a conflict,
// and neither is ever the 503 an unmapped SQLSTATE would produce.
func TestCashCorrectionRefusalsAreNotOutages(t *testing.T) {
	e := fixture(t)
	// Each till is funded before it pays anything out, because the drawer spends only what it holds (S1).
	e.contribute(t, 2, "50.00", "Fondo de la caja")
	flete := e.expense(t, 2, "50.00", "Flete")
	first, err := e.store.CorrectCashMovement(e.ctx, identity(2), flete.ID,
		closings.Money("30.00"), "Flete mal cargado")
	if err != nil {
		t.Fatalf("a movement of its own branch must be correctable: %v", err)
	}
	if first.Kind != "correccion" || first.CorrectsID == nil || *first.CorrectsID != flete.ID ||
		first.Amount != "30.00" || first.BranchID != 2 || first.CreatedByAccountID != 2 {
		t.Fatalf("the correction is not the row this book states: %+v", first)
	}
	// LC031 is the sum of the corrections against the amount the corrected movement stated: 50.00 is
	// what it can answer, and 30.00 is already used.
	_, err = e.store.CorrectCashMovement(e.ctx, identity(2), flete.ID,
		closings.Money("20.01"), "Corrijo de más")
	refused(t, err, closings.ErrStateConflict)
	if errors.Is(err, closings.ErrUnavailable) {
		t.Fatalf("an excess over the corrected amount is a conflict, never an outage: %v", err)
	}
	var exceeds *closings.CorrectionExceeds
	if !errors.As(err, &exceeds) {
		t.Fatalf("the excess must be named for the route that acts on it: %v", err)
	}
	// What still fits under the amount is admitted: the tope is the sum, not a single row.
	if _, err := e.store.CorrectCashMovement(e.ctx, identity(2), flete.ID,
		closings.Money("20.00"), "El resto del flete"); err != nil {
		t.Fatalf("the rest of the movement still fits under its amount: %v", err)
	}
	_, err = e.store.CorrectCashMovement(e.ctx, identity(2), flete.ID,
		closings.Money("0.01"), "Un centavo más")
	refused(t, err, closings.ErrStateConflict)

	// LC030 is a target the book may not answer: a movement that does not exist, one of another branch
	// and a correction itself.
	_, err = e.store.CorrectCashMovement(e.ctx, identity(2), flete.ID+100_000,
		closings.Money("1.00"), "Movimiento que no existe")
	refused(t, err, closings.ErrInvalid)
	if errors.Is(err, closings.ErrUnavailable) {
		t.Fatalf("a target the book may not answer is a request error, never an outage: %v", err)
	}
	var target *closings.CorrectionTargetInvalid
	if !errors.As(err, &target) {
		t.Fatalf("the invalid target must be named for the route that acts on it: %v", err)
	}
	e.contribute(t, 3, "10.00", "Fondo de la otra sucursal")
	other := e.expense(t, 3, "10.00", "Flete de la otra sucursal")
	_, err = e.store.CorrectCashMovement(e.ctx, identity(2), other.ID,
		closings.Money("5.00"), "No es un movimiento mío")
	refused(t, err, closings.ErrInvalid)
	_, err = e.store.CorrectCashMovement(e.ctx, identity(2), first.ID,
		closings.Money("1.00"), "Corrijo la corrección")
	refused(t, err, closings.ErrInvalid)
	// A movement id is never zero, and the refusal is the same class (S6).
	_, err = e.store.CorrectCashMovement(e.ctx, identity(2), 0,
		closings.Money("1.00"), "Sin movimiento")
	refused(t, err, closings.ErrInvalid)
}

// TestDrawerExpectedIsTheOneRule pins the arithmetic every reader of the drawer shares (S4, S13): the
// expectation is the inherited fund plus the cash sales plus the signed effect of the window, and the
// effect carries every kind -- an aporte adds, a gasto and a recaudacion subtract and a correction
// reverses the row it answers -- so a window that both paid out and received is one number, the same one
// the acta, the book and the metrics card publish.
func TestDrawerExpectedIsTheOneRule(t *testing.T) {
	amount := func(text string) closings.Money { return closings.Money(text) }
	expect := func(opening, sales, effect string) closings.Signed {
		t.Helper()
		expected, err := closings.DrawerExpected(amount(opening), amount(sales), closings.Signed(effect))
		if err != nil {
			t.Fatalf("%s + %s + %s must be a drawer this rule states: %v", opening, sales, effect, err)
		}
		return expected
	}
	// The reproduced case: 100.00 inherited, 45.50 paid out and 30.00 received is 84.50 in the drawer --
	// not the 54.50 a rule that subtracted the net expense a second time would state.
	if got := expect("100.00", "0.00", "-15.50"); got != "84.50" {
		t.Fatalf("the drawer of the reproduced window is %s, want 84.50", got)
	}
	// Every kind enters through the one signed term, and a window of nothing is the fund it inherited.
	for _, tc := range []struct{ opening, sales, effect, want string }{
		{"100.00", "0.00", "0.00", "100.00"},
		{"0.00", "96000.00", "0.00", "96000.00"},
		{"100.00", "20.00", "-45.50", "74.50"},
		{"100.00", "0.00", "30.00", "130.00"},
		{"100.00", "0.00", "-20.00", "80.00"},
		// A correction of an aporte takes money back out of the drawer, and one of a gasto returns it.
		{"100.00", "0.00", "-10.00", "90.00"},
		{"100.00", "0.00", "10.00", "110.00"},
		// A window that spent more than it inherited is a shortage and states its sign.
		{"0.00", "0.00", "-15.50", "-15.50"},
	} {
		if got := expect(tc.opening, tc.sales, tc.effect); string(got) != tc.want {
			t.Fatalf("%s + %s + %s is %s, want %s", tc.opening, tc.sales, tc.effect, got, tc.want)
		}
	}
	// Every term is the canonical text the database stores: anything else is refused instead of
	// approximated, and so is an effect that is not a signed amount.
	for _, tc := range []struct{ opening, sales, effect string }{
		{"100.0", "0.00", "0.00"},
		{"-100.00", "0.00", "0.00"},
		{"100.00", "96.000", "0.00"},
		{"100.00", "0.00", ""},
		{"100.00", "0.00", "-15.5"},
	} {
		if _, err := closings.DrawerExpected(amount(tc.opening), amount(tc.sales),
			closings.Signed(tc.effect)); !errors.Is(err, closings.ErrInvalid) {
			t.Fatalf("%s + %s + %s must be refused", tc.opening, tc.sales, tc.effect)
		}
	}
	// ExpectedCash is the same rule for the degenerate window whose only rows are pay-outs, and it is the
	// only caller left of that narrower statement.
	if got, err := closings.ExpectedCash(amount("100.00"), amount("20.00"), amount("45.50")); err != nil ||
		got != "74.50" {
		t.Fatalf("the pay-out-only window must be the same rule: %s %v", got, err)
	}
}

// TestDrawerRefusalIsNamedOnEveryRoute pins S4 on the two writes of the book: the bound of the till is the
// same refusal whichever route records the movement. The expense route inserted on its own and mapped the
// database's code through the plain mapping, so the same fact answered the 503 of an unmapped code; both
// writers now share one mapping, and the refusal carries both quantities the operator acts on.
func TestDrawerRefusalIsNamedOnEveryRoute(t *testing.T) {
	e := fixture(t)
	// The till holds the 5.00 the two refusals below do not reach (S3).
	e.contribute(t, 2, "5.00", "Fondo de la caja operativa")
	before := e.scalar(t, `SELECT count(*) FROM branch_cash_movements`)

	for name, record := range map[string]func() error{
		"expense": func() error {
			_, err := e.store.RecordExpense(e.ctx, identity(2), money("10.00"), "Flete de la semana")
			return err
		},
		"movement": func() error {
			_, err := e.store.RecordCashMovement(e.ctx, identity(2), "gasto", money("10.00"),
				"Flete de la semana")
			return err
		},
	} {
		err := record()
		if errors.Is(err, closings.ErrUnavailable) {
			t.Fatalf("the %s route published the bound of the till as an outage: %v", name, err)
		}
		refused(t, err, closings.ErrStateConflict)
		var insufficient *closings.DrawerInsufficient
		if !errors.As(err, &insufficient) {
			t.Fatalf("the %s route must name the bound of the till: %v", name, err)
		}
		if insufficient.Balance != "5.00" || insufficient.Requested != "10.00" {
			t.Fatalf("the %s route must state the drawer and the request: %+v", name, insufficient)
		}
	}
	// A refused movement writes nothing at all, whichever route stated it.
	if after := e.scalar(t, `SELECT count(*) FROM branch_cash_movements`); after != before {
		t.Fatalf("a refused movement must write nothing: %d rows after %d", after, before)
	}
}

// TestDrawerRefusalOnAPreRuleNegativeDrawer pins S4 on a drawer the bound inherited already below zero: the
// movements an instance upgraded from 059 recorded before the rule existed are still there -- 060 rewrites
// no data -- so the balance the refusal states is a signed quantity. Read as a written amount it would fail,
// and the operator would read the bound as an invalid request with no numbers at all.
func TestDrawerRefusalOnAPreRuleNegativeDrawer(t *testing.T) {
	e := fixture(t)
	// The row of the pre-rule period, written the way 059 admitted it: the guard is disabled for the one
	// statement, so the drawer inherits -50.00 and no sale or settlement of the fixture feeds it.
	if _, err := e.pool.Exec(e.ctx,
		"ALTER TABLE branch_cash_movements DISABLE TRIGGER admit_branch_cash_movement"); err != nil {
		t.Fatalf("the guard could not be disabled for the pre-rule row: %v", err)
	}
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,created_by_account_id) VALUES(2,'gasto',50.00,'Gasto anterior a la regla',2)`); err != nil {
		t.Fatalf("the pre-rule expense could not be recorded: %v", err)
	}
	if _, err := e.pool.Exec(e.ctx,
		"ALTER TABLE branch_cash_movements ENABLE TRIGGER admit_branch_cash_movement"); err != nil {
		t.Fatalf("the guard could not be enabled again: %v", err)
	}
	if expected := e.text(t, "SELECT branch_drawer_expected(2::smallint)::text"); expected != "-50.00" {
		t.Fatalf("the pre-rule drawer must read the negative it holds, got %q", expected)
	}

	// The next pay-out is the bound's own refusal, named with the negative it found: an unreadable balance
	// would publish it as an invalid request instead (S4).
	_, err := e.store.RecordCashMovement(e.ctx, identity(2), "gasto", money("10.00"),
		"Detergente y escobas")
	if errors.Is(err, closings.ErrInvalid) || errors.Is(err, closings.ErrUnavailable) {
		t.Fatalf("a negative drawer is the bound's own refusal, never an invalid request: %v", err)
	}
	refused(t, err, closings.ErrStateConflict)
	var insufficient *closings.DrawerInsufficient
	if !errors.As(err, &insufficient) {
		t.Fatalf("the refusal must be named with the drawer it found: %v", err)
	}
	if insufficient.Balance != "-50.00" || insufficient.Requested != "10.00" {
		t.Fatalf("the refusal must state the signed balance and the request: %+v", insufficient)
	}
	// And the expense route states the same drawer the same way.
	_, err = e.store.RecordExpense(e.ctx, identity(2), money("10.00"), "Detergente y escobas")
	if !errors.As(err, &insufficient) || insufficient.Balance != "-50.00" {
		t.Fatalf("the expense route must name the same signed drawer: %v", err)
	}

	// Money in is never refused by this rule (S3): an aporte reconciles the drawer it inherited.
	if _, err := e.store.RecordCashMovement(e.ctx, identity(2), "aporte", money("30.00"),
		"Aporte para cubrir el faltante"); err != nil {
		t.Fatalf("an aporte on a negative drawer must be admitted (S3): %v", err)
	}
	if expected := e.text(t, "SELECT branch_drawer_expected(2::smallint)::text"); expected != "-20.00" {
		t.Fatalf("the aporte must reconcile the drawer to -20.00, got %q", expected)
	}
}
