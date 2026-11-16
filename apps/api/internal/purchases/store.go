package purchases

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
)

// Store persists and reads the purchase documents of a branch.
type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// fail retains cancellation semantics but never driver/config/SQL details.
func fail(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrUnavailable
}

// ErrBranchFrozen is the refusal of a purchase the branch may not register because a live account
// settlement holds it (LC001, the freeze of 035). It is a refusal the operator acts on -- the
// branch closes or waits out its settlement -- and never an outage, so the boundary publishes it
// under the same code and status the closing layer publishes the very same fact with (409
// branch_frozen): one fact of the branch, one token across the house.
var ErrBranchFrozen = errors.New("the branch has an open account settlement and cannot operate")

// FundRefusal is the refusal of a purchase the purchase fund cannot pay: the fund is cash, so a
// branch purchase is paid in cash from it, and no document ever spends more than the balance of
// the branch's fund. It is an invalid request, exactly like every other broken rule of this
// contract, and it keeps the domain's own words instead of the database's.
//
// It is the class of both refusals of the fund: the payment that is not cash (LP006) and the
// document the ledger of the fund refuses for lack of money (LF003). The second one reaches the
// branch with the two numbers of its own refusal, FundInsufficient.
type FundRefusal struct{}

// Error names the rule and never the SQLSTATE that raised it.
func (e *FundRefusal) Error() string {
	return "a branch purchase is paid in cash from the purchase fund, and it can never exceed" +
		" the balance of that fund"
}

// Unwrap keeps errors.Is(err, ErrInvalid) true.
func (e *FundRefusal) Unwrap() error { return ErrInvalid }

// FundInsufficient is the refusal of a purchase the fund cannot pay: the signed ledger of the
// branch holds Balance and the document asks Requested (LF003, the admission of the ledger). The
// two numbers travel with the refusal because they are what the branch acts on -- the screen says
// «el fondo tiene Bs X, la compra pide Bs Y» -- and a refusal that only said no would leave the
// operator guessing how much the document exceeds by.
//
// The balance is read from `purchase_fund_ledger`, the one place that computes it: this refusal
// names the arithmetic, it never repeats it.
type FundInsufficient struct {
	Balance   Money
	Requested Money
}

// Error states both numbers in the words of the contract and never the SQLSTATE.
func (e *FundInsufficient) Error() string {
	return "the purchase fund holds " + string(e.Balance) + " and the purchase asks " +
		string(e.Requested)
}

// Unwrap keeps errors.Is(err, ErrInvalid) true: a caller that only knows the classes still
// recognises it, and the boundary publishes it under its own code because "the fund cannot pay
// this" is a fact the branch acts on and a generic invalid request is not.
func (e *FundInsufficient) Unwrap() error { return ErrInvalid }

// purchaseLock serializes one operation key, so an identical concurrent submission
// resolves to a replay instead of a unique violation. Transaction scoped: the database
// releases it on commit, rollback or disconnect.
func purchaseLock(key string) int64 {
	h := sha256.Sum256([]byte("luson.purchase/retry/v1:" + key))
	return int64(binary.BigEndian.Uint64(h[:8]))
}

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// branchClerk admits only a completed branch session: the warehouse is not a buyer and a
// session that still must change its password operates nothing.
func branchClerk(actor auth.Identity) bool {
	return actor.AccountID > 1 && actor.Location.ID > warehouseLocationID &&
		actor.Location.ID <= maxBranchLocationID && !actor.MustChangePassword
}

// resolveBranch is the actor-to-branch authority: the branch a session buys in is the
// account's own provisioned location, never a value from the request. An account without a
// provisioned branch assignment, a retired account and a retired branch are all refused
// instead of being defaulted to some other branch.
func resolveBranch(ctx context.Context, q querier, actor auth.Identity) (int16, error) {
	var branch int16
	err := q.QueryRow(ctx, `SELECT a.location_id FROM auth_accounts a
 JOIN locations l ON l.id=a.location_id AND l.deleted_at IS NULL
 WHERE a.id=$1 AND a.location_id=$2 AND a.deleted_at IS NULL AND a.location_id>$3`,
		actor.AccountID, actor.Location.ID, warehouseLocationID).Scan(&branch)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrForbidden
	}
	if err != nil {
		return 0, fail(ctx)
	}
	return branch, nil
}

// Create applies one immutable purchase atomically in the actor's own branch: the header
// and every line of both kinds are one transaction, so a refused line leaves the ledger
// exactly as it was. The branch, the actor, the amounts and the mirror of a
// counter-document are the database's own.
//
// The canonical payload is resolved first, so an identical replay returns the persisted
// document and a different payload under the same operation key is a conflict, never a
// second document.
func (s *Store) Create(ctx context.Context, actor auth.Identity, input CreateInput) (Document, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Document{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Document{}, ErrForbidden
	}
	payload, err := Validate(input)
	if err != nil {
		return Document{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Document{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", purchaseLock(payload.OperationKey)); err != nil {
		return Document{}, fail(ctx)
	}
	branch, err := resolveBranch(ctx, tx, actor)
	if err != nil {
		return Document{}, err
	}
	// An operation key that already exists is answered, never repeated. A key of another
	// branch belongs to that branch's document, so it is a conflict here.
	existingID, existingBranch, err := reservedOperation(ctx, tx, payload.OperationKey)
	if err != nil {
		return Document{}, err
	}
	if existingID != 0 {
		existing, err := loadDocument(ctx, tx, existingID)
		if err != nil {
			return Document{}, err
		}
		if existingBranch != branch || !samePayload(existing, payload) {
			return Document{}, ErrRetryConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return Document{}, fail(ctx)
		}
		return existing, nil
	}
	if err := admitMaterials(ctx, tx, payload.ScrapLines); err != nil {
		return Document{}, err
	}
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,note,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, payload.OperationKey, branch, payload.Note,
		string(payload.Total), string(payload.PaidCash), string(payload.PaidTransfer),
		int64(actor.AccountID)).Scan(&id)
	if err != nil {
		return Document{}, mapFailure(ctx, err)
	}
	for _, line := range payload.UsedLines {
		if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,$2,$3,$4)`, id, line.Model, line.Quantity, string(line.UnitPrice)); err != nil {
			return Document{}, mapFailure(ctx, err)
		}
	}
	for _, line := range payload.ScrapLines {
		if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,$2,$3,$4)`, id, int16(line.MaterialID), string(line.Kg),
			string(line.PricePerKg)); err != nil {
			return Document{}, mapFailure(ctx, err)
		}
	}
	document, err := loadDocument(ctx, tx, id)
	if err != nil {
		return Document{}, err
	}
	// The movement of the fund is written by the database at this very instant, by the deferred
	// trigger of the document (050), so the refusal of a fund that cannot pay arrives here and is
	// answered with the two numbers of the branch.
	if err := tx.Commit(ctx); err != nil {
		return Document{}, s.fundFailure(ctx, branch, payload.PaidCash, err)
	}
	return document, nil
}

