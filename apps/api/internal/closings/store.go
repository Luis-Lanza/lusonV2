package closings

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/catalog"
)

// Store is the settlement store of one installation. Every rule it enforces is either a
// request shape judged before the database is touched or a decision the database itself
// takes (migration 034), which this store reports through a domain error.
type Store struct{ pool *pgxpool.Pool }

// LiveConflict is the refusal of a second live settlement for one branch: open, proposed and
// rejected all keep the branch frozen, so only one of them may exist. The settlement that
// already holds the branch is named, because it is the document the operator has to read or
// close before the branch is settled again; it unwraps to ErrLiveConflict, so a caller that
// only knows the class still recognises it.
type LiveConflict struct{ BranchID, ClosingID int64 }

func (e *LiveConflict) Error() string {
	return "branch " + digits(e.BranchID) + " already has live account settlement " + digits(e.ClosingID)
}

// Unwrap keeps errors.Is(err, ErrLiveConflict) true for a named conflict.
func (e *LiveConflict) Unwrap() error { return ErrLiveConflict }

// Page is one newest-first page of the settlements of one branch plus the total of the branch,
// which is the branch's own history: the total counts every settlement of the branch,
// independent of the requested page, so an empty page beyond the last one is harmless.
type Page struct {
	Page          int
	PageSize      int
	TotalClosings int64
	// Closings are the header projection of each settlement -- the period, the money of the
	// period, the drawer and its three derived numbers -- in cut order, newest first. The count
	// sheet and the proposal rounds belong to the single read of a settlement and are not
	// unfolded by the history.
	Closings []Closing
}

// New returns the settlement store over an existing pool.
func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// fail retains cancellation semantics but never driver/config/SQL details.
func fail(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrUnavailable
}

// checkAccount reuses the provisioned-account binding of every other store: a location id
// in the session is not evidence that this account is assigned to it, enabled and alive.
func checkAccount(ctx context.Context, q querier, actor auth.Identity) error {
	if actor.AccountID < 1 || actor.Location.ID < 1 || actor.Location.ID > MaxBranchID {
		return ErrForbidden
	}
	var provisioned bool
	if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM auth_accounts
 WHERE id=$1 AND location_id=$2 AND enabled AND deleted_at IS NULL)`,
		int64(actor.AccountID), int16(actor.Location.ID)).Scan(&provisioned); err != nil {
		return fail(ctx)
	}
	if !provisioned {
		return ErrForbidden
	}
	return nil
}

// checkBranch admits the branch of a settlement: the warehouse is never a branch, an
// unknown location does not exist, and a retired one is refused by name (LC017).
func checkBranch(ctx context.Context, q querier, branchID int64) error {
	if branchID < firstBranchID || branchID > MaxBranchID {
		return ErrInvalid
	}
	var retired bool
	err := q.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM locations WHERE id=$1`,
		int16(branchID)).Scan(&retired)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fail(ctx)
	}
	if retired {
		return &RetiredBranch{BranchID: branchID}
	}
	return nil
}

