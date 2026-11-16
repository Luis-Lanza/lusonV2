package closings

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

// The metrics read is a projection of one period of one branch, never a second calculation of
// it. A closed period publishes exactly what its closing froze; a live one publishes the same
// derivation the branch already reads in its workspace; and the whole history publishes only the
// numbers a history can honestly state. Everything a period already states is read from the
// closing document itself, so the two screens can never disagree about the same act.

// MetricsPeriod names the period a metrics read covers. A period is a settlement — closed or
// live — named by its closing, or the whole history of the branch: never a calendar month.
type MetricsPeriod struct {
	ClosingID *int64
	History   bool
}

// MetricsSales is the money and the volume of the period: the collection by payment method, the
// commission the branch earned, the number of sales that produced it and the batteries it sold.
// Cash is the drawer's money; card, transfer and QR never entered it.
type MetricsSales struct {
	Total      Money
	Cash       Money
	Card       Money
	Transfer   Money
	QR         Money
	Commission Money
	Sales      int64
	Units      int64
}

// MetricsCash is the operational drawer of the period: what it opened with, the cash the sales
// collected, the expenses paid out of it and the expectation they produce, with the counted
// amount and the difference when the branch counted. A count and a difference are null while the
// period is live, because a difference of zero would be a count nobody made.
type MetricsCash struct {
	Opening    Money
	Sales      Money
	Expenses   Money
	Expected   Signed
	Counted    *Money
	Difference *Signed
}

// MetricsFund is the purchase envelope: the amount it inherited, the cash it spent, and the
// expectation that follows. Replacement is the amount the warehouse left in it, which is the
// opening of the next period: the closure that states it is the one this period belongs to, so it
// is read from the document itself and is null while nobody declared it.
type MetricsFund struct {
	Opening     Money
	Purchases   Money
	Expected    Signed
	Counted     *Money
	Difference  *Signed
	Replacement *Money
}

// MetricsMaterial is one scrap material of the period, weighed in thousandths of a kilogram.
// Delivered is what the warehouse took, which is what it counted, and is null while the period
// is uncounted.
type MetricsMaterial struct {
	MaterialID int64
	Material   string
	Bought     int64
	Delivered  *int64
}

// MetricsMaterials is the third account of the period: batteries bought as used units and scrap
// bought by material, each with what was delivered to the warehouse. The delivered aggregates are
// null as a whole while any line is uncounted, so a half-counted sheet cannot read as delivered.
type MetricsMaterials struct {
	Used           int64
	UsedDelivered  *int64
	Scrap          int64
	ScrapDelivered *int64
	Materials      []MetricsMaterial
}

// MetricsModel is one battery model of the ranking, by units sold and with the money they made.
type MetricsModel struct {
	CatalogEntryID int64
	Brand          string
	Model          string
	Capacity       string
	Units          int64
	Money          Money
}

// MetricsStock is the shelf as it stands today: the units the branch has, whatever the period.
type MetricsStock struct{ Units int64 }

// MetricsMovement is one row of the branch's cash ledger after the cut of the last closed
// settlement: an expense the branch paid out of the drawer, a collection the warehouse took from it
// or a contribution the warehouse left in it. It carries its kind, its amount and its moment, and it
// is information the card states beside the expectation and never a term of it (S13, S14).
type MetricsMovement struct {
	Kind       string
	Amount     Money
	OccurredAt time.Time
}

// MetricsToday is the drawer of the branch as it stands today, stated whatever period the screen is
// showing and whether or not a settlement is open (S12). Since is the cut of the last closed
// settlement -- the instant its period ended, which is earlier than the moment it was closed -- and is
// null for a branch that never closed one, where the window is everything the branch ever did.
// Expected is the settlement's own identity, Opening + Sales − Expenses, so the card and the acta of
// the same drawer cannot state two different numbers.
type MetricsToday struct {
	Since     *time.Time
	Opening   Money
	Sales     Money
	Expenses  Money
	Expected  Signed
	Movements []MetricsMovement
}