// Reverse appends the immutable counter-document of one persisted original. The client
// never supplies lines: they are derived from the persisted original, so a partial
// reversal is impossible by construction.
//
// The operation key is serialized first, so an identical concurrent submission resolves to
// a replay instead of a unique violation, and the target row is locked before it is
// judged, so two reversals of one document cannot both pass the check.
func (s *Store) Reverse(ctx context.Context, actor auth.Identity, targetID int64, operationKey, reason string) (Document, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Document{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Document{}, ErrForbidden
	}
	if targetID < 1 {
		return Document{}, ErrNotFound
	}
	if !ValidOperationKey(operationKey) {
		return Document{}, ErrInvalid
	}
	canonicalReason, valid := CanonicalReason(reason)
	if !valid {
		return Document{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Document{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", purchaseLock(operationKey)); err != nil {
		return Document{}, fail(ctx)
	}
	branch, err := resolveBranch(ctx, tx, actor)
	if err != nil {
		return Document{}, err
	}
	// An existing operation key is resolved before the target is touched: the same key
	// with the same target and reason is a replay, anything else is a conflict and never a
	// second counter-document.
	existingID, existingBranch, err := reservedOperation(ctx, tx, operationKey)
	if err != nil {
		return Document{}, err
	}
	if existingID != 0 {
		existing, err := loadDocument(ctx, tx, existingID)
		if err != nil {
			return Document{}, err
		}
		if existingBranch != branch || existing.ReversesPurchaseID == nil ||
			*existing.ReversesPurchaseID != targetID || existing.Reason != canonicalReason {
			return Document{}, ErrRetryConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return Document{}, fail(ctx)
		}
		return existing, nil
	}
	// The target row is locked before it is judged, so a concurrent reversal of the same
	// document cannot slip between the check and the insert.
	var location int
	var reverses *int64
	var alreadyReversed bool
	err = tx.QueryRow(ctx, `SELECT p.location_id,p.reverses_purchase_id,
  EXISTS(SELECT 1 FROM purchases counter WHERE counter.reverses_purchase_id=p.id)
 FROM purchases p WHERE p.id=$1 FOR UPDATE`, targetID).Scan(&location, &reverses, &alreadyReversed)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	if err != nil {
		return Document{}, fail(ctx)
	}
	// A document of another branch is not part of this branch's ledger.
	if location != int(branch) {
		return Document{}, ErrNotFound
	}
	if reverses != nil || alreadyReversed {
		return Document{}, ErrAlreadyReversed
	}
	original, err := loadDocument(ctx, tx, targetID)
	if err != nil {
		return Document{}, err
	}
	derived, err := counterOf(original)
	if err != nil {
		return Document{}, err
	}
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,note,total,paid_cash,paid_transfer,
  reverses_purchase_id,reason,created_by_account_id)
 VALUES($1,$2,'',$3,$4,$5,$6,$7,$8) RETURNING id`, operationKey, branch,
		string(derived.Total), string(derived.PaidCash), string(derived.PaidTransfer),
		targetID, canonicalReason, int64(actor.AccountID)).Scan(&id)
	if err != nil {
		return Document{}, mapFailure(ctx, err)
	}
	for _, line := range derived.UsedLines {
		if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,$2,$3,$4)`, id, line.Model, line.Quantity, string(line.UnitPrice)); err != nil {
			return Document{}, mapFailure(ctx, err)
		}
	}
	for _, line := range derived.ScrapLines {
		if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,$2,$3,$4)`, id, int16(line.MaterialID), string(line.Kg),
			string(line.PricePerKg)); err != nil {
			return Document{}, mapFailure(ctx, err)
		}
	}
	document, err := loadDocument(ctx, tx, id)
	if err != nil {
		return Document{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Document{}, mapFailure(ctx, err)
	}
	return document, nil
}

// List reads one newest-first page of the chosen period of the actor's own branch, the
// selector the screen shows and, when the period is the pending one, the balance of the
// branch. The page is one count plus one page statement: the unit total and the scrap line
// count of each row are summed by the database, never by a Go loop over every line, and the
// unit total is cast to text before it becomes an int64 so an out-of-range sum fails closed.
//
// The selector, the page and the balance are read in one repeatable-read transaction, so the
// period the screen says it is showing and the documents it lists are the same answer. A
// period the branch does not have is an invalid request, never an empty list: an operator who
// kept a link to a settlement of another branch must not read a zero that looks like a fact.
func (s *Store) List(ctx context.Context, actor auth.Identity, page, pageSize int, selection PeriodSelection) (Listing, error) {
	result := Listing{Page: Page{Page: page, PageSize: pageSize, Purchases: []Summary{}}}
	if ctx == nil || s == nil || s.pool == nil {
		return Listing{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Listing{}, ErrForbidden
	}
	// Every rejected page, size or period stops here, before the first statement.
	if !ValidPage(page, pageSize) || !ValidSelection(selection) {
		return Listing{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	branch, err := resolveBranch(ctx, s.pool, actor)
	if err != nil {
		return Listing{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Listing{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	periods, err := loadPeriods(ctx, tx, branch)
	if err != nil {
		return Listing{}, err
	}
	period, ok := chosenPeriod(periods, selection)
	if !ok {
		return Listing{}, ErrInvalid
	}
	// The window of a settlement is [period_start, cut_at); the balance and the whole history
	// are not a window, so they list every document of the branch (S6).
	where, args := "WHERE p.location_id=$1", []any{branch}
	if period.Kind == PeriodSettlement || period.Kind == PeriodOpen {
		if period.From == nil || period.To == nil {
			return Listing{}, ErrUnavailable
		}
		where += " AND p.created_at >= $2 AND p.created_at < $3"
		args = append(args, *period.From, *period.To)
	}
	if tx.QueryRow(ctx, "SELECT count(*) FROM purchases p "+where, args...).Scan(&result.Page.TotalPurchases) != nil {
		return Listing{}, fail(ctx)
	}
	rows, err := tx.Query(ctx, `SELECT p.id,p.created_at,p.total::text,p.reverses_purchase_id,
  (SELECT counter.id FROM purchases counter WHERE counter.reverses_purchase_id=p.id),
  coalesce((SELECT sum(unit.quantity) FROM purchase_used_lines unit WHERE unit.purchase_id=p.id),0)::text,
  (SELECT count(*) FROM purchase_scrap_lines scrap WHERE scrap.purchase_id=p.id)
 FROM purchases p `+where+`
 ORDER BY p.id DESC LIMIT $`+strconv.Itoa(len(args)+1)+` OFFSET $`+strconv.Itoa(len(args)+2),
		append(args, int64(pageSize), int64(page-1)*int64(pageSize))...)
	if err != nil {
		return Listing{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var summary Summary
		var total, units string
		var scrap int64
		if rows.Scan(&summary.ID, &summary.CreatedAt, &total, &summary.ReversesPurchaseID,
			&summary.ReversedBy, &units, &scrap) != nil {
			return Listing{}, fail(ctx)
		}
		summary.Total = Money(total)
		if _, ok := centsOf(total); !ok || summary.ID < 1 || summary.CreatedAt.IsZero() ||
			scrap < 0 || scrap > MaxLines ||
			(len(result.Page.Purchases) > 0 && summary.ID >= result.Page.Purchases[len(result.Page.Purchases)-1].ID) {
			return Listing{}, ErrUnavailable
		}
		// A document carries at most MaxLines used lines of at most MaxQuantity units, so a
		// unit total outside that range is not a document this domain wrote.
		value, err := strconv.ParseInt(units, 10, 64)
		if err != nil || value > MaxLines*MaxQuantity || value < -MaxLines*MaxQuantity {
			return Listing{}, ErrUnavailable
		}
		if !signOf(summary.Total, summary.ReversesPurchaseID) {
			return Listing{}, ErrUnavailable
		}
		if summary.ReversedBy != nil && (*summary.ReversedBy <= summary.ID || summary.ReversesPurchaseID != nil) {
			return Listing{}, ErrUnavailable
		}
		summary.UsedUnits = value
		summary.ScrapLines = int(scrap)
		result.Page.Purchases = append(result.Page.Purchases, summary)
	}
	if rows.Err() != nil {
		return Listing{}, fail(ctx)
	}
	rows.Close()
	// The header numbers are the period's own. A window is summed from the very rows the received
	// route publishes — read here by the same statements over the period's window — so the two
	// answers can never disagree about the same documents. The pending period is not a window: its
	// numbers are the balance, which is what the branch still holds (S4).
	if period.Kind == PeriodPending {
		balance, err := loadBalance(ctx, tx, branch)
		if err != nil {
			return Listing{}, err
		}
		totals, err := totalsOfBalance(balance)
		if err != nil {
			return Listing{}, err
		}
		result.Balance, result.Totals = &balance, totals
	} else {
		// A window total is the net of every document in the window: it may be negative when a
		// counter-document reverses an earlier period, and one model may count more units than any
		// single document can hold, so the listing sums it by the window's rule and not the route's.
		received, err := readReceived(ctx, tx, where, args, true)
		if err != nil {
			return Listing{}, err
		}
		totals, err := totalsOfReceived(received, true)
		if err != nil {
			return Listing{}, err
		}
		result.Totals = totals
	}
	if tx.Commit(ctx) != nil {
		return Listing{}, fail(ctx)
	}
	result.Periods, result.Period = periods, period
	return result, nil
}

// ResolvePeriod reads the selector of the actor's own branch and returns it with the entry the
// selection names. It is the same selector and the same choice the listing publishes, exported so
// that a second read of the same branch cannot offer a different set of periods: a screen that
// shows a period the listing does not have would be a screen showing a period nobody can open. A
// selection the branch does not have is an invalid request, exactly as on the listing.
func (s *Store) ResolvePeriod(ctx context.Context, actor auth.Identity, selection PeriodSelection) ([]Period, Period, error) {
	branch, err := resolveBranch(ctx, s.pool, actor)
	if err != nil {
		return nil, Period{}, err
	}
	periods, err := loadPeriods(ctx, s.pool, branch)
	if err != nil {
		return nil, Period{}, err
	}
	period, ok := chosenPeriod(periods, selection)
	if !ok {
		return nil, Period{}, ErrInvalid
	}
	return periods, period, nil
}

// loadPeriods reads the selector of one branch: the pending balance first, then every closed
// settlement newest first, then the live settlement when the branch has one, then the whole
// history. A period is a settlement and never a calendar month, so the identifier of a closed
// settlement is the closing id itself; the live one is named by its kind because it is the one
// the branch is still inside.
func loadPeriods(ctx context.Context, q querier, branch int16) ([]Period, error) {
	rows, err := q.Query(ctx, `SELECT id,status,period_start,cut_at,closed_at
 FROM branch_closings WHERE branch_location_id=$1 ORDER BY cut_at DESC,id DESC`, branch)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	settlements := make([]Period, 0, 8)
	var live *Period
	previous := int64(math.MaxInt64)
	for rows.Next() {
		var id int64
		var status string
		var start, cut time.Time
		var closed *time.Time
		if rows.Scan(&id, &status, &start, &cut, &closed) != nil {
			return nil, fail(ctx)
		}
		// The history of one branch is ordered by the moment it settled, which is also the
		// order of its ids; anything else is not a history this domain wrote.
		if id < 1 || id >= previous || start.IsZero() || cut.IsZero() || start.After(cut) {
			return nil, ErrUnavailable
		}
		previous = id
		closingID, from, to := id, start, cut
		switch status {
		case "closed":
			// A closed settlement is the only period that has already taken material away, so
			// it is the only settlement period the selector offers as a fact.
			if closed == nil || closed.IsZero() || closed.Before(cut) {
				return nil, ErrUnavailable
			}
			settlements = append(settlements, Period{Kind: PeriodSettlement,
				ClosingID: &closingID, From: &from, To: &to,
				Label: "Rendición #" + strconv.FormatInt(id, 10)})
		case "open", "proposed", "rejected":
			// open, proposed and rejected all keep the branch frozen: the branch is inside one
			// settlement at a time, so a second live one is not a state this domain wrote.
			if live != nil {
				return nil, ErrUnavailable
			}
			live = &Period{Kind: PeriodOpen, ClosingID: &closingID, From: &from, To: &to,
				Label: "En curso"}
		default:
			return nil, ErrUnavailable
		}
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	periods := make([]Period, 0, len(settlements)+3)
	periods = append(periods, Period{Kind: PeriodPending, Label: "Pendiente"})
	periods = append(periods, settlements...)
	if live != nil {
		periods = append(periods, *live)
	}
	periods = append(periods, Period{Kind: PeriodAll, Label: "Todo el historial"})
	return periods, nil
}

// chosenPeriod resolves the requested selection against the selector of the branch. A period
// the branch does not have — a closing id of another branch, or an id that names no settlement —
// is not an empty list. A closing id names a closed settlement or the live one the selector
// offers as the period in progress, because the selector publishes both and an entry nobody can
// choose would be a period the screen can show and never open.
func chosenPeriod(periods []Period, selection PeriodSelection) (Period, bool) {
	for _, period := range periods {
		if selection.Kind == PeriodSettlement {
			if (period.Kind == PeriodSettlement || period.Kind == PeriodOpen) &&
				period.ClosingID != nil && *period.ClosingID == selection.ClosingID {
				return period, true
			}
			continue
		}
		if period.Kind == selection.Kind {
			return period, true
		}
	}
	return Period{}, false
}

// loadBalance derives the pending balance of one branch from every persisted document and
// every closed settlement: what was bought and not yet taken to the warehouse. A proposed
// settlement has taken nothing yet, so only a closed one counts what the warehouse counted.
// A counter-document subtracts by construction, because its quantity and weight are stored
// negated; a row whose net bought and delivered are both zero is not a position of the
// branch and is omitted instead of being published as a zero nobody can act on.
func loadBalance(ctx context.Context, q querier, branch int16) (Balance, error) {
	result := Balance{Used: []BalanceUsed{}, Scrap: []BalanceScrap{}}
	rows, err := q.Query(ctx, `SELECT coalesce(bought.model,delivered.model),
  bought.units::text,delivered.units::text
 FROM (
  SELECT line.model AS model,sum(line.quantity) AS units
  FROM purchase_used_lines line
  JOIN purchases p ON p.id=line.purchase_id
  WHERE p.location_id=$1
  GROUP BY line.model
 ) bought
 FULL OUTER JOIN (
  SELECT sheet.model AS model,sum(sheet.counted_quantity) AS units
  FROM closing_material_lines sheet
  JOIN branch_closings closing ON closing.id=sheet.closing_id
  WHERE closing.branch_location_id=$1 AND closing.status='closed'
    AND sheet.kind='used' AND sheet.counted_quantity IS NOT NULL
  GROUP BY sheet.model
 ) delivered ON delivered.model=bought.model
 ORDER BY coalesce(bought.model,delivered.model) COLLATE "C"`, branch)
	if err != nil {
		return Balance{}, fail(ctx)
	}
	for rows.Next() {
		var model string
		var boughtText, deliveredText *string
		if rows.Scan(&model, &boughtText, &deliveredText) != nil {
			rows.Close()
			return Balance{}, fail(ctx)
		}
		bought, boughtOK := netUnits(boughtText)
		delivered, deliveredOK := deliveredUnits(deliveredText)
		canonical, modelOK := CanonicalModel(model)
		if !boughtOK || !deliveredOK || !modelOK || canonical != model ||
			bought < 0 || delivered < 0 ||
			(len(result.Used) > 0 && model <= result.Used[len(result.Used)-1].Model) {
			rows.Close()
			return Balance{}, ErrUnavailable
		}
		if bought == 0 && delivered == 0 {
			continue
		}
		result.Used = append(result.Used, BalanceUsed{Model: model, Bought: bought,
			Delivered: delivered, Balance: bought - delivered})
	}
	if rows.Err() != nil {
		rows.Close()
		return Balance{}, fail(ctx)
	}
	rows.Close()
	rows, err = q.Query(ctx, `SELECT coalesce(bought.material_id,delivered.material_id),
  bought.kg::text,delivered.kg::text
 FROM (
  SELECT line.material_id AS material_id,sum(line.kg) AS kg
  FROM purchase_scrap_lines line
  JOIN purchases p ON p.id=line.purchase_id
  WHERE p.location_id=$1
  GROUP BY line.material_id
 ) bought
 FULL OUTER JOIN (
  SELECT sheet.material_id AS material_id,sum(sheet.counted_quantity) AS kg
  FROM closing_material_lines sheet
  JOIN branch_closings closing ON closing.id=sheet.closing_id
  WHERE closing.branch_location_id=$1 AND closing.status='closed'
    AND sheet.kind='scrap' AND sheet.counted_quantity IS NOT NULL
  GROUP BY sheet.material_id
 ) delivered ON delivered.material_id=bought.material_id
 ORDER BY 1`, branch)
	if err != nil {
		return Balance{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var materialID int64
		var boughtText, deliveredText *string
		if rows.Scan(&materialID, &boughtText, &deliveredText) != nil {
			return Balance{}, fail(ctx)
		}
		bought, boughtOK := netMilli(boughtText)
		delivered, deliveredOK := netMilli(deliveredText)
		if !boughtOK || !deliveredOK || materialID < 1 || materialID > maxMaterialID ||
			bought < 0 || delivered < 0 || bought > maxMilli || delivered > maxMilli ||
			(len(result.Scrap) > 0 && materialID <= result.Scrap[len(result.Scrap)-1].MaterialID) {
			return Balance{}, ErrUnavailable
		}
		if bought == 0 && delivered == 0 {
			continue
		}
		balance, ok := weightOfMilli(bought - delivered)
		if !ok {
			return Balance{}, ErrUnavailable
		}
		result.Scrap = append(result.Scrap, BalanceScrap{MaterialID: materialID,
			Bought: mustWeight(bought), Delivered: mustWeight(delivered), Balance: balance})
	}
	if rows.Err() != nil {
		return Balance{}, fail(ctx)
	}
	return result, nil
}

// mustWeight renders integer thousandths the caller already bounded.
func mustWeight(milli int64) Weight {
	weight, _ := weightOfMilli(milli)
	return weight
}

// netUnits reads one summed used quantity as whole units: an absent sum is zero, and a value
// that is not canonical integer text is not a sum this domain wrote.
func netUnits(text *string) (int64, bool) {
	if text == nil {
		return 0, true
	}
	value, err := strconv.ParseInt(*text, 10, 64)
	if err != nil || strconv.FormatInt(value, 10) != *text {
		return 0, false
	}
	return value, true
}

// deliveredUnits reads one counted quantity of a closed settlement as whole units: the sheet
// stores three decimals, and a used line is a whole number of batteries by the table's own
// rule, so a fraction is not a count this domain wrote.
func deliveredUnits(text *string) (int64, bool) {
	if text == nil {
		return 0, true
	}
	milli, ok := milliOf(*text)
	if !ok || milli%1000 != 0 {
		return 0, false
	}
	return milli / 1000, true
}

// netMilli reads one summed weight as integer thousandths: an absent sum is zero.
func netMilli(text *string) (int64, bool) {
	if text == nil {
		return 0, true
	}
	return milliOf(*text)
}

// Detail reads one persisted document of the actor's own branch: the header, its used
// lines and its scrap lines with the name of their material. A document of another branch
// is not found, exactly like an unknown one.
func (s *Store) Detail(ctx context.Context, actor auth.Identity, id int64) (Document, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Document{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Document{}, ErrForbidden
	}
	// Only a positive document id reaches the database; an aliased or impossible one stays
	// not found exactly like an unknown document.
	if id < 1 {
		return Document{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	branch, err := resolveBranch(ctx, s.pool, actor)
	if err != nil {
		return Document{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Document{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	document, err := loadDocument(ctx, tx, id)
	if err != nil {
		return Document{}, err
	}
	if document.LocationID != int(branch) {
		return Document{}, ErrNotFound
	}
	if tx.Commit(ctx) != nil {
		return Document{}, fail(ctx)
	}
	return document, nil
}

// Models reads the distinct model codes of the active catalogue, ascending and
// deduplicated across brands: "modelos sin repetir entre marcas". There is no mirror list
// to maintain, so a model created in the catalogue appears here by itself, and a model
// typed freely in a purchase never does.
func (s *Store) Models(ctx context.Context, actor auth.Identity) ([]string, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return nil, ErrUnavailable
	}
	if !branchClerk(actor) {
		return nil, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := resolveBranch(ctx, s.pool, actor); err != nil {
		return nil, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	rows, err := tx.Query(ctx, `SELECT canonical.model FROM (
 SELECT DISTINCT upper(btrim(model)) AS model FROM catalog_entries WHERE deleted_at IS NULL
) canonical ORDER BY canonical.model COLLATE "C"`)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	models := make([]string, 0, 96)
	for rows.Next() {
		var model string
		if rows.Scan(&model) != nil {
			return nil, fail(ctx)
		}
		// A catalogue model is non-empty text that the purchase contract can carry: the
		// published list is canonical (trimmed and upper-cased) and a value the contract
		// could not accept as a model code is not a row this catalogue wrote, so the list
		// fails closed instead of offering something the document would refuse. The list
		// is deduplicated across brands: "modelos sin repetir entre marcas".
		if !boundedText(model, 1, maxCategoryText) || len(models) >= maxCatalogueRows {
			return nil, ErrUnavailable
		}
		if canonical, ok := CanonicalModel(model); !ok || canonical != model {
			return nil, ErrUnavailable
		}
		if len(models) > 0 {
			switch {
			case model == models[len(models)-1]:
				continue
			case model < models[len(models)-1]:
				return nil, ErrUnavailable
			}
		}
		models = append(models, model)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	if tx.Commit(ctx) != nil {
		return nil, fail(ctx)
	}
	return models, nil
}

// Materials reads the reference materials, ordered by id: the list is typed data the
// branch buys by the kilogram, never a client value.
func (s *Store) Materials(ctx context.Context, actor auth.Identity) ([]Material, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return nil, ErrUnavailable
	}
	if !branchClerk(actor) {
		return nil, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := resolveBranch(ctx, s.pool, actor); err != nil {
		return nil, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	rows, err := tx.Query(ctx, "SELECT id,name FROM materials ORDER BY id")
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	materials := make([]Material, 0, 4)
	for rows.Next() {
		var material Material
		if rows.Scan(&material.ID, &material.Name) != nil {
			return nil, fail(ctx)
		}
		if material.ID < 1 || material.ID > maxMaterialID ||
			!boundedText(material.Name, 1, maxCategoryText) ||
			(len(materials) > 0 && material.ID <= materials[len(materials)-1].ID) {
			return nil, ErrUnavailable
		}
		materials = append(materials, material)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	if tx.Commit(ctx) != nil {
		return nil, fail(ctx)
	}
	return materials, nil
}

// LastPrices reads the anchor the counter shows next to each input: the most recent price
// paid in this branch for a model and for a material, taken from the latest line with a
// positive quantity of a document that is not a counter-document. A model or material never
// bought here is simply absent.
func (s *Store) LastPrices(ctx context.Context, actor auth.Identity) (LastPrices, error) {
	result := LastPrices{Models: []ModelPrice{}, Materials: []MaterialPrice{}}
	if ctx == nil || s == nil || s.pool == nil {
		return LastPrices{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return LastPrices{}, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	branch, err := resolveBranch(ctx, s.pool, actor)
	if err != nil {
		return LastPrices{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return LastPrices{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	rows, err := tx.Query(ctx, `SELECT model,unit_price::text,created_at FROM (
  SELECT line.model AS model,line.unit_price::text AS unit_price,p.created_at AS created_at,
         row_number() OVER (PARTITION BY line.model ORDER BY p.id DESC) AS position
  FROM purchase_used_lines line
  JOIN purchases p ON p.id=line.purchase_id
  WHERE p.location_id=$1 AND p.reverses_purchase_id IS NULL AND line.quantity > 0
 ) latest WHERE position=1 ORDER BY model COLLATE "C"`, branch)
	if err != nil {
		return LastPrices{}, fail(ctx)
	}
	for rows.Next() {
		var price ModelPrice
		var unit string
		if rows.Scan(&price.Model, &unit, &price.PurchasedAt) != nil {
			rows.Close()
			return LastPrices{}, fail(ctx)
		}
		price.UnitPrice = Money(unit)
		model, ok := CanonicalModel(price.Model)
		if !ok || model != price.Model || price.PurchasedAt.IsZero() || !positiveMoney(price.UnitPrice) ||
			len(result.Models) >= maxCatalogueRows ||
			(len(result.Models) > 0 && price.Model <= result.Models[len(result.Models)-1].Model) {
			rows.Close()
			return LastPrices{}, ErrUnavailable
		}
		result.Models = append(result.Models, price)
	}
	if rows.Err() != nil {
		rows.Close()
		return LastPrices{}, fail(ctx)
	}
	rows.Close()
	rows, err = tx.Query(ctx, `SELECT material_id,price_per_kg::text,created_at FROM (
  SELECT line.material_id AS material_id,line.price_per_kg::text AS price_per_kg,
         p.created_at AS created_at,
         row_number() OVER (PARTITION BY line.material_id ORDER BY p.id DESC) AS position
  FROM purchase_scrap_lines line
  JOIN purchases p ON p.id=line.purchase_id
  WHERE p.location_id=$1 AND p.reverses_purchase_id IS NULL AND line.kg > 0
 ) latest WHERE position=1 ORDER BY material_id`, branch)
	if err != nil {
		return LastPrices{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var price MaterialPrice
		var unit string
		if rows.Scan(&price.MaterialID, &unit, &price.PurchasedAt) != nil {
			return LastPrices{}, fail(ctx)
		}
		price.PricePerKg = Money(unit)
		if price.MaterialID < 1 || price.MaterialID > maxMaterialID || price.PurchasedAt.IsZero() ||
			!positiveMoney(price.PricePerKg) ||
			(len(result.Materials) > 0 && price.MaterialID <= result.Materials[len(result.Materials)-1].MaterialID) {
			return LastPrices{}, ErrUnavailable
		}
		result.Materials = append(result.Materials, price)
	}
	if rows.Err() != nil {
		return LastPrices{}, fail(ctx)
	}
	if tx.Commit(ctx) != nil {
		return LastPrices{}, fail(ctx)
	}
	return result, nil
}

// Received reads what the branch has received, derived from every persisted document of
// the branch so a counter-document nets out by construction: per model and per material,
// with the money the branch spent. Rows whose net quantity or weight is zero are omitted.
func (s *Store) Received(ctx context.Context, actor auth.Identity) (Received, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Received{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Received{}, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	branch, err := resolveBranch(ctx, s.pool, actor)
	if err != nil {
		return Received{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Received{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	// The whole history is the window of this route, and it is the same window a listing of the whole
	// history reads: one set of statements, so the two answers cannot disagree.
	result, err := readReceived(ctx, tx, "WHERE p.location_id=$1", []any{branch}, false)
	if err != nil {
		return Received{}, err
	}
	if tx.Commit(ctx) != nil {
		return Received{}, fail(ctx)
	}
	return result, nil
}

// readReceived reads the received rows of one window: the net quantity and value of every model and
// the net weight and value of every material, grouped by the database so a counter-document nets out
// by construction. The window is the caller's own WHERE fragment and arguments, which is why the
// whole history of the received route and one period's window of the listing are the same reading.
// A signed reading is a window's net: a window holding only a counter-document reverses an earlier
// period, so its quantity, weight and value are negative and may outgrow a single document. The
// received route reads one original netted by its counter-documents, so it stays unsigned.
func readReceived(ctx context.Context, q querier, where string, args []any, signed bool) (Received, error) {
	result := Received{Used: []ReceivedUsed{}, Scrap: []ReceivedScrap{}}
	rows, err := q.Query(ctx, `SELECT line.model,sum(line.quantity)::text,sum(line.amount)::text
 FROM purchase_used_lines line
 JOIN purchases p ON p.id=line.purchase_id
 `+where+`
 GROUP BY line.model HAVING sum(line.quantity) <> 0
 ORDER BY line.model COLLATE "C"`, args...)
	if err != nil {
		return Received{}, fail(ctx)
	}
	for rows.Next() {
		var row ReceivedUsed
		var quantity, value string
		if rows.Scan(&row.Model, &quantity, &value) != nil {
			rows.Close()
			return Received{}, fail(ctx)
		}
		row.Value = Money(value)
		units, err := strconv.ParseInt(quantity, 10, 64)
		cents, centsOK := centsOf(value)
		// A received row is an original document netted by its counter-documents, so a
		// positive quantity and a positive value are the only shape this domain wrote. A window
		// total is the net of every document in it instead, signed and unbounded per document.
		if err != nil || !centsOK || (!signed && (units < 1 || units > MaxLines*MaxQuantity || cents < 1)) ||
			!boundedText(row.Model, 1, maxCategoryText) ||
			len(result.Used) >= maxCatalogueRows ||
			(len(result.Used) > 0 && row.Model <= result.Used[len(result.Used)-1].Model) {
			rows.Close()
			return Received{}, ErrUnavailable
		}
		row.Quantity = units
		result.Used = append(result.Used, row)
	}
	if rows.Err() != nil {
		rows.Close()
		return Received{}, fail(ctx)
	}
	rows.Close()
	rows, err = q.Query(ctx, `SELECT line.material_id,material.name,sum(line.kg)::text,sum(line.amount)::text
 FROM purchase_scrap_lines line
 JOIN purchases p ON p.id=line.purchase_id
 JOIN materials material ON material.id=line.material_id
 `+where+`
 GROUP BY line.material_id,material.name HAVING sum(line.kg) <> 0
 ORDER BY line.material_id`, args...)
	if err != nil {
		return Received{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var row ReceivedScrap
		var kg, value string
		if rows.Scan(&row.MaterialID, &row.Name, &kg, &value) != nil {
			return Received{}, fail(ctx)
		}
		row.Value = Money(value)
		milli, kgOK := milliOf(kg)
		weight, _ := weightOfMilli(milli)
		// A weight whose kilogram price rounds to the cent can net to a zero value, so a
		// scrap row admits 0.00: what it may never be is negative or out of range, unless the
		// caller reads a window's net, whose sign and magnitude are the window's own.
		floor := int64(1)
		if signed {
			floor = -maxMilli
		}
		if !kgOK || milli < floor || milli > maxMilli || weight == "" {
			return Received{}, ErrUnavailable
		}
		valueCents, valueOK := centsOf(value)
		if !valueOK || (!signed && valueCents < 0) || row.MaterialID < 1 || row.MaterialID > maxMaterialID ||
			!boundedText(row.Name, 1, maxCategoryText) ||
			(len(result.Scrap) > 0 && row.MaterialID <= result.Scrap[len(result.Scrap)-1].MaterialID) {
			return Received{}, ErrUnavailable
		}
		row.Kg = weight
		result.Scrap = append(result.Scrap, row)
	}
	if rows.Err() != nil {
		return Received{}, fail(ctx)
	}
	return result, nil
}

// totalsOfReceived sums one received reading into the three header numbers of its window. It sums
// exactly the rows that reading publishes, so the totals of the listing and the rows of the received
// route are one same answer, and it bounds every sum here so an amount outside the published formats
// fails closed instead of being rendered. An unsigned sum is the received route's: one original
// netted by its counter-documents, so every row is positive and inside one document's bound. A signed
// sum is a window's net, which is negative when the window reverses an earlier period and which
// nothing per document bounds; only the published formats and int64 itself do.
func totalsOfReceived(received Received, signed bool) (Totals, error) {
	unavailable := func() (Totals, error) { return Totals{}, ErrUnavailable }
	var cents, units, milli int64
	for _, row := range received.Used {
		value, ok := centsOf(string(row.Value))
		if !ok || (!signed && (value < 1 || row.Quantity < 1 || row.Quantity > MaxLines*MaxQuantity)) {
			return unavailable()
		}
		if cents, ok = addInto(cents, value); !ok {
			return unavailable()
		}
		if units, ok = addInto(units, row.Quantity); !ok {
			return unavailable()
		}
	}
	for _, row := range received.Scrap {
		value, ok := centsOf(string(row.Value))
		weight, kgOK := milliOf(string(row.Kg))
		// A material whose kilogram price rounds to the cent can net to a zero value, so a scrap row
		// admits 0.00; what it may never be is negative, unless the caller sums a window's net.
		if !ok || !kgOK || (!signed && (value < 0 || weight < 1 || weight > maxMilli)) {
			return unavailable()
		}
		if cents, ok = addInto(cents, value); !ok {
			return unavailable()
		}
		if milli, ok = addInto(milli, weight); !ok {
			return unavailable()
		}
	}
	money, ok := moneyOfCents(cents)
	if !ok {
		return unavailable()
	}
	kg, ok := weightOfMilli(milli)
	if !ok {
		return unavailable()
	}
	return Totals{Money: money, UsedUnits: units, ScrapKg: kg}, nil
}

// addInto adds one signed quantity, refusing a sum int64 cannot hold.
func addInto(total, addend int64) (int64, bool) {
	if (addend > 0 && total > math.MaxInt64-addend) || (addend < 0 && total < math.MinInt64-addend) {
		return total, false
	}
	return total + addend, true
}

// totalsOfBalance is the pending period's own reading in the header's three numbers: how many used
// units and how many kilograms the branch still holds, summed from the balance rows, which are the
// position itself rather than a window of it. A balance is material and not money, so it states no
// amount. The sum follows the sign of the balance, because a settlement that counted more than the
// branch bought is a real difference and never a zero.
func totalsOfBalance(balance Balance) (Totals, error) {
	unavailable := func() (Totals, error) { return Totals{}, ErrUnavailable }
	var units, milli int64
	for _, row := range balance.Used {
		if (row.Balance > 0 && units > math.MaxInt64-row.Balance) ||
			(row.Balance < 0 && units < math.MinInt64-row.Balance) {
			return unavailable()
		}
		units += row.Balance
	}
	for _, row := range balance.Scrap {
		weight, ok := milliOf(string(row.Balance))
		if !ok || (weight > 0 && milli > math.MaxInt64-weight) ||
			(weight < 0 && milli < math.MinInt64-weight) {
			return unavailable()
		}
		milli += weight
	}
	kg, ok := weightOfMilli(milli)
	if !ok {
		return unavailable()
	}
	return Totals{UsedUnits: units, ScrapKg: kg}, nil
}

// reservedOperation reads the document already persisted under one operation key, if any,
// together with its branch. A key never repeats across documents, so at most one row is
// answered, and the caller compares the payload instead of trusting the key alone.
func reservedOperation(ctx context.Context, q querier, key string) (int64, int16, error) {
	var id int64
	var branch int16
	err := q.QueryRow(ctx, "SELECT id,location_id FROM purchases WHERE operation_key=$1", key).Scan(&id, &branch)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, fail(ctx)
	}
	return id, branch, nil
}

// admitMaterials refuses a scrap line that names a material the reference table does not
// hold, before any line is written. It is one statement for the whole document.
func admitMaterials(ctx context.Context, q querier, lines []ScrapLine) error {
	if len(lines) == 0 {
		return nil
	}
	ids := make([]int16, len(lines))
	for i, line := range lines {
		ids[i] = int16(line.MaterialID)
	}
	var found int64
	if err := q.QueryRow(ctx, "SELECT count(*) FROM materials WHERE id=ANY($1)", ids).Scan(&found); err != nil {
		return fail(ctx)
	}
	if found != int64(len(ids)) {
		return ErrInvalid
	}
	return nil
}

// samePayload compares a persisted document with a canonical payload, so a replay is
// answered only when it is the same document: the note, the settlement, every model and
// every material, with their quantities and prices.
func samePayload(document Document, payload Payload) bool {
	if document.Note != payload.Note || document.Total != payload.Total ||
		document.PaidCash != payload.PaidCash || document.PaidTransfer != payload.PaidTransfer ||
		document.ReversesPurchaseID != nil || len(document.UsedLines) != len(payload.UsedLines) ||
		len(document.ScrapLines) != len(payload.ScrapLines) {
		return false
	}
	for i, line := range payload.UsedLines {
		persisted := document.UsedLines[i]
		if persisted.Model != line.Model || persisted.Quantity != line.Quantity ||
			persisted.UnitPrice != line.UnitPrice || persisted.Amount != line.Amount {
			return false
		}
	}
	for i, line := range payload.ScrapLines {
		persisted := document.ScrapLines[i]
		if persisted.MaterialID != line.MaterialID || persisted.Kg != line.Kg ||
			persisted.PricePerKg != line.PricePerKg || persisted.Amount != line.Amount {
			return false
		}
	}
	return true
}

// counterOf derives the counter-document of one persisted original: the same lines with
// negated quantity and kg, the same prices, and the negated amounts. A persisted document
// whose amounts are outside the admitted bounds is not a document this domain wrote, so the
// derivation fails closed instead of inventing a reversal the database would refuse.
func counterOf(original Document) (Payload, error) {
	unavailable := func() (Payload, error) { return Payload{}, ErrUnavailable }
	if original.ReversesPurchaseID != nil || original.ReversedBy != nil ||
		original.Reason != "" || len(original.UsedLines)+len(original.ScrapLines) < 1 ||
		len(original.UsedLines) > MaxLines || len(original.ScrapLines) > MaxLines {
		return unavailable()
	}
	total, ok := negateMoney(original.Total, 1)
	if !ok {
		return unavailable()
	}
	cash, ok := negateMoney(original.PaidCash, 0)
	if !ok {
		return unavailable()
	}
	transfer, ok := negateMoney(original.PaidTransfer, 0)
	if !ok {
		return unavailable()
	}
	derived := Payload{Total: total, PaidCash: cash, PaidTransfer: transfer,
		UsedLines:  make([]UsedLine, 0, len(original.UsedLines)),
		ScrapLines: make([]ScrapLine, 0, len(original.ScrapLines))}
	for _, line := range original.UsedLines {
		if line.Quantity < 1 || line.Quantity > MaxQuantity {
			return unavailable()
		}
		amount, ok := usedAmount(-line.Quantity, line.UnitPrice)
		if !ok || amount != negate(line.Amount) {
			return unavailable()
		}
		derived.UsedLines = append(derived.UsedLines, UsedLine{Model: line.Model,
			Quantity: -line.Quantity, UnitPrice: line.UnitPrice, Amount: amount})
	}
	for _, line := range original.ScrapLines {
		milli, ok := milliOf(string(line.Kg))
		if !ok || milli < 1 || milli > maxMilli {
			return unavailable()
		}
		kg, ok := weightOfMilli(-milli)
		if !ok {
			return unavailable()
		}
		amount, ok := scrapAmount(kg, line.PricePerKg)
		if !ok || amount != negate(line.Amount) {
			return unavailable()
		}
		derived.ScrapLines = append(derived.ScrapLines, ScrapLine{MaterialID: line.MaterialID,
			Kg: kg, PricePerKg: line.PricePerKg, Amount: amount})
	}
	return derived, nil
}

// negateMoney renders the negation of a persisted amount. A minimal side is the smallest
// magnitude that side may carry: one cent for the total of an original purchase, zero for a
// paid amount.
func negateMoney(amount Money, minimal int64) (Money, bool) {
	cents, ok := centsOf(string(amount))
	if !ok || cents < minimal || cents < -maxCents || cents > maxCents {
		return "", false
	}
	return moneyOfCents(-cents)
}

// negate renders the negation of a canonical amount without a float.
func negate(amount Money) Money {
	negated, ok := moneyOfCents(mustCents(amount) * -1)
	if !ok {
		return ""
	}
	return negated
}

func mustCents(amount Money) int64 {
	cents, _ := centsOf(string(amount))
	return cents
}

// signOf admits the sign rule of a persisted amount: an original purchase spends money and
// its counter-document returns it, so the sign of the document must be the one its reversal
// binding states.
func signOf(amount Money, reverses *int64) bool {
	cents, ok := centsOf(string(amount))
	if !ok {
		return false
	}
	if reverses == nil {
		return cents > 0
	}
	return cents < 0
}

// positiveMoney admits a persisted price: canonical two-decimal text above zero.
func positiveMoney(amount Money) bool {
	cents, ok := centsOf(string(amount))
	return ok && cents > 0
}

// loadDocument reads one persisted document with both line kinds and the name of every
// material, and fails closed on any persisted shape this domain never wrote.
func loadDocument(ctx context.Context, q querier, id int64) (Document, error) {
	var document Document
	var total, cash, transfer string
	err := q.QueryRow(ctx, `SELECT p.id,p.location_id,p.note,p.total::text,p.paid_cash::text,
  p.paid_transfer::text,p.created_by_account_id,p.created_at,p.reverses_purchase_id,p.reason,
  (SELECT counter.id FROM purchases counter WHERE counter.reverses_purchase_id=p.id)
 FROM purchases p WHERE p.id=$1`, id).Scan(&document.ID, &document.LocationID, &document.Note,
		&total, &cash, &transfer, &document.CreatedByAccountID, &document.CreatedAt,
		&document.ReversesPurchaseID, &document.Reason, &document.ReversedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	if err != nil {
		return Document{}, fail(ctx)
	}
	document.Total, document.PaidCash, document.PaidTransfer = Money(total), Money(cash), Money(transfer)
	if document.ID < 1 || document.LocationID <= warehouseLocationID ||
		document.LocationID > maxBranchLocationID || document.CreatedByAccountID < 1 ||
		document.CreatedAt.IsZero() || !validNote(document.Note) ||
		!signOf(document.Total, document.ReversesPurchaseID) ||
		!settles(document.Total, document.PaidCash, document.PaidTransfer) {
		return Document{}, ErrUnavailable
	}
	if document.ReversesPurchaseID != nil {
		reason, ok := CanonicalReason(document.Reason)
		if !ok || reason != document.Reason || *document.ReversesPurchaseID < 1 ||
			*document.ReversesPurchaseID >= document.ID {
			return Document{}, ErrUnavailable
		}
	} else if document.Reason != "" {
		return Document{}, ErrUnavailable
	}
	// A document is only ever reversed by a later document of this branch, and a
	// counter-document is never reversed itself.
	if document.ReversedBy != nil && (*document.ReversedBy <= document.ID || document.ReversesPurchaseID != nil) {
		return Document{}, ErrUnavailable
	}
	used, err := loadUsedLines(ctx, q, document)
	if err != nil {
		return Document{}, err
	}
	scrap, err := loadScrapLines(ctx, q, document)
	if err != nil {
		return Document{}, err
	}
	if len(used)+len(scrap) < 1 {
		return Document{}, ErrUnavailable
	}
	document.UsedLines, document.ScrapLines = used, scrap
	return document, nil
}

// settles admits the settlement of a persisted document: the two paid amounts close against
// its own total, exactly, and each of them is canonical.
func settles(total, cash, transfer Money) bool {
	totalCents, ok := centsOf(string(total))
	if !ok {
		return false
	}
	cashCents, ok := centsOf(string(cash))
	if !ok {
		return false
	}
	transferCents, ok := centsOf(string(transfer))
	if !ok || cashCents < -maxCents || transferCents < -maxCents ||
		totalCents > maxCents || totalCents < -maxCents {
		return false
	}
	if totalCents < 0 {
		// A counter-document returns money: neither side is positive.
		if cashCents > 0 || transferCents > 0 {
			return false
		}
	} else if cashCents < 0 || transferCents < 0 {
		return false
	}
	return cashCents+transferCents == totalCents
}

// loadUsedLines reads the used lines of one document in ascending model order, re-deriving
// every amount from its persisted quantity and price so a tampered row fails the read.
func loadUsedLines(ctx context.Context, q querier, document Document) ([]UsedLine, error) {
	rows, err := q.Query(ctx, `SELECT model,quantity,unit_price::text,amount::text
 FROM purchase_used_lines WHERE purchase_id=$1 ORDER BY model COLLATE "C"`, document.ID)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	lines := make([]UsedLine, 0, 4)
	for rows.Next() {
		var line UsedLine
		var price, amount string
		if rows.Scan(&line.Model, &line.Quantity, &price, &amount) != nil {
			return nil, fail(ctx)
		}
		line.UnitPrice, line.Amount = Money(price), Money(amount)
		model, ok := CanonicalModel(line.Model)
		expected, derived := usedAmount(line.Quantity, line.UnitPrice)
		if !ok || model != line.Model || !positiveMoney(line.UnitPrice) ||
			line.Quantity == 0 || line.Quantity > MaxQuantity || line.Quantity < -MaxQuantity ||
			!derived || expected != line.Amount ||
			(document.ReversesPurchaseID == nil) != (line.Quantity > 0) ||
			(len(lines) > 0 && line.Model <= lines[len(lines)-1].Model) || len(lines) >= MaxLines {
			return nil, ErrUnavailable
		}
		lines = append(lines, line)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return lines, nil
}

// loadScrapLines reads the scrap lines of one document in ascending material order with the
// name of their material, re-deriving every amount from its persisted weight and price.
func loadScrapLines(ctx context.Context, q querier, document Document) ([]ScrapLine, error) {
	rows, err := q.Query(ctx, `SELECT line.material_id,material.name,line.kg::text,
  line.price_per_kg::text,line.amount::text
 FROM purchase_scrap_lines line
 JOIN materials material ON material.id=line.material_id
 WHERE line.purchase_id=$1 ORDER BY line.material_id`, document.ID)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	lines := make([]ScrapLine, 0, 4)
	for rows.Next() {
		var line ScrapLine
		var kg, price, amount string
		if rows.Scan(&line.MaterialID, &line.Name, &kg, &price, &amount) != nil {
			return nil, fail(ctx)
		}
		line.Kg, line.PricePerKg, line.Amount = Weight(kg), Money(price), Money(amount)
		milli, kgOK := milliOf(kg)
		expected, derived := scrapAmount(line.Kg, line.PricePerKg)
		if !kgOK || milli == 0 || milli > maxMilli || milli < -maxMilli ||
			!positiveMoney(line.PricePerKg) || !derived || expected != line.Amount ||
			line.MaterialID < 1 || line.MaterialID > maxMaterialID ||
			!boundedText(line.Name, 1, maxCategoryText) ||
			// The weight of a line negates with the document, exactly like its amount.
			(document.ReversesPurchaseID == nil) != (milli > 0) ||
			(len(lines) > 0 && line.MaterialID <= lines[len(lines)-1].MaterialID) ||
			len(lines) >= MaxLines {
			return nil, ErrUnavailable
		}
		lines = append(lines, line)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return lines, nil
}

// fundFailure publishes the refusal of a document the fund cannot pay with the two numbers the
// branch acts on: what the fund holds and what the document asks.
//
// This read decides nothing. The document is already refused -- the commit failed with LF003, the
// admission of the ledger is the one that measured the balance under the lock of the branch -- and
// what is read here is only the number the operator needs to act on. It is read from
// `purchase_fund_ledger`, the view that owns the arithmetic: there is one arithmetic and this
// refusal names it (S7), it never repeats it. The guard of 048 states the two numbers in its
// message and nowhere else (MESSAGE, no DETAIL), and the house does not read a decision out of a
// guard's prose, so the balance is asked of the view instead -- the same view the guard refused
// against, in the same instant, with the document already rolled back.
//
// Anything that is not the ledger's own refusal keeps the plain mapping, and a balance that cannot
// be read back is not guessed: the refusal keeps its class, because a refusal without its numbers
// is still a refusal and an outage it is not.
func (s *Store) fundFailure(ctx context.Context, branch int16, requested Money, err error) error {
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "LF003" {
		return mapFailure(ctx, err)
	}
	var balance string
	read := s.pool.QueryRow(ctx, `SELECT coalesce(sum(effective),0)::numeric(12,2)::text
 FROM purchase_fund_ledger WHERE branch_location_id=$1`, branch)
	if read.Scan(&balance) != nil {
		return mapFailure(ctx, err)
	}
	return &FundInsufficient{Balance: Money(balance), Requested: requested}
}

// mapFailure publishes the database's own decision and nothing else: SQLSTATE is the only
// trusted evidence, and cancellation keeps its semantics. LP002 (the settlement), LP003
// (the mirror) and LP005 (the line and sign rules) are refusals this store already derived,
// so reaching them means the request broke a rule the contract publishes as an invalid
// document; LP001 is the branch authority, LP004 the already-reversed document, LP006 the
// purchase fund, which is cash and pays only what its balance holds, and LC001 the freeze of a
// live settlement holding the branch. LF003 is the fund's ledger refusing the movement of this
// document for lack of money: the path that creates the document names the two numbers of that
// refusal through fundFailure, and this is its class.
func mapFailure(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "LP001":
			return ErrForbidden
		// The branch is frozen by a live settlement (LC001, the freeze of 035): the branch closes or
		// waits out its settlement, so this is a conflict the operator acts on and never an outage.
		case "LC001":
			return ErrBranchFrozen
		case "LP002", "LP003", "LP005":
			return ErrInvalid
		case "LP004":
			return ErrAlreadyReversed
		// The fund is cash and it pays what it holds: a purchase paid even partly by
		// transfer, or one beyond the balance of the branch, is the fund's own refusal.
		case "LP006":
			return &FundRefusal{}
		// The ledger of the fund refused the movement of this document: the document asks for
		// more than the fund holds (LF003, the admission of 048). The path that creates the
		// document names the balance and the requested amount through fundFailure; this is the
		// class of the same refusal.
		case "LF003":
			return &FundRefusal{}
		// A refused amount or a refused document shape is the same public refusal, because
		// the database decides it. A foreign key is deliberately not mapped: an unknown
		// material is refused before any line is written, so reaching one means the ledger
		// is not what this domain wrote and the read fails closed.
		case "23514", "22003":
			return ErrInvalid
		// 23505 on the single-reversal index is the same already-reversed refusal reached
		// through a concurrent writer; any other unique violation stays unmapped.
		case "23505":
			if pg.ConstraintName == "purchases_single_reversal" {
				return ErrAlreadyReversed
			}
		}
	}
	return ErrUnavailable
}