// ConfigureCommission writes the commission rate of one branch: the percentage the
// settlement of that branch pays on its period sales total (S6). Only the warehouse writes
// it, and the database refuses any other actor with its own SQLSTATE (LC015).
func (s *Store) ConfigureCommission(ctx context.Context, actor auth.Identity, branchID int64, rate Percent) (Settings, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Settings{}, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return Settings{}, ErrForbidden
	}
	canonical, err := ParsePercent(string(rate))
	if err != nil {
		return Settings{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAccount(ctx, s.pool, actor); err != nil {
		return Settings{}, err
	}
	if err := checkBranch(ctx, s.pool, branchID); err != nil {
		return Settings{}, err
	}
	var settings Settings
	var stored string
	// updated_at is the trigger's own fact; it is refreshed on every write.
	err = s.pool.QueryRow(ctx, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,updated_by_account_id)
 VALUES($1,$2,$3)
 ON CONFLICT (branch_location_id) DO UPDATE
 SET commission_rate_percent=EXCLUDED.commission_rate_percent,
     updated_by_account_id=EXCLUDED.updated_by_account_id, updated_at=now()
 RETURNING branch_location_id, commission_rate_percent::text`,
		int16(branchID), string(canonical), int64(actor.AccountID)).
		Scan(&settings.BranchID, &stored)
	if err != nil {
		return Settings{}, mapFailure(ctx, err)
	}
	if settings.CommissionRatePercent, err = ParsePercent(stored); err != nil {
		return Settings{}, ErrUnavailable
	}
	return settings, nil
}

// ReadSettings reads the commission rate of one branch. The warehouse reads every branch
// and a branch reads only its own; a branch without a configured rate has no setting.
func (s *Store) ReadSettings(ctx context.Context, actor auth.Identity, branchID int64) (Settings, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Settings{}, ErrUnavailable
	}
	if err := checkAccount(ctx, s.pool, actor); err != nil {
		return Settings{}, err
	}
	if !warehouseAdmin(actor) && int64(actor.Location.ID) != branchID {
		return Settings{}, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var settings Settings
	var stored string
	err := s.pool.QueryRow(ctx, `SELECT branch_location_id, commission_rate_percent::text
 FROM branch_settings WHERE branch_location_id=$1`, int16(branchID)).Scan(&settings.BranchID, &stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return Settings{}, ErrNotFound
	}
	if err != nil {
		return Settings{}, fail(ctx)
	}
	if settings.CommissionRatePercent, err = ParsePercent(stored); err != nil {
		return Settings{}, ErrUnavailable
	}
	return settings, nil
}

// Open opens the next settlement of one branch. It supplies nothing of its own: the
// database's admission trigger decides the period start, the cut instant, the inherited
// fund and the expected snapshot, and it freezes the branch. A second live settlement of
// the same branch is the database's unique index, reported here as a conflict.
func (s *Store) Open(ctx context.Context, actor auth.Identity, branchID int64) (Closing, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Closing{}, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return Closing{}, ErrForbidden
	}
	if branchID < firstBranchID || branchID > MaxBranchID {
		return Closing{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Closing{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if err := checkAccount(ctx, tx, actor); err != nil {
		return Closing{}, err
	}
	if err := checkBranch(ctx, tx, branchID); err != nil {
		return Closing{}, err
	}
	var id int64
	// period_start is supplied only because the column is NOT NULL: the admission trigger
	// overwrites it with the closure instant of the previous settlement, or with the cut
	// instant it takes itself. The caller has no value to promise here.
	//
	// The insert runs in a savepoint, so the unique index of the one live settlement per
	// branch can be answered with the settlement that already holds the branch: a failed
	// statement aborts its own transaction, and the row the operator has to read is named
	// from the transaction that is still open around it.
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return Closing{}, fail(ctx)
	}
	err = savepoint.QueryRow(ctx, `INSERT INTO branch_closings(branch_location_id,period_start,opened_by_account_id)
 VALUES($1,now(),$2) RETURNING id`, int16(branchID), int64(actor.AccountID)).Scan(&id)
	if err != nil {
		if err := savepoint.Rollback(ctx); err != nil {
			return Closing{}, fail(ctx)
		}
		return Closing{}, mapOpenFailure(ctx, tx, err, branchID)
	}
	if err := savepoint.Commit(ctx); err != nil {
		return Closing{}, fail(ctx)
	}
	closing, err := loadClosing(ctx, tx, id)
	if err != nil {
		return Closing{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Closing{}, fail(ctx)
	}
	return closing, nil
}

// Read reads one settlement with its count sheet and its proposal rounds. A settlement of
// another branch is not part of this branch's ledger: it is not found, exactly like the
// history of another branch's documents.
func (s *Store) Read(ctx context.Context, actor auth.Identity, id int64) (Closing, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Closing{}, ErrUnavailable
	}
	if id < 1 {
		return Closing{}, ErrNotFound
	}
	if err := checkAccount(ctx, s.pool, actor); err != nil {
		return Closing{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	closing, err := loadClosing(ctx, s.pool, id)
	if err != nil {
		return Closing{}, err
	}
	if !warehouseAdmin(actor) && closing.BranchID != int64(actor.Location.ID) {
		return Closing{}, ErrNotFound
	}
	return closing, nil
}

// List reads one newest-first page of the settlements of one branch: its own history, from the
// most recent closure instant backwards, with the total of the branch beside the page. It is the
// same projection the single read publishes -- the period, the money of the period, the drawer and
// its three derived numbers -- so a history row and the document it summarises can never disagree;
// the count sheet and the proposal rounds belong to the single read and are not unfolded here.
//
// A branch reads only its own history: another branch is forbidden, exactly like a setting of
// another branch. The warehouse reads every branch. An unknown branch does not exist and a retired
// one is refused by name, exactly like an opening.
func (s *Store) List(ctx context.Context, actor auth.Identity, branchID int64, page, pageSize int) (Page, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Page{}, ErrUnavailable
	}
	if branchID < firstBranchID || branchID > MaxBranchID || !validHistoryPage(page, pageSize) {
		return Page{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAccount(ctx, s.pool, actor); err != nil {
		return Page{}, err
	}
	if !warehouseAdmin(actor) && int64(actor.Location.ID) != branchID {
		return Page{}, ErrForbidden
	}
	if err := checkBranch(ctx, s.pool, branchID); err != nil {
		return Page{}, err
	}
	result := Page{Page: page, PageSize: pageSize, Closings: make([]Closing, 0, pageSize)}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM branch_closings
 WHERE branch_location_id=$1`, int16(branchID)).Scan(&result.TotalClosings); err != nil {
		return Page{}, fail(ctx)
	}
	rows, err := s.pool.Query(ctx, `SELECT `+closingHeaderColumns+`
 FROM branch_closings c JOIN locations l ON l.id=c.branch_location_id
 WHERE c.branch_location_id=$1 ORDER BY c.cut_at DESC, c.id DESC LIMIT $2 OFFSET $3`,
		int16(branchID), pageSize, int64(page-1)*int64(pageSize))
	if err != nil {
		return Page{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		closing, err := scanClosing(ctx, rows)
		if err != nil {
			return Page{}, err
		}
		// The rows are the database's own order: newest cut instant first, and the newer
		// settlement first when two share one instant. A page that breaks it is a chart this
		// domain never wrote, so it is never published as a history.
		if previous := len(result.Closings) - 1; previous >= 0 &&
			(result.Closings[previous].CutAt.Before(closing.CutAt) ||
				(result.Closings[previous].CutAt.Equal(closing.CutAt) &&
					result.Closings[previous].ID <= closing.ID)) {
			return Page{}, ErrUnavailable
		}
		result.Closings = append(result.Closings, closing)
	}
	if rows.Err() != nil {
		return Page{}, fail(ctx)
	}
	return result, nil
}

// validHistoryPage admits the read contract's page: one to a million, with one of the frozen page
// sizes of every history of this installation.
func validHistoryPage(page, pageSize int) bool {
	if page < 1 || page > 1_000_000 {
		return false
	}
	return pageSize == 10 || pageSize == 25 || pageSize == 50
}

// Count records what the admin counted: the only quantity a caller supplies. A line of a
// variant the system did not have is added with the database's own snapshot of zero, and a
// line that already exists only changes its counted quantity. The database refuses a write
// while the branch is deciding or after the closure (LC004).
func (s *Store) Count(ctx context.Context, actor auth.Identity, id int64, counted []Counted) (Closing, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Closing{}, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return Closing{}, ErrForbidden
	}
	if id < 1 {
		return Closing{}, ErrNotFound
	}
	lines, err := canonicalCount(counted)
	if err != nil {
		return Closing{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Closing{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if err := checkAccount(ctx, tx, actor); err != nil {
		return Closing{}, err
	}
	// The header is locked before the sheet is judged, so a proposal cannot slip between the
	// state check and the write, and a refused line leaves the sheet exactly as it was.
	var status string
	err = tx.QueryRow(ctx, `SELECT status FROM branch_closings WHERE id=$1 FOR UPDATE`, id).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return Closing{}, ErrNotFound
	}
	if err != nil {
		return Closing{}, fail(ctx)
	}
	if !Status(status).Held() {
		return Closing{}, ErrCountFrozen
	}
	if err := checkVariants(ctx, tx, lines); err != nil {
		return Closing{}, err
	}
	for _, line := range lines {
		// expected_quantity is supplied only because the column is NOT NULL on insert: the
		// admission trigger overwrites it with its own snapshot of the cut instant, which is
		// what makes counting not blind. The conflict branch leaves it untouched, so only the
		// counted quantity of an existing line ever moves.
		if _, err := tx.Exec(ctx, `INSERT INTO closing_count_lines(closing_id,variant_id,expected_quantity,counted_quantity)
 VALUES($1,$2,0,$3)
 ON CONFLICT (closing_id,variant_id) DO UPDATE SET counted_quantity=EXCLUDED.counted_quantity`,
			id, int32(line.VariantID), line.Quantity); err != nil {
			return Closing{}, mapFailure(ctx, err)
		}
	}
	closing, err := loadClosing(ctx, tx, id)
	if err != nil {
		return Closing{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Closing{}, mapFailure(ctx, err)
	}
	return closing, nil
}

// SaveCash saves the draft of the drawer while the warehouse holds the settlement: what was
// counted, the contribution, the fund left behind and the observation, and nothing else. The
// cash sales and the cash expenses of the period are the ledgers' own facts, so no draft can
// state them; the period snapshots and the frozen rate belong to the proposal and the
// closure (migration 034).
func (s *Store) SaveCash(ctx context.Context, actor auth.Identity, id int64, draft CashDraft) (Closing, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Closing{}, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return Closing{}, ErrForbidden
	}
	if id < 1 {
		return Closing{}, ErrNotFound
	}
	canonical, err := canonicalCash(draft)
	if err != nil {
		return Closing{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Closing{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if err := checkAccount(ctx, tx, actor); err != nil {
		return Closing{}, err
	}
	var status string
	err = tx.QueryRow(ctx, `SELECT status FROM branch_closings WHERE id=$1 FOR UPDATE`, id).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return Closing{}, ErrNotFound
	}
	if err != nil {
		return Closing{}, fail(ctx)
	}
	if !Status(status).Held() {
		return Closing{}, ErrStateConflict
	}
	if _, err := tx.Exec(ctx, `UPDATE branch_closings SET counted_cash=$2,contributed_cash=$3,
  closing_cash=$4,observation=$5 WHERE id=$1`,
		id, nullable(canonical.CountedCash), string(canonical.ContributedCash),
		nullable(canonical.ClosingCash), canonical.Observation); err != nil {
		return Closing{}, mapFailure(ctx, err)
	}
	closing, err := loadClosing(ctx, tx, id)
	if err != nil {
		return Closing{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Closing{}, mapFailure(ctx, err)
	}
	return closing, nil
}

// RecordExpense records one small expense the branch paid out of its own till (S12): the
// amount and the description, recorded by the branch account that owns the till, as it happens
// and with no previous approval. The row is appended to the branch's ledger and never attached
// to a settlement, because the settlement that covers it is the one whose window contains its
// instant; a recorded expense is immutable and is corrected by its opposite movement.
//
// The refusals around it are the domain's own: a frozen branch cannot spend out of the till being
// counted (the database's LC001, published as ErrBranchFrozen), the ledger refuses a movement that
// is not the recording branch's own (LC011, published as ErrNotBranchExpense), and the warehouse is
// refused here, because a 'gasto' row states the branch and the actor of the movement together and
// deriving that branch from the session would make the ledger's own comparison always agree.
func (s *Store) RecordExpense(ctx context.Context, actor auth.Identity, amount Money, description string) (Expense, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Expense{}, ErrUnavailable
	}
	canonicalAmount, err := ParseAmount(string(amount))
	if err != nil {
		return Expense{}, err
	}
	// An expense of zero is not an expense: the ledger admits a positive amount only, and the
	// same rule is judged here instead of letting the row CHECK answer it.
	if cents, ok := amountCents(canonicalAmount); !ok || cents < 1 {
		return Expense{}, ErrInvalid
	}
	canonicalDescription, ok := CanonicalDescription(description)
	if !ok {
		return Expense{}, ErrInvalid
	}
	// The warehouse has no till of its own: it never records an expense, and the refusal is the same
	// class the ledger raises for a movement that is not the recording branch's own (LC011).
	if actor.Location.ID < firstBranchID {
		return Expense{}, ErrNotBranchExpense
	}
	// A session still forced to change its password does not move the branch's money, exactly like
	// the account that decides the settlement.
	if actor.MustChangePassword {
		return Expense{}, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAccount(ctx, s.pool, actor); err != nil {
		return Expense{}, err
	}
	var expense Expense
	var stored string
	// The branch is the account's own location and never a caller value: a branch records in
	// its own till, and 'gasto' rows are never attached to a settlement.
	err = s.pool.QueryRow(ctx, `INSERT INTO branch_cash_movements(
  branch_location_id,kind,amount,description,created_by_account_id)
 VALUES($1,'gasto',$2,$3,$4)
 RETURNING id,branch_location_id,amount::text,description,occurred_at,created_by_account_id`,
		int16(actor.Location.ID), string(canonicalAmount), canonicalDescription,
		int64(actor.AccountID)).
		Scan(&expense.ID, &expense.BranchID, &stored, &expense.Description, &expense.OccurredAt,
			&expense.CreatedByAccountID)
	if err != nil {
		return Expense{}, mapFailure(ctx, err)
	}
	if expense.Amount, err = ParseAmount(stored); err != nil {
		return Expense{}, ErrUnavailable
	}
	if expense.ID < 1 || expense.BranchID < firstBranchID || expense.BranchID > MaxBranchID ||
		expense.CreatedByAccountID < 1 || expense.OccurredAt.IsZero() {
		return Expense{}, ErrUnavailable
	}
	if canonical, ok := CanonicalDescription(expense.Description); !ok || canonical != expense.Description {
		return Expense{}, ErrUnavailable
	}
	return expense, nil
}

// checkVariants refuses a sheet that names a variant outside the catalogue before any line
// is written: an unknown variant is a request error, and the whole sheet is written or none
// of it is.
func checkVariants(ctx context.Context, q querier, lines []Counted) error {
	ids := make([]int32, len(lines))
	for i, line := range lines {
		ids[i] = int32(line.VariantID)
	}
	var known int64
	if err := q.QueryRow(ctx, `SELECT count(*) FROM catalog_variants variant
 JOIN catalog_entries entry ON entry.id=variant.catalog_entry_id
 WHERE variant.id=ANY($1) AND entry.deleted_at IS NULL`, ids).Scan(&known); err != nil {
		return fail(ctx)
	}
	if known != int64(len(lines)) {
		return ErrInvalid
	}
	return nil
}

// nullable renders an optional amount as the SQL value of its column: the empty text is a
// cash the admin has not counted yet, which is stored as NULL.
func nullable(amount *Money) any {
	if amount == nil {
		return nil
	}
	return string(*amount)
}

// Propose is the warehouse's offer. In one transaction it freezes the period numbers from
// the sale ledger of the branch — the sales total that is the commission base, the cash
// amount and the card and transfer amounts — inserts the round that carries the whole offer
// and flips the settlement to proposed, where the database freezes the configured rate.
//
// The round is mandatory and ordered before the state change: the database refuses a closure
// whose latest round is not accepted (LC016), so nothing could ever close without it. The
// count must be complete and the drawer counted, because the database refuses an incomplete
// closure (LC006) and a settlement whose round the branch had accepted could no longer be
// corrected: no transition leaves a proposed settlement with an accepted round.
func (s *Store) Propose(ctx context.Context, actor auth.Identity, id int64) (Closing, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Closing{}, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return Closing{}, ErrForbidden
	}
	if id < 1 {
		return Closing{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Closing{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if err := checkAccount(ctx, tx, actor); err != nil {
		return Closing{}, err
	}
	var branch int16
	var status string
	var periodStart, cutAt time.Time
	var countedCash, closingCash *string
	var draft CashDraft
	err = tx.QueryRow(ctx, `SELECT branch_location_id,status,period_start,cut_at,
  counted_cash::text,contributed_cash::text,closing_cash::text,observation
 FROM branch_closings WHERE id=$1 FOR UPDATE`, id).Scan(&branch, &status, &periodStart, &cutAt,
		&countedCash, &draft.ContributedCash, &closingCash, &draft.Observation)
	if errors.Is(err, pgx.ErrNoRows) {
		return Closing{}, ErrNotFound
	}
	if err != nil {
		return Closing{}, fail(ctx)
	}
	if !Status(status).Held() {
		return Closing{}, ErrStateConflict
	}
	// The sheet must be complete and the drawer counted: the offer states both, and the
	// closure admits neither a pending variant nor a missing amount (LC006).
	pending, err := pendingVariant(ctx, tx, id)
	if err == nil {
		return Closing{}, &CountPending{VariantID: pending}
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Closing{}, fail(ctx)
	}
	if countedCash == nil || closingCash == nil {
		return Closing{}, &CashNotStated{}
	}
	counted, fund := Money(*countedCash), Money(*closingCash)
	draft.CountedCash, draft.ClosingCash = &counted, &fund
	if err := checkFund(counted, draft.ContributedCash, fund); err != nil {
		return Closing{}, err
	}
	// The money of the period is the ledgers', never the admin's reading: the sales total that
	// is the commission base is the sum of the sold subtotals, the cash collected is the cash
	// amount of those same sales, and the cash expenses are the ones the branch recorded as
	// they happened (S8, S12). All of them over the same window, so they describe one period.
	totals, err := periodTotals(ctx, tx, branch, periodStart, cutAt)
	if err != nil {
		return Closing{}, err
	}
	rate, err := configuredRate(ctx, tx, branch)
	if err != nil {
		return Closing{}, err
	}
	commission, err := Commission(totals.salesTotal, rate)
	if err != nil {
		return Closing{}, ErrUnavailable
	}
	lines, err := loadCountLines(ctx, tx, id)
	if err != nil {
		return Closing{}, err
	}
	payload := ProposalPayload{
		PeriodStart: periodStart, CutAt: cutAt,
		SalesTotal: totals.salesTotal, CommissionRatePercent: rate, CommissionAmount: commission,
		CashSales: totals.cash, CashExpenses: totals.expenses,
		CardTotal: totals.card, TransferTotal: totals.transfer, QRTotal: totals.qr,
		CountedCash: draft.CountedCash, ContributedCash: draft.ContributedCash,
		ClosingCash: draft.ClosingCash, Observation: draft.Observation,
		CountLines: make([]ProposalCountLine, 0, len(lines)),
	}
	for _, line := range lines {
		if line.CountedQuantity == nil {
			return Closing{}, &CountPending{VariantID: line.VariantID}
		}
		payload.CountLines = append(payload.CountLines, ProposalCountLine{VariantID: line.VariantID,
			ExpectedQuantity: line.ExpectedQuantity, CountedQuantity: *line.CountedQuantity})
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return Closing{}, ErrUnavailable
	}
	// The round is created before the state change the database requires it for, and the
	// database numbers it: 'round' is supplied only because the column is NOT NULL.
	if _, err := tx.Exec(ctx, `INSERT INTO closing_proposals(closing_id,round,proposed_payload,proposed_by_account_id)
 VALUES($1,1,$2::jsonb,$3)`, id, string(encoded), int64(actor.AccountID)); err != nil {
		return Closing{}, mapFailure(ctx, err)
	}
	// The proposed transition is the database's for the sale side of the offer: it records the
	// sale totals, the cash of the period and the commission from the frozen rate, and freezes
	// the rate. The expenses of the period are the branch's own ledger facts, which the database
	// does not read here, so they are written in the same statement that moves the state machine.
	//
	// The transition runs in a savepoint so a refusal can be read back: LC019 is a variant whose
	// counted quantity disappeared between the store's own reads of the sheet and this statement,
	// and the pending line is read from the sheet instead of the message the trigger composed.
	transition, err := tx.Begin(ctx)
	if err != nil {
		return Closing{}, fail(ctx)
	}
	if _, err := transition.Exec(ctx, `UPDATE branch_closings SET status='proposed',cash_expenses=$2
 WHERE id=$1 AND status IN ('open','rejected')`, id, string(totals.expenses)); err != nil {
		if rollback := transition.Rollback(ctx); rollback != nil {
			return Closing{}, fail(ctx)
		}
		return Closing{}, mapProposalFailure(ctx, tx, err, id)
	}
	if err := transition.Commit(ctx); err != nil {
		return Closing{}, fail(ctx)
	}
	closing, err := loadClosing(ctx, tx, id)
	if err != nil {
		return Closing{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Closing{}, mapFailure(ctx, err)
	}
	return closing, nil
}

// periodTotals reads the money of one period from the ledgers: the sales total that is the
// commission base (the sum of the sold subtotals, S6), the cash the branch collected, the
// card, transfer and QR amounts of the same sales (S13), and the cash expenses the branch
// recorded as they happened (S12). One statement, so every number describes the same window
// of the same transaction, and both the proposal and the closure call it, so an offered
// period can never differ from the closed one.
func periodTotals(ctx context.Context, q querier, branch int16, from, to time.Time) (periodTotalsResult, error) {
	var result periodTotalsResult
	var total, cash, card, transfer, qr, expenses string
	err := q.QueryRow(ctx, `WITH settled AS (
    SELECT id,cash_amount,card_amount,transfer_amount,qr_amount FROM sales
    WHERE branch_location_id=$1 AND created_at >= $2 AND created_at < $3
)
 SELECT coalesce((SELECT sum(line.subtotal) FROM sale_lines line
        JOIN settled sale ON sale.id=line.sale_id),0)::numeric(12,2)::text,
       coalesce((SELECT sum(sale.cash_amount) FROM settled sale),0)::numeric(12,2)::text,
       coalesce((SELECT sum(sale.card_amount) FROM settled sale),0)::numeric(12,2)::text,
       coalesce((SELECT sum(sale.transfer_amount) FROM settled sale),0)::numeric(12,2)::text,
       coalesce((SELECT sum(sale.qr_amount) FROM settled sale),0)::numeric(12,2)::text,
       coalesce((SELECT sum(expense.amount) FROM branch_cash_movements expense
        WHERE expense.branch_location_id=$1 AND expense.kind='gasto'
          AND expense.occurred_at >= $2 AND expense.occurred_at < $3),0)::numeric(12,2)::text`,
		branch, from, to).Scan(&total, &cash, &card, &transfer, &qr, &expenses)
	if err != nil {
		return periodTotalsResult{}, fail(ctx)
	}
	result.salesTotal, result.cash, result.card, result.transfer, result.qr, result.expenses =
		Money(total), Money(cash), Money(card), Money(transfer), Money(qr), Money(expenses)
	for _, amount := range []Money{result.salesTotal, result.cash, result.card, result.transfer,
		result.qr, result.expenses} {
		if _, ok := amountCents(amount); !ok {
			return periodTotalsResult{}, ErrUnavailable
		}
	}
	return result, nil
}

// periodTotalsResult is the money of one settled period: the commission base, the collection
// by payment method -- cash in the drawer, card, transfer and QR outside it -- and the
// expenses the branch paid out of the drawer.
type periodTotalsResult struct{ salesTotal, cash, card, transfer, qr, expenses Money }

// configuredRate reads the rate the branch is configured with. A branch without one cannot
// be proposed (S6, LC003).
func configuredRate(ctx context.Context, q querier, branch int16) (Percent, error) {
	var stored string
	err := q.QueryRow(ctx, `SELECT commission_rate_percent::text FROM branch_settings
 WHERE branch_location_id=$1`, branch).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNoCommissionRate
	}
	if err != nil {
		return "", fail(ctx)
	}
	rate, err := ParsePercent(stored)
	if err != nil {
		return "", ErrUnavailable
	}
	return rate, nil
}

// Decide records the branch's answer to the pending round. Any enabled account of the branch
// decides, and only the branch decides: neither the warehouse nor another branch can. A
// rejection states its reason, applies nothing, keeps the branch frozen and hands the
// settlement back to the warehouse for correction; an acceptance is the only thing that
// closes, and the database's own closure trigger then applies the counted stock and writes
// the cash ledger in the same transaction (S14, S17).
func (s *Store) Decide(ctx context.Context, actor auth.Identity, id int64, decision Decision, reason string) (Closing, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Closing{}, ErrUnavailable
	}
	if decision != DecisionAccepted && decision != DecisionRejected {
		return Closing{}, ErrInvalid
	}
	var canonicalReason string
	if decision == DecisionRejected {
		var ok bool
		if canonicalReason, ok = CanonicalReason(reason); !ok {
			return Closing{}, ErrInvalid
		}
	} else if reason != "" {
		// An acceptance never carries a rejection reason: the two decisions are exclusive.
		return Closing{}, ErrInvalid
	}
	if id < 1 {
		return Closing{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Closing{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if err := checkAccount(ctx, tx, actor); err != nil {
		return Closing{}, err
	}
	var branch int16
	var status string
	var periodStart, cutAt time.Time
	var rate *string
	var countedCash, closingCash *string
	var contributed CashDraft
	err = tx.QueryRow(ctx, `SELECT branch_location_id,status,period_start,cut_at,
  commission_rate_percent::text,counted_cash::text,contributed_cash::text,closing_cash::text
 FROM branch_closings WHERE id=$1 FOR UPDATE`, id).Scan(&branch, &status, &periodStart, &cutAt,
		&rate, &countedCash, &contributed.ContributedCash, &closingCash)
	if errors.Is(err, pgx.ErrNoRows) {
		return Closing{}, ErrNotFound
	}
	if err != nil {
		return Closing{}, fail(ctx)
	}
	// Only an account of the branch decides, and a session still forced to change its
	// password does not act. The database refuses the same actors with LC010.
	if int64(actor.Location.ID) != int64(branch) || actor.MustChangePassword {
		return Closing{}, ErrForbidden
	}
	if Status(status) != StatusProposed {
		return Closing{}, ErrStateConflict
	}
	var roundID int64
	var roundNumber int
	err = tx.QueryRow(ctx, `SELECT id,round FROM closing_proposals
 WHERE closing_id=$1 AND decision IS NULL`, id).Scan(&roundID, &roundNumber)
	if errors.Is(err, pgx.ErrNoRows) {
		return Closing{}, ErrStateConflict
	}
	if err != nil {
		return Closing{}, fail(ctx)
	}
	// The decision is a version of its own: the guard refuses to rewrite a decided round, so
	// a rejection is appended and never replaces the offer it answered.
	if _, err := tx.Exec(ctx, `UPDATE closing_proposals
 SET decision=$2,decision_reason=$3,decided_by_account_id=$4 WHERE id=$1`,
		roundID, string(decision), canonicalReason, int64(actor.AccountID)); err != nil {
		return Closing{}, mapFailure(ctx, err)
	}
	if decision == DecisionRejected {
		// A rejection applies nothing and unfreezes nothing: it only returns the settlement to
		// the warehouse, which is what reopens the count sheet and the cash draft (S14).
		if _, err := tx.Exec(ctx, `UPDATE branch_closings SET status='rejected' WHERE id=$1`, id); err != nil {
			return Closing{}, mapFailure(ctx, err)
		}
	} else {
		// The closure states the count and the drawer, so the offer it accepts must state both.
		pending, err := pendingVariant(ctx, tx, id)
		if err == nil {
			return Closing{}, &CountPending{VariantID: pending}
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return Closing{}, fail(ctx)
		}
		if countedCash == nil || closingCash == nil {
			return Closing{}, &CashNotStated{}
		}
		counted, fund := Money(*countedCash), Money(*closingCash)
		if err := checkFund(counted, contributed.ContributedCash, fund); err != nil {
			return Closing{}, err
		}
		if rate == nil {
			// A proposed settlement always states the rate it settles: without it the closure
			// could not be described, so this is a database shape this domain never wrote.
			return Closing{}, ErrUnavailable
		}
		// The offer stated at proposal is what the branch accepted, and the closing
		// transition freezes it: recomputing the period here would let a closed settlement
		// disagree with the numbers the branch approved, so this statement only moves the
		// state machine. The database applies the counted stock and writes the cash ledger of
		// the drawer in the same transaction.
		//
		// The transition runs in a savepoint so its refusal can be read back: the closure's
		// stock rules name a variant, and that variant is the one the sheet and the balances
		// refuse, not a phrase parsed out of a message.
		transition, err := tx.Begin(ctx)
		if err != nil {
			return Closing{}, fail(ctx)
		}
		if _, err := transition.Exec(ctx, `UPDATE branch_closings SET status='closed'
 WHERE id=$1 AND status='proposed'`, id); err != nil {
			if rollback := transition.Rollback(ctx); rollback != nil {
				return Closing{}, fail(ctx)
			}
			return Closing{}, mapClosureFailure(ctx, tx, err, id, branch)
		}
		if err := transition.Commit(ctx); err != nil {
			return Closing{}, fail(ctx)
		}
	}
	closing, err := loadClosing(ctx, tx, id)
	if err != nil {
		return Closing{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Closing{}, mapFailure(ctx, err)
	}
	return closing, nil
}

// ProposeCorrection records the warehouse's correction of a closed settlement (S16): the values
// it corrects and the reason it corrects them for. A correction is the warehouse's offer and a
// decision of the branch, exactly like a round of a live settlement, so this only appends the
// pending correction: nothing is applied and nothing is decided until the branch answers it.
//
// Only the warehouse proposes one. The answer a branch gets for a settlement of another branch is
// the same refusal it gets for its own: a branch never proposes a correction (LC012), because a
// correction is the warehouse's reading of the cut it performed.
func (s *Store) ProposeCorrection(ctx context.Context, actor auth.Identity, closingID int64,
	offer CorrectionOffer, reason string) (Correction, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Correction{}, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return Correction{}, ErrForbidden
	}
	if closingID < 1 {
		return Correction{}, ErrNotFound
	}
	canonicalReason, ok := CanonicalReason(reason)
	if !ok {
		return Correction{}, ErrInvalid
	}
	payload, err := canonicalCorrection(offer)
	if err != nil {
		return Correction{}, err
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return Correction{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Correction{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if err := checkAccount(ctx, tx, actor); err != nil {
		return Correction{}, err
	}
	// The insert runs in a savepoint, so a refusal can be answered with the settlement it was
	// proposed for: a failed statement aborts its own transaction, and the row the warehouse has
	// to look at is read from the transaction still open around it.
	insert, err := tx.Begin(ctx)
	if err != nil {
		return Correction{}, fail(ctx)
	}
	var correctionID int64
	err = insert.QueryRow(ctx, `INSERT INTO closing_corrections(closing_id,reason,payload,proposed_by_account_id)
 VALUES($1,$2,$3::jsonb,$4) RETURNING id`, closingID, canonicalReason, string(encoded),
		int64(actor.AccountID)).Scan(&correctionID)
	if err != nil {
		if rollback := insert.Rollback(ctx); rollback != nil {
			return Correction{}, fail(ctx)
		}
		return Correction{}, mapCorrectionFailure(ctx, tx, err, closingID)
	}
	if err := insert.Commit(ctx); err != nil {
		return Correction{}, fail(ctx)
	}
	correction, err := loadCorrection(ctx, tx, correctionID)
	if err != nil {
		return Correction{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Correction{}, mapFailure(ctx, err)
	}
	return correction, nil
}

// DecideCorrection records the branch's answer to the pending correction of its closed
// settlement. Any enabled account of the branch decides, and only the branch decides: neither the
// warehouse nor another branch can (LC014).
//
// A rejection states its reason and applies nothing, exactly like the rejection of a round; an
// acceptance is the only thing that applies the deltas the correction states, and the database
// does it in the same transaction, so a refused acceptance leaves neither a delta nor a decision
// behind (S16).
func (s *Store) DecideCorrection(ctx context.Context, actor auth.Identity, correctionID int64,
	decision Decision, reason string) (Correction, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Correction{}, ErrUnavailable
	}
	if decision != DecisionAccepted && decision != DecisionRejected {
		return Correction{}, ErrInvalid
	}
	var canonicalReason string
	if decision == DecisionRejected {
		var ok bool
		if canonicalReason, ok = CanonicalReason(reason); !ok {
			return Correction{}, ErrInvalid
		}
	} else if reason != "" {
		// An acceptance never carries a rejection reason: the two decisions are exclusive.
		return Correction{}, ErrInvalid
	}
	if correctionID < 1 {
		return Correction{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Correction{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if err := checkAccount(ctx, tx, actor); err != nil {
		return Correction{}, err
	}
	var branch int16
	var status string
	// The correction is locked before it is judged, so two accounts of the same branch cannot
	// decide it twice and a refusal leaves the row exactly as it was.
	err = tx.QueryRow(ctx, `SELECT header.branch_location_id,correction.status
 FROM closing_corrections correction JOIN branch_closings header ON header.id=correction.closing_id
 WHERE correction.id=$1 FOR UPDATE OF correction`, correctionID).Scan(&branch, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return Correction{}, ErrNotFound
	}
	if err != nil {
		return Correction{}, fail(ctx)
	}
	// Only an account of the branch that owns the settlement decides, and a session still forced
	// to change its password does not act. The database refuses the same actors with LC014.
	if int64(actor.Location.ID) != int64(branch) || actor.MustChangePassword {
		return Correction{}, ErrForbidden
	}
	if CorrectionStatus(status) != CorrectionProposed {
		return Correction{}, ErrCorrectionDecided
	}
	// The decision is one version of its own: the database refuses to rewrite a decided
	// correction, so a rejection is appended and never replaces the correction it answered. The
	// acceptance is what makes the database journal the deltas the correction states.
	if _, err := tx.Exec(ctx, `UPDATE closing_corrections SET status=$2,decision_reason=$3,
 decided_by_account_id=$4 WHERE id=$1 AND status='proposed'`, correctionID, string(decision),
		canonicalReason, int64(actor.AccountID)); err != nil {
		return Correction{}, mapFailure(ctx, err)
	}
	correction, err := loadCorrection(ctx, tx, correctionID)
	if err != nil {
		return Correction{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Correction{}, mapFailure(ctx, err)
	}
	return correction, nil
}

// closingHeaderColumns is the persisted header of one settlement, in the order scanClosing
// reads it. One projection, so the single read, the history and the derived numbers can never
// disagree with each other.
//
// The two trailing columns are the journal of accepted corrections (036, 040): the deltas the
// branch accepted for the counted cash and for the fund. They are read here, with the header, so
// every read of a settlement -- the single document and each row of its history -- derives the
// same corrected numbers from the same signed ones. The stock and the commission are journalled
// too, but neither of them changes a number of this projection: the stock is the branch's
// inventory and the commission is published beside the corrections that changed it.
const closingHeaderColumns = `c.id,c.branch_location_id,l.name,c.status,
  c.period_start,c.cut_at,c.closed_at,coalesce(c.commission_rate_percent::text,''),
  c.opening_cash::text,c.cash_sales::text,c.cash_expenses::text,c.sales_total::text,
  c.commission_amount::text,c.card_total::text,c.transfer_total::text,c.qr_total::text,
  c.counted_cash::text,c.contributed_cash::text,c.closing_cash::text,c.observation,
  c.opened_by_account_id,
  coalesce((SELECT sum(effect.amount_delta) FROM closing_correction_effects effect
    WHERE effect.closing_id=c.id AND effect.kind='counted_cash'),0)::numeric(12,2)::text,
  coalesce((SELECT sum(effect.amount_delta) FROM closing_correction_effects effect
    WHERE effect.closing_id=c.id AND effect.kind='fund'),0)::numeric(12,2)::text`

// loadClosing reads one settlement with the database's own money, its count sheet, its expenses,
// its proposal rounds and the corrections it accepted, and derives the numbers that are never
// persisted.
func loadClosing(ctx context.Context, q querier, id int64) (Closing, error) {
	closing, err := scanClosing(ctx, q.QueryRow(ctx, `SELECT `+closingHeaderColumns+`
 FROM branch_closings c JOIN locations l ON l.id=c.branch_location_id WHERE c.id=$1`, id))
	if err != nil {
		return Closing{}, err
	}
	if closing.CountLines, err = loadCountLines(ctx, q, id); err != nil {
		return Closing{}, err
	}
	if closing.Expenses, err = loadExpenses(ctx, q, id); err != nil {
		return Closing{}, err
	}
	if closing.Rounds, err = loadRounds(ctx, q, id); err != nil {
		return Closing{}, err
	}
	if closing.Corrections, err = loadCorrections(ctx, q, id); err != nil {
		return Closing{}, err
	}
	return closing, nil
}

// scanClosing reads the persisted header of one settlement and derives the three cash numbers
// that are never written (S8, S10, L12). It is the projection every read of this package uses,
// so a history row and a single document are the same settlement and not two descriptions of
// it.
func scanClosing(ctx context.Context, row pgx.Row) (Closing, error) {
	var closing Closing
	var status, rate string
	var counted, fund *string
	var countedDelta, fundDelta string
	err := row.Scan(
		&closing.ID, &closing.BranchID, &closing.BranchName, &status,
		&closing.PeriodStart, &closing.CutAt, &closing.ClosedAt, &rate,
		&closing.OpeningCash, &closing.CashSales, &closing.CashExpenses, &closing.SalesTotal,
		&closing.CommissionAmount, &closing.CardTotal, &closing.TransferTotal, &closing.QRTotal,
		&counted, &closing.ContributedCash, &fund, &closing.Observation,
		&closing.OpenedByAccountID, &countedDelta, &fundDelta)
	if errors.Is(err, pgx.ErrNoRows) {
		return Closing{}, ErrNotFound
	}
	if err != nil {
		return Closing{}, fail(ctx)
	}
	closing.Status = Status(status)
	if !closing.Status.Valid() {
		return Closing{}, ErrUnavailable
	}
	if rate != "" {
		parsed, err := ParsePercent(rate)
		if err != nil {
			return Closing{}, ErrUnavailable
		}
		closing.CommissionRatePercent = &parsed
	}
	if counted != nil {
		amount := Money(*counted)
		if _, ok := amountCents(amount); !ok {
			return Closing{}, ErrUnavailable
		}
		closing.CountedCash = &amount
	}
	if fund != nil {
		amount := Money(*fund)
		if _, ok := amountCents(amount); !ok {
			return Closing{}, ErrUnavailable
		}
		closing.ClosingCash = &amount
	}
	for _, stored := range []Money{closing.OpeningCash, closing.CashSales, closing.CashExpenses,
		closing.SalesTotal, closing.CommissionAmount, closing.CardTotal, closing.TransferTotal,
		closing.QRTotal, closing.ContributedCash} {
		if _, ok := amountCents(stored); !ok {
			return Closing{}, ErrUnavailable
		}
	}
	// The drawer and the fund are the signed numbers plus the deltas the branch accepted (036,
	// 040). Applying them here, on read, is what keeps one copy of the truth: the row states
	// what the branch signed and the journal states what moved, so a corrected drawer can never
	// be published as the uncorrected one.
	corrected, err := correctedAmount(closing.CountedCash, Signed(countedDelta))
	if err != nil {
		return Closing{}, ErrUnavailable
	}
	closing.CountedCash = corrected
	funded, err := correctedAmount(closing.ClosingCash, Signed(fundDelta))
	if err != nil {
		return Closing{}, ErrUnavailable
	}
	closing.ClosingCash = funded
	// The three numbers of S8 and S10 are derived here, never stored, so they cannot
	// disagree with the facts that produce them (L12).
	expected, err := ExpectedCash(closing.OpeningCash, closing.CashSales, closing.CashExpenses)
	if err != nil {
		return Closing{}, ErrUnavailable
	}
	closing.ExpectedCash = expected
	if closing.CountedCash != nil {
		difference, err := CashDifference(*closing.CountedCash, expected)
		if err != nil {
			return Closing{}, ErrUnavailable
		}
		closing.CashDifference = &difference
		if closing.ClosingCash != nil {
			taken, err := TakenCash(*closing.CountedCash, closing.ContributedCash, *closing.ClosingCash)
			if err != nil {
				return Closing{}, ErrUnavailable
			}
			closing.TakenCash = &taken
		}
	}
	return closing, nil
}

// loadCountLines reads the count sheet with the catalogue identity of every variant, in
// variant order, so the sheet is legible without a second lookup per line.
func loadCountLines(ctx context.Context, q querier, id int64) ([]CountLine, error) {
	rows, err := q.Query(ctx, `SELECT line.variant_id,variant.catalog_entry_id,entry.brand,entry.model,
  entry.capacity_ah::text,variant.polarity,line.expected_quantity,line.counted_quantity
 FROM closing_count_lines line
 JOIN catalog_variants variant ON variant.id=line.variant_id
 JOIN catalog_entries entry ON entry.id=variant.catalog_entry_id
 WHERE line.closing_id=$1 ORDER BY line.variant_id`, id)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	lines := make([]CountLine, 0, 8)
	for rows.Next() {
		var line CountLine
		var capacity string
		if rows.Scan(&line.VariantID, &line.CatalogEntryID, &line.Brand, &line.Model, &capacity,
			&line.Polarity, &line.ExpectedQuantity, &line.CountedQuantity) != nil {
			return nil, fail(ctx)
		}
		if line.VariantID < 1 || line.CatalogEntryID < 1 || line.Brand == "" || line.Model == "" ||
			(line.Polarity != "L" && line.Polarity != "R") || line.ExpectedQuantity < 0 ||
			line.ExpectedQuantity > MaxCounted ||
			(line.CountedQuantity != nil && (*line.CountedQuantity < 0 || *line.CountedQuantity > MaxCounted)) ||
			(len(lines) > 0 && line.VariantID <= lines[len(lines)-1].VariantID) {
			return nil, ErrUnavailable
		}
		if line.Capacity, err = catalog.ParseDecimal(capacity); err != nil {
			return nil, ErrUnavailable
		}
		lines = append(lines, line)
		if len(lines) > MaxCountLines {
			return nil, ErrUnavailable
		}
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return lines, nil
}

// loadExpenses reads the expenses of the window one settlement covers: the branch's own ledger
// rows of kind 'gasto' inside [period_start, cut_at), in the order the branch recorded them, so
// the document states the facts its total was computed from (S12). The window is the same one
// periodTotals reads, so the list and the total can never describe two different periods.
func loadExpenses(ctx context.Context, q querier, id int64) ([]Expense, error) {
	rows, err := q.Query(ctx, `SELECT expense.id,expense.branch_location_id,expense.amount::text,
  expense.description,expense.occurred_at,expense.created_by_account_id
 FROM branch_cash_movements expense
 JOIN branch_closings closing ON closing.branch_location_id=expense.branch_location_id
 WHERE closing.id=$1 AND expense.kind='gasto'
   AND expense.occurred_at >= closing.period_start AND expense.occurred_at < closing.cut_at
 ORDER BY expense.id`, id)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	expenses := make([]Expense, 0, 8)
	for rows.Next() {
		var expense Expense
		var stored string
		if rows.Scan(&expense.ID, &expense.BranchID, &stored, &expense.Description,
			&expense.OccurredAt, &expense.CreatedByAccountID) != nil {
			return nil, fail(ctx)
		}
		amount, err := ParseAmount(stored)
		if err != nil {
			return nil, ErrUnavailable
		}
		expense.Amount = amount
		// A ledger row this domain did not write is never described: the amount is money, the
		// description is a real one and the order is the order it was recorded in.
		if expense.ID < 1 || expense.BranchID < firstBranchID || expense.BranchID > MaxBranchID ||
			expense.CreatedByAccountID < 1 || expense.OccurredAt.IsZero() {
			return nil, ErrUnavailable
		}
		if canonical, ok := CanonicalDescription(expense.Description); !ok || canonical != expense.Description {
			return nil, ErrUnavailable
		}
		if cents, ok := amountCents(expense.Amount); !ok || cents < 1 {
			return nil, ErrUnavailable
		}
		if previous := len(expenses) - 1; previous >= 0 && expenses[previous].ID >= expense.ID {
			return nil, ErrUnavailable
		}
		expenses = append(expenses, expense)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return expenses, nil
}

// loadRounds reads every proposal round with the payload the branch was shown, oldest
// first. A payload this domain did not write fails closed instead of being described.
func loadRounds(ctx context.Context, q querier, id int64) ([]Round, error) {
	rows, err := q.Query(ctx, `SELECT id,round,proposed_payload::text,proposed_by_account_id,
  proposed_at,coalesce(decision,''),decision_reason,decided_by_account_id,decided_at
 FROM closing_proposals WHERE closing_id=$1 ORDER BY round`, id)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	rounds := make([]Round, 0, 2)
	for rows.Next() {
		var round Round
		var payload, decision string
		if rows.Scan(&round.ID, &round.Round, &payload, &round.ProposedByAccountID, &round.ProposedAt,
			&decision, &round.DecisionReason, &round.DecidedByAccountID, &round.DecidedAt) != nil {
			return nil, fail(ctx)
		}
		round.Decision = Decision(decision)
		switch round.Decision {
		case DecisionPending, DecisionAccepted, DecisionRejected:
		default:
			return nil, ErrUnavailable
		}
		if round.Payload, err = decodePayload(payload); err != nil {
			return nil, err
		}
		rounds = append(rounds, round)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return rounds, nil
}

// decodePayload revalidates one stored offer: every amount must still be canonical money
// and the rate a percentage, so a stored payload keeps its own arithmetic.
func decodePayload(stored string) (ProposalPayload, error) {
	var payload ProposalPayload
	if err := json.Unmarshal([]byte(stored), &payload); err != nil {
		return ProposalPayload{}, ErrUnavailable
	}
	for _, amount := range []Money{payload.SalesTotal, payload.CommissionAmount,
		payload.CashSales, payload.CashExpenses, payload.CardTotal, payload.TransferTotal,
		payload.QRTotal, payload.ContributedCash} {
		if _, ok := amountCents(amount); !ok {
			return ProposalPayload{}, ErrUnavailable
		}
	}
	for _, amount := range []*Money{payload.CountedCash, payload.ClosingCash} {
		if amount != nil {
			if _, ok := amountCents(*amount); !ok {
				return ProposalPayload{}, ErrUnavailable
			}
		}
	}
	if _, err := ParsePercent(string(payload.CommissionRatePercent)); err != nil {
		return ProposalPayload{}, ErrUnavailable
	}
	if payload.PeriodStart.IsZero() || payload.CutAt.IsZero() {
		return ProposalPayload{}, ErrUnavailable
	}
	for _, line := range payload.CountLines {
		if line.VariantID < 1 || line.ExpectedQuantity < 0 || line.ExpectedQuantity > MaxCounted ||
			line.CountedQuantity < 0 || line.CountedQuantity > MaxCounted {
			return ProposalPayload{}, ErrUnavailable
		}
	}
	return payload, nil
}

// loadCorrections reads the corrections of one settlement that its document publishes, oldest
// first, each one with its reason, its status and the deltas the branch accepted. An accepted
// correction is published with the deltas it applied, because the numbers of the document are the
// signed ones plus those deltas. The pending correction is published too, with its status, so the
// branch can see what awaits its decision and by whom it was proposed instead of needing a second
// request it has no route for (S16). A rejected correction applied nothing and is never part of the
// document.
func loadCorrections(ctx context.Context, q querier, closingID int64) ([]Correction, error) {
	rows, err := q.Query(ctx, `SELECT id FROM closing_corrections
 WHERE closing_id=$1 AND status<>'rejected' ORDER BY id`, closingID)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	// The ids are collected before any correction is read: one connection carries one statement
	// at a time, so a read inside the loop of another read is not the same transaction any more.
	ids := make([]int64, 0, 2)
	for rows.Next() {
		var id int64
		if rows.Scan(&id) != nil || id < 1 {
			return nil, fail(ctx)
		}
		ids = append(ids, id)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	corrections := make([]Correction, 0, len(ids))
	for _, id := range ids {
		correction, err := loadCorrection(ctx, q, id)
		if err != nil {
			return nil, err
		}
		if previous := len(corrections) - 1; previous >= 0 && corrections[previous].ID >= correction.ID {
			return nil, ErrUnavailable
		}
		corrections = append(corrections, correction)
	}
	return corrections, nil
}

// loadCorrection reads one correction with the payload the warehouse offered and the effects the
// acceptance journalled. A row this domain did not write fails closed instead of being described.
func loadCorrection(ctx context.Context, q querier, id int64) (Correction, error) {
	var correction Correction
	var status, payload string
	err := q.QueryRow(ctx, `SELECT id,closing_id,status,reason,payload::text,
  proposed_by_account_id,proposed_at,decided_by_account_id,decided_at,decision_reason
 FROM closing_corrections WHERE id=$1`, id).Scan(&correction.ID, &correction.ClosingID, &status,
		&correction.Reason, &payload, &correction.ProposedByAccountID, &correction.ProposedAt,
		&correction.DecidedByAccountID, &correction.DecidedAt, &correction.DecisionReason)
	if errors.Is(err, pgx.ErrNoRows) {
		return Correction{}, ErrNotFound
	}
	if err != nil {
		return Correction{}, fail(ctx)
	}
	correction.Status = CorrectionStatus(status)
	if !correction.Status.Valid() || correction.ID < 1 || correction.ClosingID < 1 ||
		correction.ProposedByAccountID < 1 || correction.ProposedAt.IsZero() {
		return Correction{}, ErrUnavailable
	}
	if canonical, ok := CanonicalReason(correction.Reason); !ok || canonical != correction.Reason {
		return Correction{}, ErrUnavailable
	}
	// A correction is decided once and only with the state the database stores: a decided one has
	// an author and an instant, a pending one has neither.
	if (correction.Status == CorrectionProposed) != (correction.DecidedAt == nil) {
		return Correction{}, ErrUnavailable
	}
	if correction.Status != CorrectionProposed && correction.DecidedByAccountID == nil {
		return Correction{}, ErrUnavailable
	}
	if correction.Status == CorrectionRejected {
		if reason, ok := CanonicalReason(correction.DecisionReason); !ok || reason != correction.DecisionReason {
			return Correction{}, ErrUnavailable
		}
	} else if correction.DecisionReason != "" {
		return Correction{}, ErrUnavailable
	}
	if correction.Payload, err = decodeCorrectionOffer(payload); err != nil {
		return Correction{}, err
	}
	if correction.Effects, err = loadCorrectionEffects(ctx, q, id); err != nil {
		return Correction{}, err
	}
	return correction, nil
}

// loadCorrectionEffects reads the deltas one correction applied, in the order the application
// wrote them. The unit is the kind's: a stock delta carries its variant and a quantity, every
// other kind carries an amount, so an effect is never read as the wrong number (036).
func loadCorrectionEffects(ctx context.Context, q querier, id int64) ([]CorrectionEffect, error) {
	rows, err := q.Query(ctx, `SELECT kind,variant_id,quantity_delta,amount_delta::text
 FROM closing_correction_effects WHERE correction_id=$1 ORDER BY id`, id)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	effects := make([]CorrectionEffect, 0, 1)
	for rows.Next() {
		var effect CorrectionEffect
		var amount *string
		if rows.Scan(&effect.Kind, &effect.VariantID, &effect.QuantityDelta, &amount) != nil {
			return nil, fail(ctx)
		}
		switch effect.Kind {
		case CorrectionKindStock:
			if effect.VariantID == nil || *effect.VariantID < 1 || effect.QuantityDelta == nil ||
				*effect.QuantityDelta == 0 || amount != nil {
				return nil, ErrUnavailable
			}
		case CorrectionKindCountedCash, CorrectionKindCommission, CorrectionKindFund:
			if effect.VariantID != nil || effect.QuantityDelta != nil || amount == nil {
				return nil, ErrUnavailable
			}
			// A delta is signed: a corrected drawer, commission or fund is a difference against
			// what the branch signed, and both directions are legitimate.
			value := Signed(*amount)
			if cents, ok := value.Cents(); !ok || cents == 0 {
				return nil, ErrUnavailable
			}
			effect.AmountDelta = &value
		default:
			return nil, ErrUnavailable
		}
		effects = append(effects, effect)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return effects, nil
}

// decodeCorrectionOffer revalidates one stored correction: every amount must still be canonical
// money and the counted sheet inside the database's bounds, so a stored payload keeps its own
// arithmetic.
func decodeCorrectionOffer(stored string) (CorrectionOffer, error) {
	var offer CorrectionOffer
	if err := json.Unmarshal([]byte(stored), &offer); err != nil {
		return CorrectionOffer{}, ErrUnavailable
	}
	canonical, err := canonicalCorrection(offer)
	if err != nil {
		return CorrectionOffer{}, ErrUnavailable
	}
	return canonical, nil
}

// mapCorrectionFailure publishes the database's own refusal of a proposed correction. LC012 is
// "only a closed settlement is corrected", and its admission reads the settlement it corrects, so
// the read-back answers both refusals the code covers: a settlement this installation does not
// have is not found, and a live one is named. Every other refusal keeps the plain mapping.
func mapCorrectionFailure(ctx context.Context, q querier, err error, closingID int64) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "LC012" {
		status, read := closingStatus(ctx, q, closingID)
		switch {
		case errors.Is(read, pgx.ErrNoRows):
			return ErrNotFound
		case read == nil && status != string(StatusClosed):
			return &CorrectionNotClosed{ClosingID: closingID}
		}
	}
	return mapFailure(ctx, err)
}

// closingStatus reads the state of one settlement, which is the fact LC012 refuses a correction
// by. It reports pgx.ErrNoRows when the settlement does not exist, so a caller keeps its own
// answer for a read that fails.
func closingStatus(ctx context.Context, q querier, id int64) (string, error) {
	var status string
	err := q.QueryRow(ctx, `SELECT status FROM branch_closings WHERE id=$1`, id).Scan(&status)
	return status, err
}

// mapOpenFailure publishes the database's own decision for an open and nothing else. A
// second live settlement of the branch is the one refusal that has to name a document, so
// the settlement that already holds the branch is read here, inside the transaction that is
// still open around the failed savepoint.
func mapOpenFailure(ctx context.Context, q querier, err error, branchID int64) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "LC017":
			return &RetiredBranch{BranchID: branchID}
		case "23505":
			if strings.Contains(pg.ConstraintName, "branch_closings_one_live") {
				return liveConflict(ctx, q, branchID)
			}
		}
	}
	return mapFailure(ctx, err)
}

// liveConflict names the settlement that holds the branch. A conflict whose document cannot
// be read stays the plain conflict, because a refusal that invents an id would be worse than
// one that omits it.
func liveConflict(ctx context.Context, q querier, branchID int64) error {
	var id int64
	err := q.QueryRow(ctx, `SELECT id FROM branch_closings
 WHERE branch_location_id=$1 AND status <> 'closed' ORDER BY id DESC LIMIT 1`,
		int16(branchID)).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrLiveConflict
		}
		return fail(ctx)
	}
	return &LiveConflict{BranchID: branchID, ClosingID: id}
}

// pendingVariant reads the first variant of a count sheet that has no counted quantity, which is
// the line both the proposal (LC019) and the closure (LC006) refuse by. It reports pgx.ErrNoRows
// when every line is counted, so a caller keeps its own answer for a read that fails.
func pendingVariant(ctx context.Context, q querier, id int64) (int64, error) {
	var variant int64
	err := q.QueryRow(ctx, `SELECT variant_id FROM closing_count_lines
 WHERE closing_id=$1 AND counted_quantity IS NULL ORDER BY variant_id LIMIT 1`, id).Scan(&variant)
	return variant, err
}

// mapProposalFailure publishes the database's own refusal of a proposal transition. LC019 is "a
// variant has no counted quantity" read at the transition: the store already checked the sheet,
// so what the database answered is the count changing between that check and its own statement.
// The reaction is to re-read the settlement and propose again, never to report an outage, and
// only the database knows which variant lost its line -- so the pending line is read back instead
// of the message the trigger composed. Every other refusal keeps the plain mapping.
func mapProposalFailure(ctx context.Context, q querier, err error, id int64) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "LC019" {
		if pending, read := pendingVariant(ctx, q, id); read == nil {
			return &StaleProposal{VariantID: pending}
		}
		return ErrProposalStale
	}
	return mapFailure(ctx, err)
}

// mapClosureFailure publishes the database's own refusal of the closure and names the fact that
// refused it. The stock rules of apply_branch_closing_closure (LC006 for a pending line, LC007 for
// an open reservation, LC018 for stock that moved) compose a message the statement is the only
// source of, so the state is read back instead of the prose being parsed: the refusal names the
// very first line the trigger refused, in the order the trigger refuses them. A closure refused
// for another reason, or a sheet that cannot be read back, keeps the plain mapping.
func mapClosureFailure(ctx context.Context, q querier, err error, id int64, branch int16) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "LC006", "LC007", "LC018":
			if blocker := closureBlocker(ctx, q, id, branch); blocker != nil {
				return blocker
			}
		}
	}
	return mapFailure(ctx, err)
}

// closureBlocker names the fact that refuses a closure, reading the same rows with the same
// predicates as the trigger: first a variant with no counted quantity, then -- in variant order,
// as the trigger walks the sheet -- a variant whose stock is still reserved and a variant that no
// longer holds the quantity the sheet photographed. A state that cannot be read back is not
// guessed: this returns nil and the caller publishes the plain class of the refusal.
func closureBlocker(ctx context.Context, q querier, id int64, branch int16) error {
	if pending, err := pendingVariant(ctx, q, id); err == nil {
		return &CountPending{VariantID: pending}
	}
	var variant int64
	var reserved bool
	err := q.QueryRow(ctx, `SELECT line.variant_id,coalesce(balance.reserved,0) > 0
 FROM closing_count_lines line
 JOIN inventory_balances balance
   ON balance.location_id=$2 AND balance.variant_id=line.variant_id
 WHERE line.closing_id=$1
   AND (coalesce(balance.reserved,0) > 0 OR balance.existing IS DISTINCT FROM line.expected_quantity)
 ORDER BY line.variant_id LIMIT 1`, id, branch).Scan(&variant, &reserved)
	if err != nil {
		return nil
	}
	if reserved {
		return &ReservedStock{VariantID: variant}
	}
	return &StockMoved{VariantID: variant}
}

// mapFailure publishes the database's own decision and nothing else: SQLSTATE is the only
// trusted evidence, and cancellation keeps its semantics.
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
		case "LC001":
			// The branch is frozen by a live settlement and cannot operate (the freeze guards
			// of migration 035).
			return ErrBranchFrozen
		case "LC002", "LC010", "LC015":
			// Only the warehouse, the branch that owns the settlement or the warehouse
			// administrator acts.
			return ErrForbidden
		case "LC003":
			return ErrNoCommissionRate
		case "LC004":
			return ErrCountFrozen
		case "LC005", "LC008", "LC009":
			return ErrStateConflict
		case "LC011":
			// The ledger's admission refused the movement itself: only the branch records its
			// own expenses, and only its closure moves the money of a settlement.
			return ErrNotBranchExpense
		case "LC006":
			return ErrClosureRefused
		case "LC007":
			// A variant still holds a reservation. The closure path names it through
			// closureBlocker; this is the class of the same refusal.
			return ErrReservedStock
		case "LC018":
			// A variant moved during the settlement, so the closure refuses to apply a stale
			// count. The closure path names the variant through closureBlocker; this is the
			// class of the same refusal.
			return ErrStockMoved
		case "LC019":
			// The count sheet stopped being complete between the store's check and the
			// database's transition. It is a conflict the operator answers by re-reading and
			// retrying, never an outage.
			return ErrProposalStale
		case "LC016":
			return ErrRoundNotAccepted
		case "LC017":
			return ErrInvalid
		case "LC012":
			// Only a closed settlement is corrected; the proposal path names the settlement.
			return ErrCorrectionNotClosed
		case "LC013":
			// A correction is decided once, and a decided one is final.
			return ErrCorrectionDecided
		case "LC014":
			// Only an enabled account of the branch that owns the settlement decides.
			return ErrForbidden
		case "LC021":
			// The payload is not a correction this domain applies.
			return ErrCorrectionPayload
		case "LC022":
			// The fund of a settlement is corrected before its next period starts.
			return ErrCorrectionFundStarted
		case "LC023":
			// An effect is written by the acceptance of its own correction.
			return ErrCorrectionJournal
		case "23505":
			if strings.Contains(pg.ConstraintName, "branch_closings_one_live") {
				return ErrLiveConflict
			}
			if strings.Contains(pg.ConstraintName, "closing_corrections_one_pending") {
				// One correction at a time: the warehouse waits for the branch's decision.
				return ErrCorrectionPending
			}
			return ErrStateConflict
		case "23503":
			return ErrNotFound
		case "23514", "22P02", "22003":
			return ErrInvalid
		}
	}
	return ErrUnavailable
}