// Metrics is the answer of one period of one branch. Source says where the numbers came from --
// a closed settlement, the live one, or the whole history -- so a reader always knows whether a
// number is frozen or moving. Cash, Fund and Materials are null for the history: a drawer is
// closed in each settlement and does not accumulate, so a history states no drawer at all. Today is
// never null: the drawer of the branch today exists whether or not the period on screen has one.
type Metrics struct {
	Source    string
	Sales     MetricsSales
	Cash      *MetricsCash
	Fund      *MetricsFund
	Materials *MetricsMaterials
	Top       []MetricsModel
	Stock     MetricsStock
	Today     MetricsToday
}

const (
	// metricsSourceSettlement is a period the warehouse and the branch signed: its numbers are
	// the ones the acta states and nothing here can move them.
	metricsSourceSettlement = "settlement"
	// metricsSourceLive is the period the branch is inside: its numbers are derived on read,
	// exactly like its own workspace derives them.
	metricsSourceLive = "live"
	// metricsSourceHistory is every sale the branch ever made, with no drawer to state.
	metricsSourceHistory = "history"
	// metricsTopModels is how many models the ranking publishes.
	metricsTopModels = 5
	// metricsTodayMovements is how many ledger rows the drawer of today lists: the newest ones are
	// kept, so a long history can never flood the answer.
	metricsTodayMovements = 50
	// The three kinds the ledger writes: the expense the branch paid out of the drawer, the
	// collection the warehouse took from it and the contribution the warehouse left in it.
	metricsMovementExpense      = "gasto"
	metricsMovementCollection   = "recaudacion"
	metricsMovementContribution = "aporte"
)

// Metrics reads one period of the actor's own branch. A branch account reads its branch and no
// other, exactly like its settlements and its purchases: the period is resolved against the
// history of that branch, so a closing of another one is an invalid request rather than an empty
// answer.
func (s *Store) Metrics(ctx context.Context, actor auth.Identity, period MetricsPeriod) (Metrics, error) {
	if !branchAccount(actor) {
		return Metrics{}, ErrForbidden
	}
	if period.History {
		if period.ClosingID != nil {
			return Metrics{}, ErrInvalid
		}
		return s.historyMetrics(ctx, int64(actor.Location.ID))
	}
	if period.ClosingID == nil || *period.ClosingID < 1 {
		return Metrics{}, ErrInvalid
	}
	closing, err := s.Read(ctx, actor, *period.ClosingID)
	if err != nil {
		return Metrics{}, err
	}
	return s.periodMetrics(ctx, closing)
}

// branchAccount admits only the completed account of a branch: the warehouse administrator owns
// no drawer, so it has no metrics of its own to read here.
func branchAccount(actor auth.Identity) bool {
	return actor.AccountID > 1 && actor.Location.ID > 1 && !actor.MustChangePassword
}

// periodMetrics projects one settlement, live or closed. Every money number it publishes is the
// closing's own, and only what the closing does not state -- how many sales, how many batteries,
// which models and what the shelf holds today -- is read here.
func (s *Store) periodMetrics(ctx context.Context, closing Closing) (Metrics, error) {
	source := metricsSourceLive
	if closing.Status == StatusClosed {
		source = metricsSourceSettlement
	}
	from, to := closing.PeriodStart, closing.CutAt
	sales, err := salesFacts(ctx, s.pool, closing.BranchID, &from, &to)
	if err != nil {
		return Metrics{}, err
	}
	sales.Total, sales.Cash = closing.SalesTotal, closing.CashSales
	sales.Card, sales.Transfer, sales.QR = closing.CardTotal, closing.TransferTotal, closing.QRTotal
	sales.Commission = closing.CommissionAmount
	if err := sales.valid(); err != nil {
		return Metrics{}, err
	}
	top, err := topModels(ctx, s.pool, closing.BranchID, &from, &to)
	if err != nil {
		return Metrics{}, err
	}
	stock, err := stockUnits(ctx, s.pool, closing.BranchID)
	if err != nil {
		return Metrics{}, err
	}
	materials, err := materialMetrics(closing.MaterialLines)
	if err != nil {
		return Metrics{}, err
	}
	fund := &MetricsFund{
		Opening:    closing.PurchaseFundOpening,
		Purchases:  closing.PurchasesCash,
		Expected:   closing.PurchaseFundExpected,
		Counted:    closing.PurchaseFundCounted,
		Difference: closing.PurchaseFundDifference,
		// The amount the warehouse leaves in the envelope is the column its closure froze, which
		// is exactly the opening the next period inherits. It is null while the warehouse has not
		// stated it, because a replacement nobody declared is not a zero.
		Replacement: closing.PurchaseFundCash,
	}
	today, err := todayMetrics(ctx, s.pool, closing.BranchID)
	if err != nil {
		return Metrics{}, err
	}
	return Metrics{
		Source: source,
		Sales:  sales,
		Cash: &MetricsCash{
			Opening:    closing.OpeningCash,
			Sales:      closing.CashSales,
			Expenses:   closing.CashExpenses,
			Expected:   closing.ExpectedCash,
			Counted:    closing.CountedCash,
			Difference: closing.CashDifference,
		},
		Fund:      fund,
		Materials: materials,
		Top:       top,
		Stock:     stock,
		Today:     today,
	}, nil
}

