package closings

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
	"luson/api/internal/catalog"
)

// The metrics read is a projection of one period of one branch, never a second calculation of
// it. A closed period publishes exactly what its closing froze; a live one publishes the same
// derivation the branch already reads in its workspace; and the whole history publishes only the
// numbers a history can honestly state. Everything a period already states is read from the
// closing document itself, so the two screens can never disagree about the same act.

// MetricsPeriod names the period a metrics read covers. A period is a settlement — closed or
// live — named by its closing, the whole history of the branch, or the computed window from the cut
// of its last closed settlement to the instant of the read: never a calendar month.
type MetricsPeriod struct {
	ClosingID *int64
	History   bool
	// Window is the computed period the selector publishes as «Desde el último corte» (S3): from the
	// cut of the last closed settlement of the branch to the moment of the read. It names no document
	// — reading it creates, opens and proposes nothing — and it is not a settlement, so it can never
	// be combined with one.
	Window bool
}

// MetricsSales is the money and the volume of the period: the collection by payment method, the
// commission the branch earned, the number of sales that produced it and the batteries it sold.
// Cash is the drawer's money; card, transfer and QR never entered it.
type MetricsSales struct {
	Total Money
	// Batteries is the part of Total the period sold as batteries: the subtotal of the sale lines whose
	// catalogue entry is of the battery kind, over the same window as Total. It is read from the sales
	// themselves -- joined through the line's variant to its catalogue entry -- and never from the acta,
	// so a closed settlement publishes the battery share of its own immutable stretch beside the money its
	// acta froze, and the client states the rest as other products. It is never greater than Total (S2, S3).
	Batteries  Money
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

// MetricsModel is one product of the ranking -- of either catalogue kind -- by the units it sold and
// with the money they made. A battery states the battery identity it always published: its brand, its
// model and its canonical capacity. An other product states its free name and no capacity at all,
// because it never had one: a number nobody stored is a number this read cannot publish (S6).
type MetricsModel struct {
	CatalogEntryID int64
	Kind           catalog.Kind
	Brand          string
	Model          string
	Capacity       string
	Name           string
	Units          int64
	Money          Money
}

// MetricsStock is the shelf as it stands today: the units the branch has, whatever the period.
type MetricsStock struct{ Units int64 }

// MetricsMovement is one row of the branch's cash ledger after the cut of the last closed
// settlement: an expense the branch paid out of the drawer, a collection it gave up, a contribution it
// received or the correction that answers one of them. It carries its kind, its amount, the effect
// signed the way the drawer moves -- positive into it and negative out of it -- and its moment. The
// signed effect is the very number the expectation of the window sums (S4, S13), so the card can state
// a correction as money coming back instead of as a second expense.
type MetricsMovement struct {
	Kind string
	// Amount is what the row states, always positive: the ledger never stores a sign.
	Amount Money
	// Effective is the signed effect of the row, positive into the drawer and negative out of it. A
	// correction carries the opposite direction of the movement it answers (S6, S13).
	Effective  Signed
	OccurredAt time.Time
}

// MetricsToday is the drawer of the branch as it stands today, stated whatever period the screen is
// showing and whether or not a settlement is open (S12). Since is the cut of the last closed
// settlement -- the instant its period ended, which is earlier than the moment it was closed -- and is
// null for a branch that never closed one, where the window is everything the branch ever did.
//
// Expenses is the NET expense of the window and Effective is the signed effect of every movement the
// branch wrote in it that belongs to no settlement (S4, S13). Expected is the drawer's own identity
// over those terms, Opening + Sales + Effective, which is why an aporte raises it and a recaudación or
// a gasto lower it: the card, the acta and the book of the same drawer cannot state two numbers.
type MetricsToday struct {
	Since    *time.Time
	Opening  Money
	Sales    Money
	Expenses Money
	// Effective is the signed sum of the movements of the window that belong to no settlement, which
	// is the same aggregate the book of the drawer publishes (S4, S13).
	Effective Signed
	Expected  Signed
	// Rate is the commission the warehouse configured for this branch, or nil when it never gave it
	// one: a rate that does not exist is stated as its absence and never as a zero percentage (S20).
	Rate *Percent
	// Sold is the total the branch sold since that cut -- every sale of the window, batteries and other
	// products alike -- and CommissionBase is the part of it the commission is paid on: the subtotal of
	// the lines whose catalogue entry is a battery (S1, S2, S4). "la comision debe ser solamente de la
	// venta de baterias, la venta de 'otros productos' como agua acidulada no cuentan para la comision"
	// (S1). Commission is that rate times that base rounded once -- the settlement's own rule (S18).
	// None of the three is money in a box: the commission is settled when the settlement is proposed
	// and until then it is what the branch is earning, not what it holds (S19).
	Sold           Money
	CommissionBase Money
	Commission     Money
	Movements      []MetricsMovement
}

// MetricsFundToday is the purchase envelope of the branch as it stands today, stated whatever period
// the screen is showing and whether or not a settlement is open (S15). It is the second money box of
// the branch and it is not the drawer. Balance is the book's own sum -- sum(effective) of
// `purchase_fund_ledger` over the whole history of the branch (S5) -- which is the same arithmetic the
// purchases' tope and the acta read, so a branch that never closed a settlement publishes the fund it
// was founded with instead of zero. Since is the cut of the last closed settlement -- the same instant
// the drawer of today starts from -- and is null for a branch that never closed one.
//
// Effective is the signed effect of the movements of that window that belong to no settlement: the term
// the card states beside the opening, because the balance is opening + effective and never opening minus
// the cash of the purchases. An `aporte`, a `reposicion` or a correction also moves the book, and the
// cash a purchase document paid is one of the movements of the window rather than its only term.
// Purchases is the cash of the window's purchase documents, net of their counter-documents, and it is
// the volume those documents paid, not a term of the balance. Balance keeps the signed shape of the
// fund's arithmetic even though the book refuses a negative one (S6): the card publishes what the book
// holds, not a number clamped to zero. Documents, UsedUnits and ScrapMilli are the volume of that same
// window, netted the way every read of the purchases package nets it -- the counter-document is stored
// negative, so it subtracts by construction.
type MetricsFundToday struct {
	Since      *time.Time
	Opening    Money
	Purchases  Signed
	Effective  Signed
	Balance    Signed
	Documents  int64
	UsedUnits  int64
	ScrapMilli int64
}

// Metrics is the answer of one period of one branch. Source says where the numbers came from --
// a closed settlement, the live one, or the whole history -- so a reader always knows whether a
// number is frozen or moving. Cash, Fund and Materials are null for the history: a drawer is
// closed in each settlement and does not accumulate, so a history states no drawer at all. Today is
// never null: the drawer of the branch today exists whether or not the period on screen has one, and
// neither is FundToday, the second money box, which a branch without an open settlement has no other
// screen to read (S15).
type Metrics struct {
	Source    string
	Sales     MetricsSales
	Cash      *MetricsCash
	Fund      *MetricsFund
	Materials *MetricsMaterials
	Top       []MetricsModel
	Stock     MetricsStock
	Today     MetricsToday
	FundToday MetricsFundToday
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
		if period.ClosingID != nil || period.Window {
			return Metrics{}, ErrInvalid
		}
		return s.historyMetrics(ctx, int64(actor.Location.ID))
	}
	if period.Window {
		// The computed window is a stretch of time of the branch and never a document: a closing id
		// beside it would be two periods in one request, which this read does not answer.
		if period.ClosingID != nil {
			return Metrics{}, ErrInvalid
		}
		return s.windowMetrics(ctx, int64(actor.Location.ID))
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
		// The amount the warehouse leaves in the envelope is the one its closure settled: the signed sum
		// of the fund's book at that instant (S5, S9), which is also the opening the next period
		// inherits. A closure that stated no amount publishes the book's balance, because an unstated
		// fund is zero and not unknown (S7).
		Replacement: closing.PurchaseFundCash,
	}
	today, err := todayMetrics(ctx, s.pool, closing.BranchID)
	if err != nil {
		return Metrics{}, err
	}
	fundToday, err := fundTodayMetrics(ctx, s.pool, closing.BranchID)
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
		FundToday: fundToday,
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
	fundToday, err := fundTodayMetrics(ctx, tx, branch)
	if err != nil {
		return Metrics{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Metrics{}, fail(ctx)
	}
	return Metrics{Source: metricsSourceHistory, Sales: sales, Top: top, Stock: stock, Today: today,
		FundToday: fundToday}, nil
}

// windowMetrics reads the computed period of the branch: from the cut of its last closed settlement to
// the instant of the read (S3). Reading it creates, opens and proposes nothing — a live settlement is a
// document of its own and this read never touches it — and it states no drawer, no envelope and no
// material, because a window has no acta to freeze them (S5). The money, the ranking, the shelf and the
// two boxes of today are read inside one read-only repeatable snapshot, so the window and the drawer of
// today describe one instant and the answer cannot contradict itself (S6).
func (s *Store) windowMetrics(ctx context.Context, branch int64) (Metrics, error) {
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
	// The window starts at the cut of the last closed settlement, which is the instant the drawer and
	// the envelope of today start from: the same reader resolves it, so the three of them name one
	// instant and never three.
	today, err := todayMetrics(ctx, tx, branch)
	if err != nil {
		return Metrics{}, err
	}
	if today.Since == nil {
		// A branch that never closed a settlement has no cut to start from: the window is not a period
		// it has (S7).
		return Metrics{}, ErrNotFound
	}
	from := *today.Since
	sales, err := salesFacts(ctx, tx, branch, &from, nil)
	if err != nil {
		return Metrics{}, err
	}
	// The commission of the window is the one the branch is earning over it -- the rate it was
	// configured times the total it sold, rounded once by the settlement's own rule -- and never a
	// second arithmetic of the same money (S5, S18).
	sales.Commission = today.Commission
	if err := sales.valid(); err != nil {
		return Metrics{}, err
	}
	// S6: the money of the window and the total the same answer says the branch sold since that cut
	// are one reading of one window, so they agree or this read answers nothing.
	if sales.Total != today.Sold {
		return Metrics{}, ErrUnavailable
	}
	top, err := topModels(ctx, tx, branch, &from, nil)
	if err != nil {
		return Metrics{}, err
	}
	stock, err := stockUnits(ctx, tx, branch)
	if err != nil {
		return Metrics{}, err
	}
	fundToday, err := fundTodayMetrics(ctx, tx, branch)
	if err != nil {
		return Metrics{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Metrics{}, fail(ctx)
	}
	// A window has no acta, so no drawer, no envelope and no material sheet are stated: the three are
	// null here instead of a zero somebody never counted (S5).
	return Metrics{Source: metricsSourceLive, Sales: sales, Top: top, Stock: stock, Today: today,
		FundToday: fundToday}, nil
}

// valid admits the money and the volume of a period as facts: a negative amount is not a
// collection, and a negative count is not a sale.
func (m MetricsSales) valid() error {
	for _, amount := range []Money{m.Total, m.Batteries, m.Cash, m.Card, m.Transfer, m.QR,
		m.Commission} {
		if _, ok := amountCents(amount); !ok {
			return ErrUnavailable
		}
	}
	if m.Sales < 0 || m.Units < 0 {
		return ErrUnavailable
	}
	// The battery share is a part of the period and never a second total: a share above the total is a
	// number the two readers of one period -- the sale lines and the acta -- could not have produced (S3).
	total, _ := amountCents(m.Total)
	batteries, _ := amountCents(m.Batteries)
	if batteries > total {
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
	var total, batteries, cash, card, transfer, qr string
	var sales, units int64
	err := q.QueryRow(ctx, `SELECT
 coalesce((SELECT sum(line.subtotal) FROM sale_lines line JOIN sales sale ON sale.id=line.sale_id
        WHERE `+where+`),0)::numeric(12,2)::text,
 coalesce((SELECT sum(line.subtotal) FROM sale_lines line JOIN sales sale ON sale.id=line.sale_id
        JOIN catalog_variants variant ON variant.id=line.variant_id
        JOIN catalog_entries entry ON entry.id=variant.catalog_entry_id
        WHERE `+where+` AND entry.kind='battery'),0)::numeric(12,2)::text,
 coalesce((SELECT sum(sale.cash_amount) FROM sales sale WHERE `+where+`),0)::numeric(12,2)::text,
 coalesce((SELECT sum(sale.card_amount) FROM sales sale WHERE `+where+`),0)::numeric(12,2)::text,
 coalesce((SELECT sum(sale.transfer_amount) FROM sales sale WHERE `+where+`),0)::numeric(12,2)::text,
 coalesce((SELECT sum(sale.qr_amount) FROM sales sale WHERE `+where+`),0)::numeric(12,2)::text,
 (SELECT count(*) FROM sales sale WHERE `+where+`),
 coalesce((SELECT sum(line.quantity) FROM sale_lines line JOIN sales sale ON sale.id=line.sale_id
        WHERE `+where+`),0)`, args...).Scan(&total, &batteries, &cash, &card, &transfer, &qr,
		&sales, &units)
	if err != nil {
		return MetricsSales{}, fail(ctx)
	}
	read := MetricsSales{Total: Money(total), Batteries: Money(batteries), Cash: Money(cash),
		Card: Money(card), Transfer: Money(transfer), QR: Money(qr), Sales: sales, Units: units}
	for _, amount := range []Money{read.Total, read.Batteries, read.Cash, read.Card, read.Transfer,
		read.QR} {
		if _, ok := amountCents(amount); !ok {
			return MetricsSales{}, ErrUnavailable
		}
	}
	if read.Sales < 0 || read.Units < 0 {
		return MetricsSales{}, ErrUnavailable
	}
	return read, nil
}

// topModels ranks the products of a period by the units they sold, newest ties broken by the
// catalogue's own order so the same period always publishes the same five rows. Money is the
// secondary reading of the same rows. Both catalogue kinds are ranked: a period that sold an other
// product publishes it instead of failing the whole read (S6).
func topModels(ctx context.Context, q querier, branch int64, from, to *time.Time) ([]MetricsModel, error) {
	where, args := windowOf(branch, from, to)
	// The entry's own kind is selected beside its battery shape, and every column of the other kind is
	// coalesced because a product stores none of them: the shape of each row is decided by its kind
	// below, never by the NULL of a column it does not have.
	rows, err := q.Query(ctx, `SELECT entry.id, entry.kind,
       coalesce(entry.brand,''), coalesce(entry.model,''),
       coalesce(trim(trailing '.' from trim(trailing '0' from entry.capacity_ah::text)),''),
       coalesce(entry.name,''),
       sum(line.quantity), sum(line.subtotal)::numeric(12,2)::text
 FROM sale_lines line
 JOIN sales sale ON sale.id=line.sale_id
 JOIN catalog_variants variant ON variant.id=line.variant_id
 JOIN catalog_entries entry ON entry.id=variant.catalog_entry_id
 WHERE `+where+`
 GROUP BY entry.id, entry.kind, entry.brand, entry.model, entry.capacity_ah, entry.name
 ORDER BY sum(line.quantity) DESC, entry.brand COLLATE "C", entry.model COLLATE "C",
          entry.capacity_ah, entry.name COLLATE "C", entry.id
 LIMIT `+strconv.Itoa(metricsTopModels), args...)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	top := make([]MetricsModel, 0, metricsTopModels)
	for rows.Next() {
		var model MetricsModel
		var kind, capacity, name, money string
		var units int64
		if rows.Scan(&model.CatalogEntryID, &kind, &model.Brand, &model.Model, &capacity, &name,
			&units, &money) != nil {
			return nil, fail(ctx)
		}
		// A ranking of a period that sold nothing is not a ranking of zero rows: the statement groups
		// existing sales, so a row with no units or no money this domain could have written is a shape
		// it never wrote. Each kind is then judged against its own shape and against the absence of the
		// other's: a battery still needs its brand, its model and a canonical capacity -- an empty brand
		// or an unparseable capacity is refused exactly as before -- and a product states its name and
		// nothing of the battery shape (S6).
		if model.CatalogEntryID < 1 || units < 1 {
			return nil, ErrUnavailable
		}
		model.Kind, model.Units = catalog.Kind(kind), units
		switch model.Kind {
		case catalog.BatteryKind:
			if model.Brand == "" || model.Model == "" || name != "" ||
				!capacityPattern.MatchString(capacity) {
				return nil, ErrUnavailable
			}
			model.Capacity = capacity
		case catalog.OtherKind:
			if name == "" || model.Brand != "" || model.Model != "" || capacity != "" {
				return nil, ErrUnavailable
			}
			model.Name = name
		default:
			return nil, ErrUnavailable
		}
		amount := Money(money)
		if _, ok := amountCents(amount); !ok {
			return nil, ErrUnavailable
		}
		model.Money = amount
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
// drawer, the cash the sales collected after that cut, the net expense paid out of it after the same
// cut and the expectation those terms produce. The expectation is the drawer's own identity over the
// signed effect of every movement of the window -- opening + cash sales + that effect (S4) -- which is
// the very arithmetic the book of the same drawer states, so the card and the book can never publish
// two numbers for one fact (S13). The expense is the net of the window's `gasto` rows, exactly as the
// acta of a settled period states it, and the transfer rows of a settlement are excluded on both
// sides because the acta already states them (S5).
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
	// The cash that reached the drawer, the NET expense paid out of it, the signed effect of every
	// movement of the window that belongs to no settlement, the total the branch sold and the part of it
	// that earns a commission: the fourth is not a term of the drawer -- a card sale never enters it --
	// and the fifth is not a collection either, because a commission is settled when the settlement is
	// proposed. Both are read over the same predicate as the others so they describe one window and not
	// five (S4, S18).
	//
	// The total counts every sale of the window, of either catalogue kind, which is the money the card
	// states; the base counts only the lines whose entry is a battery, so a period that sold an other
	// product -- agua acidulada, say -- earns no commission on it (S1, S2). Only the base is narrowed:
	// every other reading of this window stays the sum of every sale (S4).
	//
	// The expenses and the effect are read from `branch_cash_ledger`, exactly as `periodTotals` reads
	// them (S4, S13): the view states one signed effect per row, so the expense of the window is
	// `-sum(effective)` over the rows whose effect is a `gasto` -- a correction of a gasto lowers it --
	// and the effect of the window is the same sum over every row of the branch's own period. The
	// transfer rows a settlement writes are excluded by `closing_id IS NULL`: they are the acta's own
	// facts, already stated by its `contributed_cash` and `taken_cash`, and counting them here as well
	// would count the same money twice (S5).
	var sales, expenses, effective, sold, base string
	if err := q.QueryRow(ctx, `SELECT
 coalesce((SELECT sum(sale.cash_amount) FROM sales sale
        WHERE sale.branch_location_id=$1
          AND ($2::timestamptz IS NULL OR sale.created_at >= $2)),0)::numeric(12,2)::text,
 coalesce(-(SELECT sum(ledger.effective) FROM branch_cash_ledger ledger
        WHERE ledger.branch_location_id=$1 AND ledger.effect_kind='`+metricsMovementExpense+`'
          AND ledger.closing_id IS NULL
          AND ($2::timestamptz IS NULL OR ledger.occurred_at >= $2)),0)::numeric(12,2)::text,
 coalesce((SELECT sum(ledger.effective) FROM branch_cash_ledger ledger
        WHERE ledger.branch_location_id=$1 AND ledger.closing_id IS NULL
          AND ($2::timestamptz IS NULL OR ledger.occurred_at >= $2)),0)::numeric(12,2)::text,
 coalesce((SELECT sum(line.subtotal) FROM sale_lines line JOIN sales sale ON sale.id=line.sale_id
        WHERE sale.branch_location_id=$1
          AND ($2::timestamptz IS NULL OR sale.created_at >= $2)),0)::numeric(12,2)::text,
 coalesce((SELECT sum(line.subtotal) FROM sale_lines line JOIN sales sale ON sale.id=line.sale_id
        JOIN catalog_variants variant ON variant.id=line.variant_id
        JOIN catalog_entries entry ON entry.id=variant.catalog_entry_id
        WHERE sale.branch_location_id=$1
          AND ($2::timestamptz IS NULL OR sale.created_at >= $2)
          AND entry.kind='battery'),0)::numeric(12,2)::text`,
		int16(branch), today.Since).Scan(&sales, &expenses, &effective, &sold, &base); err != nil {
		return MetricsToday{}, fail(ctx)
	}
	today.Sales, today.Expenses, today.Sold, today.CommissionBase =
		Money(sales), Money(expenses), Money(sold), Money(base)
	// The amounts are what the branch holds or spent, never a signed reading: anything else is a
	// persisted state this answer could not have been produced from. The effect of the window is signed
	// on purpose -- it is the net of aportes, recaudaciones and gastos, and a corrected row reverses one
	// of them -- so it is judged by its own reading.
	for _, amount := range []Money{today.Opening, today.Sales, today.Expenses, today.Sold,
		today.CommissionBase} {
		if _, ok := amountCents(amount); !ok {
			return MetricsToday{}, ErrUnavailable
		}
	}
	today.Effective = Signed(effective)
	if _, ok := today.Effective.Cents(); !ok {
		return MetricsToday{}, ErrUnavailable
	}
	// The drawer's own identity over every term of the window, reused and never restated (S4): the
	// opening it inherited, the cash its sales collected and the signed effect of its movements.
	expected, err := DrawerExpected(today.Opening, today.Sales, today.Effective)
	if err != nil {
		return MetricsToday{}, ErrUnavailable
	}
	today.Expected = expected
	// What the branch is earning so far: the rate the warehouse froze for it times the batteries it sold
	// in this window, rounded exactly once by the settlement's own rule, so the card and the acta of
	// the period being lived cannot disagree on the arithmetic (S18). A branch the warehouse never
	// gave a rate to states no rate and earns no commission -- an absence, never a zero percentage
	// dressed as a rate (S20) -- and the read still answers, because the window itself is a fact.
	rate, err := configuredRate(ctx, q, int16(branch))
	switch {
	case errors.Is(err, ErrNoCommissionRate):
		today.Commission = Money("0.00")
	case err != nil:
		return MetricsToday{}, fail(ctx)
	default:
		commission, err := Commission(today.CommissionBase, rate)
		if err != nil {
			return MetricsToday{}, ErrUnavailable
		}
		configured := rate
		today.Rate, today.Commission = &configured, commission
	}
	// The list is read newest first so the bound keeps the newest rows of a long history, and it is
	// published oldest first because a ledger is read in the order it happened.
	// The list is the ledger view and not the table, so every row is published with the one signed
	// effect the expectation of the window sums (S13): a reader that read `amount` by kind instead would
	// be a second arithmetic of the same drawer.
	rows, err := q.Query(ctx, `SELECT kind,effect_kind,amount::text,effective::text,occurred_at
 FROM branch_cash_ledger
 WHERE branch_location_id=$1 AND ($2::timestamptz IS NULL OR occurred_at >= $2)
 ORDER BY occurred_at DESC,id DESC LIMIT `+strconv.Itoa(metricsTodayMovements),
		int16(branch), today.Since)
	if err != nil {
		return MetricsToday{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var movement MetricsMovement
		var effectKind, stored, effect string
		if rows.Scan(&movement.Kind, &effectKind, &stored, &effect, &movement.OccurredAt) != nil {
			return MetricsToday{}, fail(ctx)
		}
		if !movement.stored(effectKind, stored, effect) {
			return MetricsToday{}, ErrUnavailable
		}
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

// fundTodayMetrics reads the purchase envelope of the branch as it stands today (S15-S17): what the
// last closed settlement left in it, the signed effect of the movements of its window, the balance the
// book holds and the volume those same documents bought. It exists because the envelope is a money box
// of its own: a branch whose settlements are all closed has no period on screen that states it.
//
// The opening is not a second calculation of the fund: it is the number the acta of that same closure
// publishes, read by the same helper -- the signed sum of `purchase_fund_ledger` at the instant the
// settlement closed (S5, S9), which is the amount the closure wrote as its `reposicion` and the amount
// the next opening inherits. A settlement that closed before its branch's fund had a movement keeps the
// number it stated, exactly as its own acta does, so the card and the document of the same envelope can
// never disagree. The purchases are the `paid_cash` of the branch's documents from that cut on, with no
// counter-document filter: they are stored with negative amounts, so a reversal subtracts by
// construction and the net is a signed reading.
//
// The cut, and not the closure, is where the window starts, for the same reason the drawer of today
// starts there: the period of a closed settlement ends at its cut. The two instants give the same answer
// for purchases -- a branch inside a settlement cannot spend (035) -- so nothing falls between them here,
// and the instant the card names is the one the period of the next settlement inherits.
func fundTodayMetrics(ctx context.Context, q querier, branch int64) (MetricsFundToday, error) {
	var stored *string
	var cut, settledAt time.Time
	// The last closed settlement, by the same order the drawer of today reads it, so the two cards of the
	// same closing state one instant: its cut and the envelope it left behind.
	fund := MetricsFundToday{Opening: Money("0.00"), Purchases: Signed("0.00"),
		Effective: Signed("0.00"), Balance: Signed("0.00")}
	err := q.QueryRow(ctx, `SELECT purchase_fund_cash::text,cut_at,closed_at FROM branch_closings
 WHERE branch_location_id=$1 AND status='closed'
 ORDER BY cut_at DESC,id DESC LIMIT 1`, int16(branch)).Scan(&stored, &cut, &settledAt)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// A branch that never closed a settlement states no cut and inherits nothing: the window is
		// everything it ever bought, and a nil Since is that state instead of a zero instant.
	case err != nil:
		return MetricsFundToday{}, fail(ctx)
	default:
		if cut.IsZero() || settledAt.IsZero() {
			return MetricsFundToday{}, ErrUnavailable
		}
		// The fund the closure left is the book's own sum at that instant, and only a settlement that
		// closed before its branch's fund had a ledger falls back to the column it stated: the same
		// rule, read by the same helper, as the acta of that very settlement.
		settled, err := settledPurchaseFund(ctx, q, branch, &settledAt)
		if err != nil {
			return MetricsFundToday{}, err
		}
		switch {
		case settled != nil:
			fund.Opening = *settled
		case stored != nil:
			opening := Money(*stored)
			if _, ok := amountCents(opening); !ok {
				return MetricsFundToday{}, ErrUnavailable
			}
			fund.Opening = opening
		}
		fund.Since = &cut
	}
	// The money, the documents and the volume of the window, in one statement over the same predicate:
	// the four readings describe one window or they are four different windows. The two sums of lines are
	// the ones the purchases package sums -- the line tables joined to their document and grouped by the
	// database -- so a counter-document nets out here as it does there.
	var purchases, kilograms string
	var documents, used int64
	if err := q.QueryRow(ctx, `SELECT
 coalesce((SELECT sum(purchase.paid_cash) FROM purchases purchase
        WHERE purchase.location_id=$1
          AND ($2::timestamptz IS NULL OR purchase.created_at >= $2)),0)::numeric(12,2)::text,
 (SELECT count(*) FROM purchases purchase
        WHERE purchase.location_id=$1
          AND ($2::timestamptz IS NULL OR purchase.created_at >= $2)),
 coalesce((SELECT sum(line.quantity) FROM purchase_used_lines line
        JOIN purchases purchase ON purchase.id=line.purchase_id
        WHERE purchase.location_id=$1
          AND ($2::timestamptz IS NULL OR purchase.created_at >= $2)),0),
 coalesce((SELECT sum(line.kg) FROM purchase_scrap_lines line
        JOIN purchases purchase ON purchase.id=line.purchase_id
        WHERE purchase.location_id=$1
          AND ($2::timestamptz IS NULL OR purchase.created_at >= $2)),0)::numeric(12,3)::text`,
		int16(branch), fund.Since).Scan(&purchases, &documents, &used, &kilograms); err != nil {
		return MetricsFundToday{}, fail(ctx)
	}
	spent := Signed(purchases)
	if _, ok := spent.Cents(); !ok {
		return MetricsFundToday{}, ErrUnavailable
	}
	// The weight is read at the scale the sheet publishes: thousandths of a kilogram, which is the
	// three-decimal column the purchase lines store. The sum is a NET of the window's documents, so a
	// counter-document that reversed a purchase made before the cut leaves it negative: the sign is the
	// reading, and refusing it would answer 503 for a branch that did nothing wrong.
	milli, ok := signedQuantityMilli(kilograms)
	if !ok {
		return MetricsFundToday{}, ErrUnavailable
	}
	// The documents are a count; the units, like the kilograms, are the net of those documents.
	if documents < 0 {
		return MetricsFundToday{}, ErrUnavailable
	}
	// The balance is the book's and the card publishes it with the term that moves it (S5, S13): the
	// signed sum of `purchase_fund_ledger` over the whole book of the branch -- never an opening minus a
	// window of purchases -- and, beside it, the signed effect of the movements of the window that belong
	// to no settlement. A branch that never closed a settlement is included: its book is the founding
	// `aporte` and the balance is that sum, not zero.
	//
	// The movements a closure wrote are left out of the window by `closing_id`, the fact the view does not
	// publish: the `reposicion` or `devolucion` of the last settlement is already inside the number it
	// published as the opening, and counting it again as a movement of the window would count the same
	// money twice -- exactly as the drawer of today leaves out the transfers of an acta (S5). Nothing is
	// recomputed from the table: the two sums read the view's own `effective`, and the join only asks
	// which settlement a row belongs to.
	var booked, effective string
	if err := q.QueryRow(ctx, `SELECT
 coalesce((SELECT sum(ledger.effective) FROM purchase_fund_ledger ledger
        WHERE ledger.branch_location_id=$1),0)::numeric(12,2)::text,
 coalesce((SELECT sum(ledger.effective) FROM purchase_fund_ledger ledger
        JOIN branch_fund_movements movement ON movement.id=ledger.id
        WHERE ledger.branch_location_id=$1 AND movement.closing_id IS NULL
          AND ($2::timestamptz IS NULL OR ledger.occurred_at >= $2)),0)::numeric(12,2)::text`,
		int16(branch), fund.Since).Scan(&booked, &effective); err != nil {
		return MetricsFundToday{}, fail(ctx)
	}
	balance, effect := Signed(booked), Signed(effective)
	for _, amount := range []Signed{balance, effect} {
		if _, ok := amount.Cents(); !ok {
			return MetricsFundToday{}, ErrUnavailable
		}
	}
	fund.Purchases, fund.Effective, fund.Balance = spent, effect, balance
	fund.Documents, fund.UsedUnits, fund.ScrapMilli = documents, used, milli
	return fund, nil
}

// stored revalidates one row of the ledger view and publishes it as the card states it, returning
// whether the row is one this domain could have written: the kind is one of the four the ledger admits,
// the effect kind is a direction and never the correction itself, a correction is the only kind whose
// effect kind is its own, the amount is canonical and positive, and the effect is canonical money of
// the same magnitude in the direction that kind states (S4, S6, S13). A row that fails any of them is
// never published: the caller fails closed.
func (m *MetricsMovement) stored(effectKind, amount, effect string) bool {
	if !metricsMovementKind(m.Kind) || !cashMovementEffectKind(effectKind) ||
		(effectKind != m.Kind) != (m.Kind == cashMovementCorrection) || m.OccurredAt.IsZero() {
		return false
	}
	stored := Money(amount)
	cents, ok := amountCents(stored)
	if !ok || cents < 1 {
		return false
	}
	signed := Signed(effect)
	effectCents, ok := signed.Cents()
	// The view states the row's own amount in one direction or the other, so a magnitude that is not
	// the amount of the row is money this ledger never derived.
	if !ok || (effectCents != cents && effectCents != -cents) ||
		!cashMovementDirection(m.Kind, effectKind, effectCents) {
		return false
	}
	m.Amount, m.Effective = stored, signed
	return true
}

// metricsMovementKind admits the four kinds the ledger writes: the expense the branch paid out of the
// drawer, the collection it gave up, the contribution it received and the correction that answers one of
// them. The admission itself is the ledger's own, reused instead of restated, so no two readers spell
// the four kinds differently (S13).
func metricsMovementKind(kind string) bool { return cashMovementKind(kind) }

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

// signedQuantityMilli reads a published quantity that may carry a sign, at the three-decimal scale of a
// weight: the net of a window can fall below zero and that sign is part of the number.
func signedQuantityMilli(text string) (int64, bool) {
	negative := strings.HasPrefix(text, "-")
	if negative {
		text = text[1:]
	}
	milli, ok := quantityMilli(Quantity(text))
	if !ok || (negative && milli == 0) {
		return 0, false
	}
	if negative {
		return -milli, true
	}
	return milli, true
}

// windowOf builds the branch predicate of a read, with its window when the period has one. The
// window is half-open -- [period_start, cut_at) -- exactly like the settlement it comes from, so
// a sale made at the cut belongs to the next period and never to both. A window that states only
// its start is the computed one: it begins at the cut of the last closed settlement and ends at the
// instant of the read, so there is no bound to state and no sale is left out (S3).
func windowOf(branch int64, from, to *time.Time) (string, []any) {
	if from == nil {
		return "sale.branch_location_id=$1", []any{branch}
	}
	if to == nil {
		return "sale.branch_location_id=$1 AND sale.created_at >= $2", []any{branch, *from}
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