// historyMetrics reads every sale of the branch, with the commission the closed settlements
// earned. It states no drawer, no envelope and no material: those are closed one settlement at a
// time and a sum of them would be a number nobody can act on.
//
// The five readings are one act or they are five different histories: a sale the ranking counts and
// the money does not would publish a ranking whose units exceed the units the same answer sold. They
// are therefore read inside one read-only repeatable snapshot, so the ranking, the money, the count,
// the shelf and the drawer of today describe one instant, whatever the branch writes meanwhile.
func (s *Store) historyMetrics(ctx context.Context, branch int64) (Metrics, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Metrics{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	sales, err := salesFacts(ctx, tx, branch, nil, nil)
	if err != nil {
		return Metrics{}, err
	}
	commission, err := closedCommission(ctx, tx, branch)
	if err != nil {
		return Metrics{}, err
	}
	sales.Commission = commission
	if err := sales.valid(); err != nil {
		return Metrics{}, err
	}
	top, err := topModels(ctx, tx, branch, nil, nil)
	if err != nil {
		return Metrics{}, err
	}
	stock, err := stockUnits(ctx, tx, branch)
	if err != nil {
		return Metrics{}, err
	}
	today, err := todayMetrics(ctx, tx, branch)
	if err != nil {
		return Metrics{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Metrics{}, fail(ctx)
	}
	return Metrics{Source: metricsSourceHistory, Sales: sales, Top: top, Stock: stock, Today: today},
		nil
}

// valid admits the money and the volume of a period as facts: a negative amount is not a
// collection, and a negative count is not a sale.
func (m MetricsSales) valid() error {
	for _, amount := range []Money{m.Total, m.Cash, m.Card, m.Transfer, m.QR, m.Commission} {
		if _, ok := amountCents(amount); !ok {
			return ErrUnavailable
		}
	}
	if m.Sales < 0 || m.Units < 0 {
		return ErrUnavailable
	}
	return nil
}

// salesFacts reads the volume of a period from the immutable sales themselves: how many there
// were, what they collected by method and how many batteries they took off the shelf. A nil
// window is the whole history. The money of a settlement is not read here -- the closing states
// it -- but the history has no closing to read, so the same statement answers for it.
func salesFacts(ctx context.Context, q querier, branch int64, from, to *time.Time) (MetricsSales, error) {
	where, args := windowOf(branch, from, to)
	var total, cash, card, transfer, qr string
	var sales, units int64
	err := q.QueryRow(ctx, `SELECT
 coalesce((SELECT sum(line.subtotal) FROM sale_lines line JOIN sales sale ON sale.id=line.sale_id
        WHERE `+where+`),0)::numeric(12,2)::text,
 coalesce((SELECT sum(sale.cash_amount) FROM sales sale WHERE `+where+`),0)::numeric(12,2)::text,
 coalesce((SELECT sum(sale.card_amount) FROM sales sale WHERE `+where+`),0)::numeric(12,2)::text,
 coalesce((SELECT sum(sale.transfer_amount) FROM sales sale WHERE `+where+`),0)::numeric(12,2)::text,
 coalesce((SELECT sum(sale.qr_amount) FROM sales sale WHERE `+where+`),0)::numeric(12,2)::text,
 (SELECT count(*) FROM sales sale WHERE `+where+`),
 coalesce((SELECT sum(line.quantity) FROM sale_lines line JOIN sales sale ON sale.id=line.sale_id
        WHERE `+where+`),0)`, args...).Scan(&total, &cash, &card, &transfer, &qr, &sales, &units)
	if err != nil {
		return MetricsSales{}, fail(ctx)
	}
	read := MetricsSales{Total: Money(total), Cash: Money(cash), Card: Money(card),
		Transfer: Money(transfer), QR: Money(qr), Sales: sales, Units: units}
	for _, amount := range []Money{read.Total, read.Cash, read.Card, read.Transfer, read.QR} {
		if _, ok := amountCents(amount); !ok {
			return MetricsSales{}, ErrUnavailable
		}
	}
	if read.Sales < 0 || read.Units < 0 {
		return MetricsSales{}, ErrUnavailable
	}
	return read, nil
}

// topModels ranks the models of a period by the units they sold, newest ties broken by the
// catalogue's own order so the same period always publishes the same five rows. Money is the
// secondary reading of the same rows.
func topModels(ctx context.Context, q querier, branch int64, from, to *time.Time) ([]MetricsModel, error) {
	where, args := windowOf(branch, from, to)
	rows, err := q.Query(ctx, `SELECT entry.id, entry.brand, entry.model,
       trim(trailing '.' from trim(trailing '0' from entry.capacity_ah::text)),
       sum(line.quantity), sum(line.subtotal)::numeric(12,2)::text
 FROM sale_lines line
 JOIN sales sale ON sale.id=line.sale_id
 JOIN catalog_variants variant ON variant.id=line.variant_id
 JOIN catalog_entries entry ON entry.id=variant.catalog_entry_id
 WHERE `+where+`
 GROUP BY entry.id, entry.brand, entry.model, entry.capacity_ah
 ORDER BY sum(line.quantity) DESC, entry.brand COLLATE "C", entry.model COLLATE "C",
          entry.capacity_ah, entry.id
 LIMIT `+strconv.Itoa(metricsTopModels), args...)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	top := make([]MetricsModel, 0, metricsTopModels)
	for rows.Next() {
		var model MetricsModel
		var capacity, money string
		var units int64
		if rows.Scan(&model.CatalogEntryID, &model.Brand, &model.Model, &capacity, &units, &money) != nil {
			return nil, fail(ctx)
		}
		// A ranking of a period that sold nothing is not a ranking of zero rows: the statement
		// groups existing sales, so a row with no units or no canonical capacity is a shape this
		// domain never wrote.
		if model.CatalogEntryID < 1 || model.Brand == "" || model.Model == "" ||
			!capacityPattern.MatchString(capacity) || units < 1 {
			return nil, ErrUnavailable
		}
		amount := Money(money)
		if _, ok := amountCents(amount); !ok {
			return nil, ErrUnavailable
		}
		model.Capacity, model.Units, model.Money = capacity, units, amount
		top = append(top, model)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return top, nil
}

// stockUnits reads the shelf of the branch as it stands today: what the balances say it has.
func stockUnits(ctx context.Context, q querier, branch int64) (MetricsStock, error) {
	var units int64
	if err := q.QueryRow(ctx, `SELECT coalesce(sum(existing),0) FROM inventory_balances
 WHERE location_id=$1`, branch).Scan(&units); err != nil {
		return MetricsStock{}, fail(ctx)
	}
	if units < 0 {
		return MetricsStock{}, ErrUnavailable
	}
	return MetricsStock{Units: units}, nil
}

// todayMetrics reads the drawer of the branch as it stands today, whatever period the screen is
// showing and whether or not a settlement is open (S12): what the last closed settlement left in the
// drawer, the cash the sales collected after that cut, the expenses paid out of it after the same
// cut, and the expectation the three produce. That is the settlement's own identity -- the opening a
// closure seeds from the previous `closing_cash`, plus the cash of the window minus its expenses --
// so the card and the acta can never state two different drawers. The ledger rows of the window are
// listed beside it and never enter that sum (S13, S14).
//
// The window starts at the cut and not at the closure: the period of a closed settlement ends at its
// cut, so a sale or an expense the branch records between the cut and the closure of that settlement
// belongs to no settlement at all, and a window that began at the closure would leave it in nobody's
// account. The opening is still that row's `closing_cash`, the amount the next period inherits.
func todayMetrics(ctx context.Context, q querier, branch int64) (MetricsToday, error) {
	var stored string
	var cut time.Time
	today := MetricsToday{Opening: Money("0.00"), Movements: make([]MetricsMovement, 0, 8)}
	// The cut of the last closed settlement and the cash it left behind are one row of one branch:
	// the same row the opener of the next settlement inherits its opening from.
	err := q.QueryRow(ctx, `SELECT closing_cash::text,cut_at FROM branch_closings
 WHERE branch_location_id=$1 AND status='closed'
 ORDER BY cut_at DESC,id DESC LIMIT 1`, int16(branch)).Scan(&stored, &cut)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// A branch that never closed a settlement states no cut and starts at zero: the window is
		// everything it ever did, and a nil Since is that state instead of a zero instant.
	case err != nil:
		return MetricsToday{}, fail(ctx)
	default:
		opening := Money(stored)
		if _, ok := amountCents(opening); !ok || cut.IsZero() {
			return MetricsToday{}, ErrUnavailable
		}
		today.Opening, today.Since = opening, &cut
	}
	var sales, expenses string
	if err := q.QueryRow(ctx, `SELECT
 coalesce((SELECT sum(sale.cash_amount) FROM sales sale
        WHERE sale.branch_location_id=$1
          AND ($2::timestamptz IS NULL OR sale.created_at >= $2)),0)::numeric(12,2)::text,
 coalesce((SELECT sum(expense.amount) FROM branch_cash_movements expense
        WHERE expense.branch_location_id=$1 AND expense.kind='`+metricsMovementExpense+`'
          AND ($2::timestamptz IS NULL OR expense.occurred_at >= $2)),0)::numeric(12,2)::text`,
		int16(branch), today.Since).Scan(&sales, &expenses); err != nil {
		return MetricsToday{}, fail(ctx)
	}
	today.Sales, today.Expenses = Money(sales), Money(expenses)
	// The three terms are amounts the branch holds or spent, never a signed reading: anything else
	// is a persisted state this answer could not have been produced from.
	for _, amount := range []Money{today.Opening, today.Sales, today.Expenses} {
		if _, ok := amountCents(amount); !ok {
			return MetricsToday{}, ErrUnavailable
		}
	}
	expected, err := ExpectedCash(today.Opening, today.Sales, today.Expenses)
	if err != nil {
		return MetricsToday{}, ErrUnavailable
	}
	today.Expected = expected
	// The list is read newest first so the bound keeps the newest rows of a long history, and it is
	// published oldest first because a ledger is read in the order it happened.
	rows, err := q.Query(ctx, `SELECT kind,amount::text,occurred_at FROM branch_cash_movements
 WHERE branch_location_id=$1 AND ($2::timestamptz IS NULL OR occurred_at >= $2)
 ORDER BY occurred_at DESC,id DESC LIMIT `+strconv.Itoa(metricsTodayMovements),
		int16(branch), today.Since)
	if err != nil {
		return MetricsToday{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var movement MetricsMovement
		var stored string
		if rows.Scan(&movement.Kind, &stored, &movement.OccurredAt) != nil {
			return MetricsToday{}, fail(ctx)
		}
		amount := Money(stored)
		// A movement exists because money moved: the ledger writes a positive amount of one of its
		// three kinds at one real instant, and anything else is a shape it never wrote.
		if cents, ok := amountCents(amount); !ok || cents < 1 ||
			!metricsMovementKind(movement.Kind) || movement.OccurredAt.IsZero() {
			return MetricsToday{}, ErrUnavailable
		}
		movement.Amount = amount
		today.Movements = append(today.Movements, movement)
	}
	if rows.Err() != nil {
		return MetricsToday{}, fail(ctx)
	}
	for left, right := 0, len(today.Movements)-1; left < right; left, right = left+1, right-1 {
		today.Movements[left], today.Movements[right] = today.Movements[right], today.Movements[left]
	}
	return today, nil
}

// metricsMovementKind admits the three kinds the ledger writes. Nothing else is a movement of the
// drawer, so nothing else is listed as one.
func metricsMovementKind(kind string) bool {
	return kind == metricsMovementExpense || kind == metricsMovementCollection ||
		kind == metricsMovementContribution
}

// closedCommission sums the commission the branch earned in the settlements it closed. A live
// one states its own commission in its document, but it has not been signed yet, so a history of
// what the branch earned counts only the closed ones.
func closedCommission(ctx context.Context, q querier, branch int64) (Money, error) {
	var total string
	if err := q.QueryRow(ctx, `SELECT coalesce(sum(commission_amount),0)::numeric(12,2)::text
 FROM branch_closings WHERE branch_location_id=$1 AND status='closed'`, branch).Scan(&total); err != nil {
		return "", fail(ctx)
	}
	amount := Money(total)
	if _, ok := amountCents(amount); !ok {
		return "", ErrUnavailable
	}
	return amount, nil
}

// windowOf builds the branch predicate of a read, with its window when the period has one. The
// window is half-open -- [period_start, cut_at) -- exactly like the settlement it comes from, so
// a sale made at the cut belongs to the next period and never to both.
func windowOf(branch int64, from, to *time.Time) (string, []any) {
	if from == nil || to == nil {
		return "sale.branch_location_id=$1", []any{branch}
	}
	return "sale.branch_location_id=$1 AND sale.created_at >= $2 AND sale.created_at < $3",
		[]any{branch, *from, *to}
}

// materialMetrics folds the material sheet of one period into its three readings: the used units,
// the kilograms of scrap by material, and what the warehouse took of each. A sheet with any
// uncounted line states no delivery at all, because a partial sum of a count would read as a
// count that happened for everything.
func materialMetrics(lines []MaterialLine) (*MetricsMaterials, error) {
	if lines == nil {
		return nil, nil
	}
	materials := &MetricsMaterials{Materials: make([]MetricsMaterial, 0, len(lines))}
	scrap := make([]MetricsMaterial, 0, 4)
	delivered := true
	usedDelivered, scrapDelivered := int64(0), int64(0)
	for _, line := range lines {
		milli, ok := quantityMilli(line.Expected)
		if !ok {
			return nil, ErrUnavailable
		}
		var taken int64
		if line.Delivered == nil {
			delivered = false
		} else if count, ok := quantityMilli(*line.Delivered); ok {
			taken = count
		} else {
			return nil, ErrUnavailable
		}
		switch line.Kind {
		case MaterialKindUsed:
			// A fraction of a battery is not a battery: the sheet stores whole units only.
			if milli%1000 != 0 || taken%1000 != 0 {
				return nil, ErrUnavailable
			}
			materials.Used += milli / 1000
			usedDelivered += taken / 1000
		case MaterialKindScrap:
			if line.MaterialID == nil || *line.MaterialID < 1 || line.Material == nil || *line.Material == "" {
				return nil, ErrUnavailable
			}
			materials.Scrap += milli
			scrapDelivered += taken
			found := false
			for index := range scrap {
				if scrap[index].MaterialID == *line.MaterialID {
					scrap[index].Bought += milli
					if scrap[index].Delivered != nil {
						sum := *scrap[index].Delivered + taken
						scrap[index].Delivered = &sum
					}
					found = true
					break
				}
			}
			if !found {
				sum := taken
				scrap = append(scrap, MetricsMaterial{MaterialID: *line.MaterialID,
					Material: *line.Material, Bought: milli, Delivered: &sum})
			}
		default:
			return nil, ErrUnavailable
		}
	}
	materials.Materials = scrap
	if delivered {
		materials.UsedDelivered = &usedDelivered
		materials.ScrapDelivered = &scrapDelivered
	} else {
		for index := range materials.Materials {
			materials.Materials[index].Delivered = nil
		}
	}
	return materials, nil
}

// capacityPattern admits the rendered capacity of a model: the whole or fractional ampere-hours
// the catalogue stores, without a padded fraction, a sign or a trailing zero.
var capacityPattern = regexp.MustCompile(`^\d{1,9}(\.\d{1,6})?$`)
