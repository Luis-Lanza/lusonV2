package closings

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
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

// Commissions reads the configured commission of every branch, which is what the
// administration panel lists: the rate of each branch that has one, the account that fixed
// it and when. Only the warehouse reads it, and a branch without a configured rate is
// absent from the answer, so the panel tells "not configured" apart from a rate of zero.
func (s *Store) Commissions(ctx context.Context, actor auth.Identity) ([]BranchCommission, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return nil, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return nil, ErrForbidden
	}
	if err := checkAccount(ctx, s.pool, actor); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	// A retired branch keeps its setting but is no longer a branch: the panel lists the ones the
	// directory still shows, so deleting a branch never leaves a rate the panel cannot place.
	rows, err := s.pool.Query(ctx, `SELECT s.branch_location_id, s.commission_rate_percent::text,
 s.updated_at, a.display_name
 FROM branch_settings s
 JOIN auth_accounts a ON a.id = s.updated_by_account_id
 JOIN locations l ON l.id = s.branch_location_id AND l.deleted_at IS NULL
 ORDER BY s.branch_location_id`)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	configured := []BranchCommission{}
	for rows.Next() {
		var item BranchCommission
		var stored string
		if err := rows.Scan(&item.BranchID, &stored, &item.UpdatedAt, &item.UpdatedBy); err != nil {
			return nil, fail(ctx)
		}
		if item.Rate, err = ParsePercent(stored); err != nil {
			return nil, ErrUnavailable
		}
		configured = append(configured, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fail(ctx)
	}
	return configured, nil
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
// The money of a period the warehouse still holds is derived per row once the whole page has been
// read, by the same helper of the single read, so a list row cannot state a period its own document
// denies. It costs one extra ledger statement, one statement for the purchase envelope and at most
// one rate statement per row, and never more: a branch holds one live settlement at a time, so a
// page of one branch has at most one open row in it. The material sheet of the whole page is one
// further statement, which is why it is read after the page cursor is closed and never per row.
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
	// Every row of the page is in memory and the cursor is closed before the first open row derives
	// its period, and that order is the finding this read answers, not a style preference: the
	// derivation reads the ledgers through this same pool, and a statement issued while this cursor
	// still holds a connection waits for a connection the cursor itself holds. On a pool of N
	// connections, N concurrent list requests would hold every connection with a cursor and every one
	// of them would wait for a second connection instead of returning its page.
	rows.Close()
	for i := range result.Closings {
		if err := deriveClosing(ctx, s.pool, &result.Closings[i]); err != nil {
			return Page{}, err
		}
	}
	// The material sheet is part of the same derivation: the third account of the document is
	// published by the single read and by every row of a page, one statement for the page (S8).
	documents := make([]*Closing, len(result.Closings))
	for i := range result.Closings {
		documents[i] = &result.Closings[i]
	}
	if err := attachMaterialLines(ctx, s.pool, documents); err != nil {
		return Page{}, err
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

// CountMaterials records what the warehouse counted of the material sheet: used batteries in whole
// units per model and scrap in kilograms per material, and nothing else. It is the count sheet's own
// shape -- one request states the lines it counted, a line that already exists only changes its
// count, and a line the caller adds gets the database's own expected quantity of zero -- so writing
// the same request twice leaves the same sheet. The expected quantity of every line is the snapshot
// the opener seeded from the pending backlog of the branch at its cut -- what it bought before the
// cut minus what its closed settlements delivered (047) -- and is never a caller promise, and a line
// nobody counted stays pending and blocks nothing: the stock count sheet is the only gate of the
// proposal (S8). The database refuses a write while the branch is deciding or after the closure
// (LC025), exactly like the count sheet of the stock (LC004).
func (s *Store) CountMaterials(ctx context.Context, actor auth.Identity, id int64, counted []MaterialCounted) (Closing, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Closing{}, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return Closing{}, ErrForbidden
	}
	if id < 1 {
		return Closing{}, ErrNotFound
	}
	lines, err := canonicalMaterials(counted)
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
	// The header is locked before the sheet is judged, so a proposal cannot slip between the state
	// check and the write, and a refused line leaves the sheet exactly as it was.
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
	if err := checkMaterials(ctx, tx, lines); err != nil {
		return Closing{}, err
	}
	for _, line := range lines {
		// expected_quantity is supplied only because the column is NOT NULL on insert: the admission
		// trigger would write its own zero anyway, because the expected is the fact of the opening and
		// never a caller promise. The conflict branch leaves it untouched, so only the counted
		// quantity of an existing line ever moves.
		// The sheet is the opening's own fact: a line exists because the branch still had that model or
		// material pending at the cut, and its expected quantity was seeded then. Counting a key the
		// seed did not create would store a line with a zero expectation that the update guard then
		// forbids correcting -- and a key with nothing pending is not a position of the branch -- so it
		// is refused instead of invented.
		var counted int64
		switch line.Kind {
		case MaterialKindUsed:
			err = tx.QueryRow(ctx, `UPDATE closing_material_lines SET counted_quantity=$3
 WHERE closing_id=$1 AND kind='used' AND model=$2 RETURNING expected_quantity::bigint`,
				id, line.Model, string(line.Quantity)).Scan(&counted)
		case MaterialKindScrap:
			err = tx.QueryRow(ctx, `UPDATE closing_material_lines SET counted_quantity=$3
 WHERE closing_id=$1 AND kind='scrap' AND material_id=$2 RETURNING expected_quantity::bigint`,
				id, int16(line.MaterialID), string(line.Quantity)).Scan(&counted)
		default:
			return Closing{}, ErrInvalid
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return Closing{}, ErrInvalid
		}
		if err != nil {
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
//
// The purchase envelope is drafted here too, as the same kind of fact: the amount the warehouse
// counted in it and the amount it leaves in it, both optional and both non-negative (S1, S5, S6).
// The draft states the envelope whole, exactly like the drawer: a draft that states neither leaves
// both columns null, which is the honest state of an envelope nobody counted. The new amount is not
// bounded by the counted one, because the warehouse brings money from outside the branch and that
// money is not in the envelope it counted.
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
  closing_cash=$4,observation=$5,purchase_fund_counted=$6,purchase_fund_cash=$7 WHERE id=$1`,
		id, nullable(canonical.CountedCash), string(canonical.ContributedCash),
		nullable(canonical.ClosingCash), canonical.Observation, nullable(canonical.PurchaseFundCounted),
		nullable(canonical.PurchaseFundCash)); err != nil {
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
 RETURNING id,branch_location_id,kind,amount::text,description,occurred_at,created_by_account_id`,
		int16(actor.Location.ID), string(canonicalAmount), canonicalDescription,
		int64(actor.AccountID)).
		Scan(&expense.ID, &expense.BranchID, &expense.Kind, &stored, &expense.Description,
			&expense.OccurredAt, &expense.CreatedByAccountID)
	if err != nil {
		return Expense{}, s.cashWriteRefusal(ctx, actor.Location.ID, canonicalAmount, err)
	}
	if expense.Amount, err = ParseAmount(stored); err != nil {
		return Expense{}, ErrUnavailable
	}
	// The row is revalidated against the expense this call wrote: the kind of a pay-out and no
	// movement it answers, because a correction has its own path.
	if expense.Kind != metricsMovementExpense || expense.CorrectsID != nil {
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

// RecordCashMovement records one movement the branch writes in its own operational drawer (S1, S2): the
// small expense it paid out, the contribution it received or the collection it gave up, with its amount
// and what it was for. It is the same admission as an expense -- the branch of the session, the
// database's instant, no approval and no settlement named -- stated for the three kinds the branch
// writes of its own period (S12).
func (s *Store) RecordCashMovement(ctx context.Context, actor auth.Identity, kind string, amount Money, description string) (Expense, error) {
	// A correction is not a direction of the drawer: it answers another movement and states which one, so
	// it is never recorded here and has its own path below (S6).
	if !cashMovementPeriodKind(kind) {
		return Expense{}, ErrInvalid
	}
	return s.recordMovement(ctx, actor, kind, amount, description, nil)
}

// CorrectCashMovement records the compensating movement of one row of the branch's book (S6): the
// amount it states, what for and the movement it answers. The book is immutable -- nothing is edited and
// nothing is deleted -- so a wrong row is answered by this opposite movement, and the database's own
// admission decides everything else about the shape: a correction names a movement it may, of its own
// branch, that no correction and no settlement already answers, and the corrections of one movement
// never exceed the amount that movement stated (S7).
func (s *Store) CorrectCashMovement(ctx context.Context, actor auth.Identity, correctsID int64, amount Money, description string) (Expense, error) {
	// A correction always names the movement it answers, and a movement id is never zero (S6).
	if correctsID < 1 {
		return Expense{}, ErrInvalid
	}
	return s.recordMovement(ctx, actor, cashMovementCorrection, amount, description, &correctsID)
}

// recordMovement appends one row to the branch's own book, which is the one write both paths above state:
// the amount, the description, the kind the branch recorded and -- for a correction -- the movement it
// answers. The rules of the admission are exactly those of a recorded expense: a positive canonical
// amount, a canonical description, the branch of the session (never a caller value, S12), the database's
// instant and no settlement named, because the closure that covers the row is the one whose window
// contains that instant.
func (s *Store) recordMovement(ctx context.Context, actor auth.Identity, kind string, amount Money, description string, corrects *int64) (Expense, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Expense{}, ErrUnavailable
	}
	canonicalAmount, err := ParseAmount(string(amount))
	if err != nil {
		return Expense{}, err
	}
	// A movement of zero is not a movement: the ledger admits a positive amount only, and the same rule
	// is judged here instead of letting the row CHECK answer it.
	if cents, ok := amountCents(canonicalAmount); !ok || cents < 1 {
		return Expense{}, ErrInvalid
	}
	canonicalDescription, ok := CanonicalDescription(description)
	if !ok {
		return Expense{}, ErrInvalid
	}
	// The warehouse has no drawer of its own to write: it never records a movement of a branch's till,
	// and the refusal is the same class the ledger raises for a row that is not the recording branch's
	// own (LC011).
	if actor.Location.ID < firstBranchID {
		return Expense{}, ErrNotBranchExpense
	}
	// A session still forced to change its password does not move the branch's money, exactly like the
	// account that records an expense.
	if actor.MustChangePassword {
		return Expense{}, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAccount(ctx, s.pool, actor); err != nil {
		return Expense{}, err
	}
	var movement Expense
	var stored string
	// The branch is the account's own location and never a caller value, and the row belongs to no
	// settlement: `closing_id` stays null, which is what separates a movement of the period from the
	// transfer of an acta (S5).
	err = s.pool.QueryRow(ctx, `INSERT INTO branch_cash_movements(
  branch_location_id,kind,amount,description,corrects_id,created_by_account_id)
 VALUES($1,$2,$3,$4,$5,$6)
 RETURNING id,branch_location_id,kind,amount::text,description,occurred_at,created_by_account_id,
  corrects_id`,
		int16(actor.Location.ID), kind, string(canonicalAmount), canonicalDescription, corrects,
		int64(actor.AccountID)).
		Scan(&movement.ID, &movement.BranchID, &movement.Kind, &stored, &movement.Description,
			&movement.OccurredAt, &movement.CreatedByAccountID, &movement.CorrectsID)
	if err != nil {
		return Expense{}, s.cashWriteRefusal(ctx, actor.Location.ID, canonicalAmount, err)
	}
	if movement.Amount, err = ParseAmount(stored); err != nil {
		return Expense{}, ErrUnavailable
	}
	if movement.ID < 1 || movement.BranchID < firstBranchID || movement.BranchID > MaxBranchID ||
		movement.CreatedByAccountID < 1 || movement.OccurredAt.IsZero() {
		return Expense{}, ErrUnavailable
	}
	// The row is revalidated against the very movement this call wrote: the kind it asked for, the amount
	// it stated, the target a correction names and only a correction, and the canonical text the ledger
	// admits.
	if movement.Kind != kind || (movement.CorrectsID != nil) != (corrects != nil) ||
		(corrects != nil && *movement.CorrectsID != *corrects) {
		return Expense{}, ErrUnavailable
	}
	if movement.Amount != canonicalAmount {
		return Expense{}, ErrUnavailable
	}
	if canonical, ok := CanonicalDescription(movement.Description); !ok || canonical != movement.Description {
		return Expense{}, ErrUnavailable
	}
	return movement, nil
}

const (
	// cashMovementCorrection is the kind that answers another movement instead of stating a direction
	// of its own: its effect is the opposite of the one it corrects, which the ledger view states for
	// it (S6). It is named once here and reused by every read of the book, so no two readers spell the
	// same kind differently.
	cashMovementCorrection = "correccion"
	// cashLedgerMovements is how many rows the book of a window publishes: the newest ones are kept, so
	// a long window can never flood the screen. The total of the window is not bounded by it: the
	// aggregate above reads every row of the window and the book states that its list is truncated.
	cashLedgerMovements = 500
)

// CashMovement is one row of the branch's operational drawer as the ledger states it: the kind the
// branch recorded, the kind whose direction the row carries -- its own, or the one it answers when it
// is a correction -- the amount it stated, which is always positive because the ledger never stores a
// sign, and the effect signed the way the view reads money, positive into the drawer and negative out
// of it (S4, S13). CorrectsID is the movement a correction answers and nil on every other kind (S6).
type CashMovement struct {
	ID                 int64
	BranchID           int64
	Kind               string
	EffectKind         string
	Amount             Money
	Effective          Signed
	Description        string
	OccurredAt         time.Time
	CreatedByAccountID int64
	CorrectsID         *int64
}

// CashLedger is the branch's drawer over one window, which is what the screen of the operational till
// reads (S8): the amount the period inherited, the cash its sales collected, the signed effect of every
// movement the branch wrote in it, and the expectation those three produce. Since and Until are the
// window the numbers describe and are nil on the sides it leaves open; Movements is the list of that
// window, oldest first, and Effective is the signed sum of the WHOLE window, which is not the sum of
// the list when the window is longer than the bound. Truncated states exactly that: the list is the
// newest cashLedgerMovements rows of the window and the numbers beside it count every row.
type CashLedger struct {
	Since     *time.Time
	Until     *time.Time
	Opening   Money
	Sales     Money
	Effective Signed
	Expected  Signed
	Movements []CashMovement
	// Truncated reports that the window holds more rows than Movements publishes, so a screen can say
	// that it is reading a window of the newest movements instead of the whole period.
	Truncated bool
}

// CashLedger reads the branch's operational drawer over one window (S4, S8, S13). The branch is the
// account's own and never a caller value, exactly like its settlements and its metrics (S12), and the
// read is one statement per fact so the book, the sales and the expectation describe one window: the
// cash of the sales and the signed effect of the movements are the two terms the drawer moves by, and
// the expectation is their identity and not a second arithmetic of it.
//
// The window starts at the cut of the last closed settlement, and the amount that closure left in the
// drawer is what the period inherits -- the same pair todayMetrics reads, for the same reason: a closed
// period ends at its cut, so what the branch does between the cut and the closure of that settlement
// belongs to this window and to no acta. A branch that never closed a settlement starts at a nil Since
// and with an opening of zero, which is that state and not a zero instant. An explicit `from` states
// the start of the window the caller asks for; when that instant is exactly the start of a closed
// settlement's period, the window is the one that settlement settled, so the opening is the amount it
// inherited and the book of a settled window closes with its acta (S4, S13). Any other explicit window
// inherits nothing and publishes an opening of `0.00`, because there is no balance this store could
// state for an interval it does not know.
//
// The book is the rows the branch wrote (S5): every read of the period filters `closing_id IS NULL`. The
// `aporte` and the `recaudacion` a closure writes are the acta's own facts -- the contribution of the
// Almacén and the money it takes, already stated by its `contributed_cash` and `taken_cash` columns --
// and they are never terms of this expectation, because counting them here as well would count that
// money twice. The rows are read newest first so the bound keeps the newest ones, published oldest
// first because a book is read in the order it happened, and the numbers beside the list -- the signed
// effect of the window and the expectation it produces -- are read from the same filtered rows as the
// list itself, so a screen can never show a list that disagrees with the number beside it (S13). A
// window longer than the bound publishes its newest movements and states that it truncated, instead of
// summing the part of the window the list kept and calling that total the drawer.
//
// Every row is revalidated instead of trusted: the amount is canonical money and positive, the kind is
// one of the four the ledger admits, the effect is the direction that kind states -- inverted for a
// correction -- the description is a real one, the instant is set and the sequence advances in
// (occurred_at, id). A row this domain did not write fails closed, so a book that would describe money
// twice is never published.
func (s *Store) CashLedger(ctx context.Context, actor auth.Identity, from, to *time.Time) (CashLedger, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return CashLedger{}, ErrUnavailable
	}
	// The warehouse owns no drawer, and a session still forced to change its password does not read the
	// branch's money: the same admission as its metrics.
	if !branchAccount(actor) {
		return CashLedger{}, ErrForbidden
	}
	// A window that ends before it starts describes no period at all: it is a request error and never an
	// empty book a screen would read as a real answer.
	if from != nil && to != nil && from.After(*to) {
		return CashLedger{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAccount(ctx, s.pool, actor); err != nil {
		return CashLedger{}, err
	}
	branch := int16(actor.Location.ID)
	book := CashLedger{Opening: Money("0.00"), Until: to, Movements: make([]CashMovement, 0, 8)}
	if from != nil {
		since := *from
		book.Since = &since
		// The one explicit window this store can state an opening for is the one a closed settlement
		// settled: its own start and the amount it inherited. The match is on the instant itself, at the
		// precision the column holds -- a truncated instant is another window -- and a `from` that is the
		// start of no settled period inherits nothing, which is the zero above and not an invented balance.
		var inherited string
		err := s.pool.QueryRow(ctx, `SELECT opening_cash::text FROM branch_closings
 WHERE branch_location_id=$1 AND status='closed' AND period_start=$2
 ORDER BY cut_at DESC,id DESC LIMIT 1`, branch, since).Scan(&inherited)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// A window that starts anywhere else inherits no balance: the opening stays the zero above.
		case err != nil:
			return CashLedger{}, fail(ctx)
		default:
			opening := Money(inherited)
			if _, ok := amountCents(opening); !ok {
				return CashLedger{}, ErrUnavailable
			}
			book.Opening = opening
		}
	} else {
		// The cut of the last closed settlement and the cash it left behind are one row of one branch:
		// the same row the opener of the next settlement inherits its opening from.
		var stored string
		var cut time.Time
		err := s.pool.QueryRow(ctx, `SELECT closing_cash::text,cut_at FROM branch_closings
 WHERE branch_location_id=$1 AND status='closed'
 ORDER BY cut_at DESC,id DESC LIMIT 1`, branch).Scan(&stored, &cut)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// A branch that never closed a settlement states no cut and starts at zero, with a nil Since
			// instead of a zero instant.
		case err != nil:
			return CashLedger{}, fail(ctx)
		default:
			opening := Money(stored)
			if _, ok := amountCents(opening); !ok || cut.IsZero() {
				return CashLedger{}, ErrUnavailable
			}
			book.Opening, book.Since = opening, &cut
		}
	}
	// The cash the sales of the same window collected: a card sale never entered this drawer, so only
	// the cash amount of the sale is read.
	var sales string
	if err := s.pool.QueryRow(ctx, `SELECT coalesce(sum(sale.cash_amount),0)::numeric(12,2)::text
 FROM sales sale WHERE sale.branch_location_id=$1
   AND ($2::timestamptz IS NULL OR sale.created_at >= $2)
   AND ($3::timestamptz IS NULL OR sale.created_at < $3)`,
		branch, book.Since, book.Until).Scan(&sales); err != nil {
		return CashLedger{}, fail(ctx)
	}
	book.Sales = Money(sales)
	if _, ok := amountCents(book.Sales); !ok {
		return CashLedger{}, ErrUnavailable
	}
	rows, err := s.pool.Query(ctx, `SELECT id,branch_location_id,kind,effect_kind,amount::text,
  effective::text,description,occurred_at,created_by_account_id,corrects_id,
  sum(effective) OVER ()::text,count(*) OVER ()
 FROM branch_cash_ledger
 WHERE branch_location_id=$1 AND closing_id IS NULL
   AND ($2::timestamptz IS NULL OR occurred_at >= $2)
   AND ($3::timestamptz IS NULL OR occurred_at < $3)
 ORDER BY occurred_at DESC,id DESC LIMIT `+strconv.Itoa(cashLedgerMovements),
		branch, book.Since, book.Until)
	if err != nil {
		return CashLedger{}, fail(ctx)
	}
	defer rows.Close()
	// The two aggregates are read with every row and are computed over the whole filtered window, before
	// the bound drops the rows the list does not publish: one statement is one snapshot, so the total and
	// the list can never come from two different readings of two slightly different predicates.
	var total string
	var window int64
	for rows.Next() {
		var movement CashMovement
		var amount, stored string
		if rows.Scan(&movement.ID, &movement.BranchID, &movement.Kind, &movement.EffectKind,
			&amount, &stored, &movement.Description, &movement.OccurredAt,
			&movement.CreatedByAccountID, &movement.CorrectsID, &total, &window) != nil {
			return CashLedger{}, fail(ctx)
		}
		if _, ok := movement.stored(branch, amount, stored); !ok {
			return CashLedger{}, ErrUnavailable
		}
		book.Movements = append(book.Movements, movement)
	}
	if rows.Err() != nil {
		return CashLedger{}, fail(ctx)
	}
	// The rows were read newest first and are published oldest first: a book is read in the order it
	// happened.
	for left, right := 0, len(book.Movements)-1; left < right; left, right = left+1, right-1 {
		book.Movements[left], book.Movements[right] = book.Movements[right], book.Movements[left]
	}
	// The published sequence is the read's own order, oldest first: a list whose rows do not advance
	// in (occurred_at, id) is a book this domain did not write.
	for index := 1; index < len(book.Movements); index++ {
		if !cashMovementAfter(book.Movements[index-1], book.Movements[index]) {
			return CashLedger{}, ErrUnavailable
		}
	}
	// The signed effect of the whole window, read by the same statement as the list, so the list and the
	// number beside it can never disagree (S13). An empty window read no aggregate because it read no
	// row: it is a book of nothing, and zero is that book and not a missing number.
	book.Effective = Signed("0.00")
	if window > 0 {
		if book.Effective, err = windowEffect(window, total); err != nil {
			return CashLedger{}, err
		}
	}
	// The aggregate can only cover more rows than the list, never fewer: a window smaller than the rows
	// already published was not read as one window.
	if window < int64(len(book.Movements)) {
		return CashLedger{}, ErrUnavailable
	}
	book.Truncated = window > int64(len(book.Movements))
	expected, err := DrawerExpected(book.Opening, book.Sales, book.Effective)
	if err != nil {
		return CashLedger{}, ErrUnavailable
	}
	book.Expected = expected
	return book, nil
}

// windowSignedEffect reads the signed effect of one window of the branch's own book (S4, S13): the sum of the
// ledger view's `effective` over every movement the branch wrote inside [from, to), which is the term the
// expectation is built from. It is the same predicate every read of this package applies -- the rows of
// the branch that belong to no settlement -- so the acta, the book and the metrics card of one window
// cannot sum different rows. A window with no rows reads as zero, which is that window and not a missing
// number.
func windowSignedEffect(ctx context.Context, q querier, branch int16, from, to time.Time) (Signed, error) {
	var stored string
	if err := q.QueryRow(ctx, `SELECT coalesce((SELECT sum(ledger.effective) FROM branch_cash_ledger ledger
 WHERE ledger.branch_location_id=$1 AND ledger.closing_id IS NULL
   AND ledger.occurred_at >= $2 AND ledger.occurred_at < $3),0)::numeric(12,2)::text`,
		branch, from, to).Scan(&stored); err != nil {
		return "", fail(ctx)
	}
	effect := Signed(stored)
	if _, ok := effect.Cents(); !ok {
		return "", ErrUnavailable
	}
	return effect, nil
}

// windowEffect publishes the signed sum of a whole window from the text the aggregate rendered. The sum
// is money this domain publishes, so it is judged before it is read as cents: a total outside the range
// of a canonical amount is not a number this book can state, and no wrapped int64 is ever published as
// one. An unreadable or empty total fails closed, exactly like a row this domain did not write.
func windowEffect(window int64, total string) (Signed, error) {
	// numeric(12,2) is at most ten integral digits plus the fraction: a shorter magnitude is the only
	// text the canonical reading below can parse without overflowing the cents of an int64.
	if window < 1 || len(strings.TrimPrefix(total, "-")) > 13 {
		return "", ErrUnavailable
	}
	cents, ok := Signed(total).Cents()
	if !ok || cents > maxCents || cents < -maxCents {
		return "", ErrUnavailable
	}
	effect := signedFromCents(cents)
	if effect == "" {
		return "", ErrUnavailable
	}
	return effect, nil
}

// stored revalidates one row of the ledger view and publishes it as money, returning the signed effect
// the row carries. It refuses everything this domain could not have written: the amount is canonical and
// positive, the row belongs to the branch of the session, the kind is one of the four the ledger admits,
// the effect carries the direction that kind states, a correction names exactly one movement and no other
// kind names one, the description is canonical text and the instant is set (S6, S13). A row that fails
// any of them is never published: the caller fails closed on false.
func (m *CashMovement) stored(branch int16, amount, effect string) (int64, bool) {
	if m.ID < 1 || m.BranchID != int64(branch) || m.CreatedByAccountID < 1 || m.OccurredAt.IsZero() {
		return 0, false
	}
	if !cashMovementKind(m.Kind) || !cashMovementEffectKind(m.EffectKind) {
		return 0, false
	}
	if (m.Kind == cashMovementCorrection) != (m.CorrectsID != nil) ||
		(m.CorrectsID != nil && *m.CorrectsID < 1) {
		return 0, false
	}
	if canonical, ok := CanonicalDescription(m.Description); !ok || canonical != m.Description {
		return 0, false
	}
	stored := Money(amount)
	if cents, ok := amountCents(stored); !ok || cents < 1 {
		return 0, false
	}
	signed := Signed(effect)
	cents, ok := signed.Cents()
	if !ok || !cashMovementDirection(m.Kind, m.EffectKind, cents) {
		return 0, false
	}
	m.Amount, m.Effective = stored, signed
	return cents, true
}

// cashMovementKind admits the four kinds the ledger records: the expense the branch paid out of the
// drawer, the collection it gave up, the contribution it received and the correction that answers one
// of them.
func cashMovementKind(kind string) bool {
	return cashMovementPeriodKind(kind) || kind == cashMovementCorrection
}

// cashMovementPeriodKind admits the three kinds the branch records of its own period: the expense it
// paid out, the collection it gave up and the contribution it received. A correction is not one of them:
// it answers another movement instead of stating a direction of its own (S6).
func cashMovementPeriodKind(kind string) bool {
	return kind == metricsMovementExpense || kind == metricsMovementCollection ||
		kind == metricsMovementContribution
}

// cashMovementEffectKind admits the three directions a row can carry. A correction carries the kind of
// the movement it answers, so an effect is never the correction itself: the ledger refuses a correction
// of a correction (S6) and this read refuses to describe one.
func cashMovementEffectKind(kind string) bool {
	return kind == metricsMovementExpense || kind == metricsMovementCollection ||
		kind == metricsMovementContribution
}

// cashMovementDirection reports whether one signed effect is the direction the ledger states for it: an
// aporte puts money into the drawer, a gasto or a recaudacion take it out, and a correction states the
// opposite direction of the movement it answers -- a corrected gasto returns money to the drawer (S13).
func cashMovementDirection(kind, effectKind string, cents int64) bool {
	into := (effectKind == metricsMovementContribution) != (kind == cashMovementCorrection)
	if into {
		return cents > 0
	}
	return cents < 0
}

// cashMovementAfter reports whether one row of the book strictly follows another in the order it is
// published: the instant first and the id among the rows of one instant, which is the inverse of the
// order the window is read in. A book whose rows do not advance is one this domain did not write.
func cashMovementAfter(previous, movement CashMovement) bool {
	if !previous.OccurredAt.Equal(movement.OccurredAt) {
		return previous.OccurredAt.Before(movement.OccurredAt)
	}
	return movement.ID > previous.ID
}

// The drawer's expectation is DrawerExpected (money.go) and it is not restated here, so no reader of this
// package can apply a second arithmetic of the same window (S4, S13).

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

// checkMaterials refuses a sheet that names a material of the reference table that does not exist,
// before any line is written: the whole sheet is written or none of it is. A material is reference
// data of the installation and never a value a caller invents, exactly like the variant of a count
// line of the stock.
func checkMaterials(ctx context.Context, q querier, lines []MaterialCounted) error {
	ids := make([]int16, 0, len(lines))
	for _, line := range lines {
		if line.Kind == MaterialKindScrap {
			ids = append(ids, int16(line.MaterialID))
		}
	}
	if len(ids) == 0 {
		return nil
	}
	var known int64
	if err := q.QueryRow(ctx, `SELECT count(*) FROM materials WHERE id=ANY($1)`, ids).Scan(&known); err != nil {
		return fail(ctx)
	}
	if known != int64(len(ids)) {
		return ErrInvalid
	}
	return nil
}

// Propose is the warehouse's offer. In one transaction it freezes the period numbers from
// the sale ledger of the branch — the sales total that is the commission base, the cash
// amount and the card and transfer amounts — inserts the round that carries the whole offer
// and flips the settlement to proposed, where the database freezes the configured rate.
//
// The round is mandatory and ordered before the state change: the database refuses a closure
// whose latest round is not accepted (LC016), so nothing could ever close without it. The
// opener seeds every line of the sheet with the quantity the system expects (S1), so the count
// is already complete when the warehouse proposes and only the drawer has to be counted: the
// pending check below and the database's own LC006 and LC019 are the unreachable safety net of
// a sheet written before that seeding. The drawer is not optional, because the database refuses
// a closure without it (LC006) and a settlement whose round the branch had accepted could no
// longer be corrected: no transition leaves a proposed settlement with an accepted round.
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
	var countedCash, closingCash, purchaseCounted, purchaseCash *string
	var draft CashDraft
	err = tx.QueryRow(ctx, `SELECT branch_location_id,status,period_start,cut_at,
  counted_cash::text,contributed_cash::text,closing_cash::text,observation,
  purchase_fund_counted::text,purchase_fund_cash::text
 FROM branch_closings WHERE id=$1 FOR UPDATE`, id).Scan(&branch, &status, &periodStart, &cutAt,
		&countedCash, &draft.ContributedCash, &closingCash, &draft.Observation, &purchaseCounted,
		&purchaseCash)
	if errors.Is(err, pgx.ErrNoRows) {
		return Closing{}, ErrNotFound
	}
	if err != nil {
		return Closing{}, fail(ctx)
	}
	if !Status(status).Held() {
		return Closing{}, ErrStateConflict
	}
	// The sheet reads as seeded and the only fact this offer still needs is the drawer, because
	// the opener writes the expected quantity into every counted quantity (S1). A line that reads
	// pending here can only come from a sheet written before that seeding, and the refusal is
	// kept as the safety net it becomes instead of being removed (S3, LC006).
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
	// The envelope is the offer's too: the amount the warehouse counted in the purchase fund and the
	// amount it leaves there (S5, S6). They are the columns the draft wrote, and the transition below
	// freezes them, so the branch is offered exactly the envelope it is being asked to accept.
	if purchaseCounted != nil {
		amount := Money(*purchaseCounted)
		draft.PurchaseFundCounted = &amount
	}
	if purchaseCash != nil {
		amount := Money(*purchaseCash)
		draft.PurchaseFundCash = &amount
	}
	payload := ProposalPayload{
		PeriodStart: periodStart, CutAt: cutAt,
		SalesTotal: totals.salesTotal, CommissionRatePercent: rate, CommissionAmount: commission,
		CashSales: totals.cash, CashExpenses: totals.expenses,
		CardTotal: totals.card, TransferTotal: totals.transfer, QRTotal: totals.qr,
		CountedCash: draft.CountedCash, ContributedCash: draft.ContributedCash,
		ClosingCash: draft.ClosingCash, Observation: draft.Observation,
		PurchaseFundCounted: draft.PurchaseFundCounted, PurchaseFundCash: draft.PurchaseFundCash,
		CountLines: make([]ProposalCountLine, 0, len(lines)),
	}
	for _, line := range lines {
		if line.CountedQuantity == nil {
			// The same safety net as above, read on the rows the offer publishes: only a sheet
			// written before the opener seeded the counted quantity can reach it.
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
// card, transfer and QR amounts of the same sales (S13), the net cash expense the branch
// recorded as it happened (S12) and the signed effect of every movement of the window (S4, S13).
// One statement, so every number describes the same window of the same transaction, and both the
// proposal and the closure call it, so an offered period can never differ from the closed one.
//
// The expenses are the NET expense of the window, read from `branch_cash_ledger` (S4): the view
// states one signed effect per row, so the period's expense is `-sum(effective)` over the rows
// whose effect is a `gasto` and a correction of a gasto lowers the expense it answers instead of
// being a second kind one reader subtracts and another forgets (S13). The effect is that same sum
// over EVERY row of the window, which is the term the drawer's expectation is built from: an
// aporte adds, a gasto and a recaudacion subtract and a correction reverses the direction of the
// row it answers, so one signed number carries the four kinds and no reader has to sum them again.
// The window rule is the same one every read of this package applies (S5): a branch's book is the
// rows it wrote, so every read of the period filters `closing_id IS NULL`. The transfer rows a
// settlement writes -- its `aporte`, which is the contribution of the Almacén, and its
// `recaudacion`, which is the money it takes -- are the acta's own facts, already stated by the
// columns `contributed_cash` and `taken_cash` of the document, and they are NEVER terms of the
// period expectation: counting them here as well would count the same money twice.
func periodTotals(ctx context.Context, q querier, branch int16, from, to time.Time) (periodTotalsResult, error) {
	var result periodTotalsResult
	var total, cash, card, transfer, qr, expenses, effective string
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
       coalesce(-(SELECT sum(ledger.effective) FROM branch_cash_ledger ledger
        WHERE ledger.branch_location_id=$1 AND ledger.effect_kind='gasto'
          AND ledger.closing_id IS NULL
          AND ledger.occurred_at >= $2 AND ledger.occurred_at < $3),0)::numeric(12,2)::text,
       coalesce((SELECT sum(ledger.effective) FROM branch_cash_ledger ledger
        WHERE ledger.branch_location_id=$1 AND ledger.closing_id IS NULL
          AND ledger.occurred_at >= $2 AND ledger.occurred_at < $3),0)::numeric(12,2)::text`,
		branch, from, to).Scan(&total, &cash, &card, &transfer, &qr, &expenses, &effective)
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
	result.effective = Signed(effective)
	if _, ok := result.effective.Cents(); !ok {
		return periodTotalsResult{}, ErrUnavailable
	}
	return result, nil
}

// periodTotalsResult is the money of one settled period: the commission base, the collection
// by payment method -- cash in the drawer, card, transfer and QR outside it --, the expenses the
// branch paid out of the drawer and the signed effect of every movement of the window, which is the
// term the drawer's expectation is built from.
type periodTotalsResult struct {
	salesTotal, cash, card, transfer, qr, expenses Money
	effective                                      Signed
}

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
		// The closure states the count and the drawer, and the count is already seeded with the
		// expected quantity (S1), so a pending line here is the safety net of a sheet written
		// before that seeding: what the offer must still state is the drawer.
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
//
// purchase_fund_counted and purchase_fund_cash are the second envelope (044): what the warehouse
// counted in it and the amount it leaves there, both drafted while the settlement is held and
// frozen by the proposal. They are the only money of this vertical that comes from the purchases
// and not from the cash ledger, and they participate in no identity of the drawer (S1, S12). The
// column of the amount left is the statement the branch accepted, not the arithmetic: `settled`
// reads it for a live settlement, and a closed one is published by derivePurchaseFund from
// `settledPurchaseFund`, the one read of the fund a closure left (S5, S9, migration 052).
//
// The money of the period is read as the database stores it, because that is what the offer
// froze; a row that is still open is published from its own ledgers afterwards (deriveClosing), so
// the projection keeps one shape for every state and only the open one is filled in on read.
const closingHeaderColumns = `c.id,c.branch_location_id,l.name,c.status,
  c.period_start,c.cut_at,c.closed_at,coalesce(c.commission_rate_percent::text,''),
  c.opening_cash::text,c.cash_sales::text,c.cash_expenses::text,c.sales_total::text,
  c.commission_amount::text,c.card_total::text,c.transfer_total::text,c.qr_total::text,
  c.counted_cash::text,c.contributed_cash::text,c.closing_cash::text,c.observation,
  c.opened_by_account_id,c.purchase_fund_counted::text,c.purchase_fund_cash::text,
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
	// The row of a single read is scanned and released, so the derivation can run on the same
	// querier without holding a cursor of it (a page of the history derives after its cursor is
	// closed, see List).
	if err := deriveClosing(ctx, q, &closing); err != nil {
		return Closing{}, err
	}
	if closing.CountLines, err = loadCountLines(ctx, q, id); err != nil {
		return Closing{}, err
	}
	if err := attachMaterialLines(ctx, q, []*Closing{&closing}); err != nil {
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

// scanClosing reads the persisted header of one settlement, and only that: a pure scan of the row
// it is given, needing no querier of its own. The numbers that are never written are derived by
// deriveClosing afterwards, so a caller holding a row cursor can read its whole page in before
// anything else is asked of the pool (List).
func scanClosing(ctx context.Context, row pgx.Row) (Closing, error) {
	var closing Closing
	var status, rate string
	var counted, fund, purchaseCounted, purchaseCash *string
	var countedDelta, fundDelta string
	err := row.Scan(
		&closing.ID, &closing.BranchID, &closing.BranchName, &status,
		&closing.PeriodStart, &closing.CutAt, &closing.ClosedAt, &rate,
		&closing.OpeningCash, &closing.CashSales, &closing.CashExpenses, &closing.SalesTotal,
		&closing.CommissionAmount, &closing.CardTotal, &closing.TransferTotal, &closing.QRTotal,
		&counted, &closing.ContributedCash, &fund, &closing.Observation,
		&closing.OpenedByAccountID, &purchaseCounted, &purchaseCash, &countedDelta, &fundDelta)
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
	// The envelope is scanned as the database stores it: null while the warehouse has not counted
	// it or has not stated the amount it leaves behind (S5).
	if purchaseCounted != nil {
		amount := Money(*purchaseCounted)
		if _, ok := amountCents(amount); !ok {
			return Closing{}, ErrUnavailable
		}
		closing.PurchaseFundCounted = &amount
	}
	if purchaseCash != nil {
		amount := Money(*purchaseCash)
		if _, ok := amountCents(amount); !ok {
			return Closing{}, ErrUnavailable
		}
		closing.PurchaseFundCash = &amount
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
	return closing, nil
}

// deriveClosing publishes the numbers of one scanned settlement that are never written: the money
// of the period while the settlement is open (S1, S3), the three cash numbers (S8, S10, L12) and the
// purchase envelope (S3, S5, S11). It
// is the projection every read of this package uses, so a history row and a single document are the
// same settlement and not two descriptions of it.
//
// It reads the ledgers of the period through the querier, which is why it is a step of its own: a
// caller that is still holding a row cursor of that querier has to close it first (List).
func deriveClosing(ctx context.Context, q querier, closing *Closing) error {
	// The columns of the period are drafts until the warehouse proposes, so an open settlement is
	// published with the money the ledgers hold for its window instead of with the zeros nobody
	// wrote (S1). Proposed, rejected and closed rows keep the columns the database froze.
	if closing.Status == StatusOpen {
		if err := draftPeriod(ctx, q, closing); err != nil {
			return err
		}
	}
	// The three numbers of S8 and S10 are derived here, never stored, so they cannot
	// disagree with the facts that produce them (L12). The expectation is the drawer's ONE rule over the
	// window of this settlement -- opening, the cash its sales collected and the signed effect of the
	// movements the branch wrote in it -- so the acta and the book of the same window state one number
	// (S4, S13); the net `CashExpenses` the document reports is already one term of that effect and is
	// never subtracted a second time.
	effect, err := windowSignedEffect(ctx, q, int16(closing.BranchID), closing.PeriodStart, closing.CutAt)
	if err != nil {
		return err
	}
	closing.CashEffective = effect
	expected, err := DrawerExpected(closing.OpeningCash, closing.CashSales, effect)
	if err != nil {
		return ErrUnavailable
	}
	closing.ExpectedCash = expected
	if closing.CountedCash != nil {
		difference, err := CashDifference(*closing.CountedCash, expected)
		if err != nil {
			return ErrUnavailable
		}
		closing.CashDifference = &difference
		if closing.ClosingCash != nil {
			taken, err := TakenCash(*closing.CountedCash, closing.ContributedCash, *closing.ClosingCash)
			if err != nil {
				return ErrUnavailable
			}
			closing.TakenCash = &taken
		}
	}
	// The purchase envelope is the second envelope of the branch (S1). Its opening, the purchases of
	// the window and its expectation are derived here for every state, because none of them is a
	// column: they are read from the same two tables, so a number can never be published that the
	// facts deny. The counted amount and the new amount are the database's columns, and the
	// difference is published only once the envelope was counted (S3, S5, S11).
	return derivePurchaseFund(ctx, q, closing)
}

// derivePurchaseFund publishes the purchase envelope of one scanned settlement: the amount the
// previous closure left in it, the sums of the purchases of its own window and the expectation
// they produce, plus the difference of the counted envelope against that expectation.
//
// It reads two things and never invents a third, and both are the book's (S5, S9). The opening is
// the fund the previous closed settlement of the same branch published, read by
// `settledPurchaseFund` -- the one read of a closed settlement's fund, which migration 052 states
// once for the acta, the opening and the card of the envelope -- and never from the live branch
// state: a closed row is immutable, so the number a period inherited cannot move afterwards.
// "Previous" is the closure at or before this settlement's own period start, which is the instant
// the opener inherited, so a history row of an old period never reads the envelope of a later one.
// The purchases are the documents of the window `[period_start, cut_at)` of the branch, with their
// counter-documents included as they are stored — negative amounts, so they subtract by construction
// (S3, S11). Zero when there is none of either, which is the state of a branch that has never closed
// and of a period with no purchases.
//
// One statement for both facts, so the envelope of one row describes one instant of one window, and
// the derivation stays the pure read every other derived number of this document is.
func derivePurchaseFund(ctx context.Context, q querier, closing *Closing) error {
	var opening, total, cash string
	// The opening is the previous closure's published fund and not a sum of this read: the fund of a
	// closed settlement is one number with one place (settled_purchase_fund, migration 052), so the
	// number this period inherits is the number the acta of that closure published, even for a
	// settlement that closed before a closure settled the fund through its book (S5, S9).
	err := q.QueryRow(ctx, `SELECT
  coalesce((SELECT settled_purchase_fund($1, previous.closed_at) FROM branch_closings previous
    WHERE previous.branch_location_id=$1 AND previous.status='closed'
      AND previous.closed_at <= $4
    ORDER BY previous.closed_at DESC LIMIT 1),0)::numeric(12,2)::text,
  coalesce((SELECT sum(purchase.total) FROM purchases purchase
    WHERE purchase.location_id=$1 AND purchase.created_at >= $2
      AND purchase.created_at < $3),0)::numeric(12,2)::text,
  coalesce((SELECT sum(purchase.paid_cash) FROM purchases purchase
    WHERE purchase.location_id=$1 AND purchase.created_at >= $2
      AND purchase.created_at < $3),0)::numeric(12,2)::text`,
		int16(closing.BranchID), closing.PeriodStart, closing.CutAt, closing.PeriodStart).
		Scan(&opening, &total, &cash)
	if err != nil {
		return fail(ctx)
	}
	closing.PurchaseFundOpening, closing.PurchasesTotal, closing.PurchasesCash =
		Money(opening), Money(total), Money(cash)
	// The opening is money the branch holds, so it is read as an amount and never negative. The two
	// sums of the window are net figures that keep their sign: a counter-document is stored with
	// negative amounts, so a window that returned more than it bought publishes a negative net and a
	// settlement whose expectation follows from it, instead of becoming unreadable (S3, S11).
	if _, ok := amountCents(closing.PurchaseFundOpening); !ok {
		return ErrUnavailable
	}
	for _, amount := range []Signed{Signed(closing.PurchasesTotal), Signed(closing.PurchasesCash)} {
		if _, ok := amount.Cents(); !ok {
			return ErrUnavailable
		}
	}
	expected, err := PurchaseFundExpected(closing.PurchaseFundOpening, Signed(closing.PurchasesCash))
	if err != nil {
		return ErrUnavailable
	}
	closing.PurchaseFundExpected = expected
	// The amount the warehouse leaves is the number that settlement published, read where that rule
	// lives (S5, S9). The closure of a settlement reconciles the book to the amount it states, so for
	// a settlement whose own closure wrote that movement the answer is the signed sum at its own
	// `closed_at`; for one whose closure wrote none -- a settlement closed before 051 settled the
	// fund through its book, or one that stated exactly what the book already held -- the answer is
	// the amount it settled, and this read never recomputes an acta that was already signed (052).
	if closing.Status == StatusClosed {
		settled, err := settledPurchaseFund(ctx, q, closing.BranchID, closing.ClosedAt)
		if err != nil {
			return err
		}
		if settled != nil {
			closing.PurchaseFundCash = settled
		}
	}
	if closing.PurchaseFundCounted == nil {
		// An envelope the warehouse has not counted states no difference: the count sheet of the
		// drawer is the only thing that blocks, and an uncounted envelope is not a difference of zero.
		return nil
	}
	difference, err := CashDifference(*closing.PurchaseFundCounted, expected)
	if err != nil {
		return ErrUnavailable
	}
	closing.PurchaseFundDifference = &difference
	return nil
}

// settledPurchaseFund is the fund one closed settlement published, read where that rule lives: the
// `settled_purchase_fund(branch, closed_at)` function of migration 052, which is the one place the
// acta, the opening of the next period and the card of the envelope all read. Its rule is:
//
//   - the signed sum of `purchase_fund_ledger` (048) at the settlement's own `closed_at` answers for
//     a settlement whose own closure wrote the movement that reconciled the book to it -- the row
//     whose `closing_id` names the settlement (051, 052) -- because that closure landed the book on
//     exactly the amount the settlement stated;
//   - the amount the settlement stated answers for every other closed settlement, and a historical
//     acta is never recalculated: a settlement closed before a closure settled the fund through its
//     book had no movement of its own, and reading the book for it would publish a number that
//     changed as soon as a later load or purchase landed in it;
//   - a settlement that stated nothing at all is answered by the book, because an unstated fund is
//     zero and not unknown (S7) and its closure left the book as it was.
//
// It returns the amount and no nil for a settlement the database knows: a caller reaching it holds
// that very row, and a closed settlement the function cannot find is a document this domain did not
// write, which fails closed instead of being published.
func settledPurchaseFund(ctx context.Context, q querier, branch int64,
	closedAt *time.Time) (*Money, error) {
	if closedAt == nil {
		return nil, ErrUnavailable
	}
	var published *string
	if err := q.QueryRow(ctx, `SELECT settled_purchase_fund($1,$2)::numeric(12,2)::text`,
		int16(branch), *closedAt).Scan(&published); err != nil {
		return nil, fail(ctx)
	}
	if published == nil {
		return nil, ErrUnavailable
	}
	amount := Money(*published)
	if _, ok := amountCents(amount); !ok {
		return nil, ErrUnavailable
	}
	return &amount, nil
}

// draftPeriod replaces the period columns of an open settlement with the money its own window
// holds, read by the very helper the proposal uses (S1, S3): the same ledgers, the same window
// and the same single rounding, so the drawer expectation the warehouse reads before proposing is
// the one the branch will be asked to accept.
//
// Only an open settlement is derived, because only an open one has period columns nobody wrote:
// the database records them on the transition the warehouse proposes, and from then on they are
// the frozen offer. A proposed or rejected row is exactly the offer the branch is answering or
// answered, and a closed one is the history its branch signed; deriving either of them would let
// a later sale or a later change of the configured rate rewrite a number that was already
// accepted, which is the immutability of the closure (S16).
//
// The commission of the draft uses the rate frozen on the row when it has one, and the branch's
// configured rate otherwise -- which is what every open row is today, because the database
// freezes the rate only on the proposal transition. The configured rate cannot disagree with the
// offer: Propose freezes the very rate it reads from the same table at that instant, and both
// sides apply it to the same period total with this package's one rounding (S6, S20), so the
// draft is a preview of exactly the amount a proposal made now would freeze.
func draftPeriod(ctx context.Context, q querier, closing *Closing) error {
	branch := int16(closing.BranchID)
	totals, err := periodTotals(ctx, q, branch, closing.PeriodStart, closing.CutAt)
	if err != nil {
		return err
	}
	closing.SalesTotal, closing.CashSales, closing.CashExpenses = totals.salesTotal, totals.cash,
		totals.expenses
	closing.CardTotal, closing.TransferTotal, closing.QRTotal = totals.card, totals.transfer, totals.qr
	rate := closing.CommissionRatePercent
	if rate == nil {
		configured, err := configuredRate(ctx, q, branch)
		if errors.Is(err, ErrNoCommissionRate) {
			// A branch without a configured rate has no commission to preview. The database admits
			// its settlement anyway and the proposal is what names the missing rate (LC003), so the
			// read publishes the period it can instead of hiding the whole document.
			return nil
		}
		if err != nil {
			return err
		}
		rate = &configured
	}
	commission, err := Commission(totals.salesTotal, *rate)
	if err != nil {
		return ErrUnavailable
	}
	closing.CommissionAmount = commission
	return nil
}

// loadCountLines reads the count sheet with the catalogue identity of every variant, in
// variant order, so the sheet is legible without a second lookup per line. The sheet counts the
// whole catalogue, so both kinds are published by the rule of their own kind: a battery row states
// its brand, model, capacity and polarity, and a product row its name and the detail the catalogue
// composes of its typed fields. Nothing is scanned into a non-nullable battery value, so a product
// line is read instead of failing the whole settlement closed (S2, S3).
func loadCountLines(ctx context.Context, q querier, id int64) ([]CountLine, error) {
	rows, err := q.Query(ctx, `SELECT line.variant_id,variant.catalog_entry_id,entry.kind,
  coalesce(entry.brand,''),coalesce(entry.model,''),entry.capacity_ah::text,coalesce(variant.polarity,''),
  coalesce(entry.name,''),line.expected_quantity,line.counted_quantity
 FROM closing_count_lines line
 JOIN catalog_variants variant ON variant.id=line.variant_id
 JOIN catalog_entries entry ON entry.id=variant.catalog_entry_id
 WHERE line.closing_id=$1 ORDER BY line.variant_id`, id)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	type sheetLine struct {
		variant         catalog.Row
		expected        int64
		countedQuantity *int64
	}
	sheet := make([]sheetLine, 0, 8)
	entries := make([]int32, 0, 4)
	for rows.Next() {
		var line sheetLine
		var capacity *string
		if rows.Scan(&line.variant.VariantID, &line.variant.CatalogEntryID, &line.variant.Kind,
			&line.variant.Brand, &line.variant.Model, &capacity, &line.variant.Polarity,
			&line.variant.Name, &line.expected, &line.countedQuantity) != nil {
			return nil, fail(ctx)
		}
		// A numeric column never travels as a float: its own text is parsed back into the canonical
		// decimal of the contract, and the product kind carries none.
		if capacity != nil {
			line.variant.Capacity = *capacity
		}
		if line.variant.VariantID < 1 || line.variant.CatalogEntryID < 1 || line.expected < 0 ||
			line.expected > MaxCounted ||
			(line.countedQuantity != nil && (*line.countedQuantity < 0 || *line.countedQuantity > MaxCounted)) ||
			(len(sheet) > 0 && int64(line.variant.VariantID) <= int64(sheet[len(sheet)-1].variant.VariantID)) {
			return nil, ErrUnavailable
		}
		if line.variant.Kind == catalog.OtherKind {
			entries = append(entries, int32(line.variant.CatalogEntryID))
		}
		sheet = append(sheet, line)
		if len(sheet) > MaxCountLines {
			return nil, ErrUnavailable
		}
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	// The typed fields of the products are one statement, never a lookup per line, and they are read
	// once every cursor of this sheet is closed.
	rows.Close()
	fields, err := catalog.ReadFields(ctx, q, entries)
	if err != nil {
		return nil, ErrUnavailable
	}
	lines := make([]CountLine, 0, len(sheet))
	for _, line := range sheet {
		identity, err := line.variant.Identity(fields[int(line.variant.CatalogEntryID)])
		if err != nil {
			return nil, ErrUnavailable
		}
		// The key of the row and the variant of the identity are the one value the database read, so a
		// line is never published with two different variants.
		lines = append(lines, CountLine{VariantID: int64(identity.VariantID), Identity: identity,
			CatalogEntryID: int64(line.variant.CatalogEntryID), ExpectedQuantity: line.expected,
			CountedQuantity: line.countedQuantity})
	}
	return lines, nil
}

// attachMaterialLines publishes the material sheet of every settlement of one read: the rows the
// opener seeded and the warehouse counted, with the difference and the delivery derived on read
// (S7, S8, S9). It is one statement for the whole read, which is what keeps the single document and
// each row of a page of the history describing their sheets the same way -- and it is called once
// every cursor of that read is closed, because a statement issued while another one is still open
// waits for a connection the cursor itself holds (List).
func attachMaterialLines(ctx context.Context, q querier, closings []*Closing) error {
	if len(closings) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(closings))
	for _, closing := range closings {
		ids = append(ids, closing.ID)
	}
	sheet, err := loadMaterialLines(ctx, q, ids)
	if err != nil {
		return err
	}
	for _, closing := range closings {
		lines, ok := sheet[closing.ID]
		if !ok {
			// A settlement whose period bought nothing has an empty sheet, never a missing one: the
			// document publishes `[]` so a client reads a count of zero rows instead of a null.
			lines = make([]MaterialLine, 0)
		}
		closing.MaterialLines = lines
	}
	return nil
}

// loadMaterialLines reads the material sheet of the asked settlements, in the order it is
// published: the used lines by model and then the scrap lines by material id (S8), which is the
// order of the columns the two partial unique indexes of the sheet key on. A used line carries its
// model and a scrap line the name of its material, joined from the reference table, so the sheet is
// legible without a second read; the expected quantity is the snapshot of the opening and the
// counted one is null while the warehouse has not counted the line.
func loadMaterialLines(ctx context.Context, q querier, ids []int64) (map[int64][]MaterialLine, error) {
	rows, err := q.Query(ctx, `SELECT line.closing_id,line.kind,coalesce(line.model,''),
  line.material_id,coalesce(material.name,''),line.expected_quantity::text,
  line.counted_quantity::text
 FROM closing_material_lines line
 LEFT JOIN materials material ON material.id=line.material_id
 WHERE line.closing_id=ANY($1)
 ORDER BY line.closing_id,(line.kind<>'used'),line.model COLLATE "C",line.material_id`, ids)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	sheet := make(map[int64][]MaterialLine, len(ids))
	for rows.Next() {
		var closingID int64
		var kind, model, name, expected string
		var materialID *int64
		var counted *string
		if rows.Scan(&closingID, &kind, &model, &materialID, &name, &expected, &counted) != nil {
			return nil, fail(ctx)
		}
		line := MaterialLine{Kind: MaterialKind(kind)}
		if line.Kind == MaterialKindUsed {
			// A used line names its model and has no material at all, on either side of the join.
			if materialID != nil || name != "" || !materialModelPattern.MatchString(model) {
				return nil, ErrUnavailable
			}
			key := model
			line.Model = &key
		} else {
			// A scrap line names its material and no model, and the reference table always answers
			// the name of a material: a row that lost it is a state this domain never wrote.
			if materialID == nil || *materialID < 1 || *materialID > MaxMaterialID || model != "" ||
				name == "" {
				return nil, ErrUnavailable
			}
			key := *materialID
			material := name
			line.MaterialID, line.Material = &key, &material
		}
		line.Unit = line.Kind.Unit()
		if line.Expected, err = storedQuantity(line.Kind, expected); err != nil {
			return nil, ErrUnavailable
		}
		if counted != nil {
			value, err := storedQuantity(line.Kind, *counted)
			if err != nil {
				return nil, ErrUnavailable
			}
			line.Counted = &value
		}
		if line.Difference, err = MaterialDifference(line.Counted, line.Expected, line.Kind); err != nil {
			return nil, ErrUnavailable
		}
		line.Delivered = MaterialDelivery(line.Counted)
		// The rows are the database's own order -- the used lines by model, the scrap ones by
		// material, never mixed -- so a sheet that breaks it is a chart this domain never wrote.
		if previous := sheet[closingID]; len(previous) > 0 {
			last := previous[len(previous)-1]
			if last.Kind != line.Kind {
				if last.Kind != MaterialKindUsed || line.Kind != MaterialKindScrap {
					return nil, ErrUnavailable
				}
			} else if !materialKeyAfter(last, line) {
				return nil, ErrUnavailable
			}
		}
		sheet[closingID] = append(sheet[closingID], line)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return sheet, nil
}

// storedQuantity reads one quantity of the sheet as the canonical text of its kind. The column is
// numeric(12,3) for both kinds, so a used line reads "4.000" and is published as the whole "4" its
// unit states, while a scrap line keeps its three decimals; a fraction of a unit is a state this
// domain never wrote and is never described.
func storedQuantity(kind MaterialKind, stored string) (Quantity, error) {
	milli, ok := quantityMilli(Quantity(stored))
	if !ok {
		return "", ErrUnavailable
	}
	quantity, err := quantityFromMilli(milli, kind)
	if err != nil {
		return "", ErrUnavailable
	}
	return quantity, nil
}

// materialKeyAfter reports whether the key of one material line sorts after another's, which is the
// order the sheet is read and published in: the models of the used lines and the ids of the scrap
// ones, each strictly ascending inside its kind.
func materialKeyAfter(previous, line MaterialLine) bool {
	if line.Kind == MaterialKindScrap {
		return previous.MaterialID != nil && line.MaterialID != nil &&
			*line.MaterialID > *previous.MaterialID
	}
	return previous.Model != nil && line.Model != nil && *line.Model > *previous.Model
}

// loadExpenses reads the expenses of the window one settlement covers: the branch's own ledger
// rows inside [period_start, cut_at) whose effect is a `gasto`, in the order the branch recorded
// them, so the document states the facts its total was computed from (S12). The window and the
// reading are the ones periodTotals uses, so the list and the total can never describe two
// different periods: the rows come from `branch_cash_ledger`, which means the correction of a gasto
// is listed beside the gasto it answers -- with its own kind, its positive amount and the movement
// it names -- instead of being a row only the total knew about (S13), and it means the window
// excludes the transfers a settlement writes (`closing_id IS NULL`, S5), which are the acta's own
// facts and never an expense of the period.
func loadExpenses(ctx context.Context, q querier, id int64) ([]Expense, error) {
	rows, err := q.Query(ctx, `SELECT expense.id,expense.branch_location_id,expense.amount::text,
  expense.description,expense.occurred_at,expense.created_by_account_id,
  expense.kind,expense.corrects_id
 FROM branch_cash_ledger expense
 JOIN branch_closings closing ON closing.branch_location_id=expense.branch_location_id
 WHERE closing.id=$1 AND expense.effect_kind='gasto' AND expense.closing_id IS NULL
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
			&expense.OccurredAt, &expense.CreatedByAccountID, &expense.Kind,
			&expense.CorrectsID) != nil {
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
		// The two kinds this list holds: an expense the branch paid out and the correction that
		// answers one. The correction always names exactly one movement, and no other row names one
		// (S6), so a shape the ledger's own check refuses is never described here either.
		if expense.Kind != metricsMovementExpense && expense.Kind != cashMovementCorrection {
			return nil, ErrUnavailable
		}
		if (expense.Kind == cashMovementCorrection) != (expense.CorrectsID != nil) ||
			(expense.CorrectsID != nil && *expense.CorrectsID < 1) {
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
	for _, amount := range []*Money{payload.CountedCash, payload.ClosingCash, payload.PurchaseFundCounted,
		payload.PurchaseFundCash} {
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
// the line both the proposal (LC019) and the closure (LC006) refuse by. The opener seeds every
// line with its expected quantity (S1), so no live sheet reaches it and this read is the safety
// net of a sheet written before that seeding, or of a line emptied out of band (S3). It reports
// pgx.ErrNoRows when every line
// is counted, so a caller keeps its own answer for a read that fails.
func pendingVariant(ctx context.Context, q querier, id int64) (int64, error) {
	var variant int64
	err := q.QueryRow(ctx, `SELECT variant_id FROM closing_count_lines
 WHERE closing_id=$1 AND counted_quantity IS NULL ORDER BY variant_id LIMIT 1`, id).Scan(&variant)
	return variant, err
}

// mapProposalFailure publishes the database's own refusal of a proposal transition. LC019 is "a
// variant has no counted quantity" read at the transition: the store already checked the sheet,
// and the opener seeded it (S1), so what the database answered is a sheet written before that
// seeding or the count changing between that check and its own statement. The reaction is to
// re-read the settlement and propose again, never to report an outage, and only the database
// knows which variant lost its line -- so the pending line is read back instead of the message
// the trigger composed. Every other refusal keeps the plain mapping.
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

// CorrectionTargetInvalid is the refusal of a correction that names a movement the book may not answer:
// an unknown movement, one of another branch, another correction, the transfer of a settlement, or a
// movement of a period a closure already signed (LC030, S6, S7). It unwraps to ErrInvalid, so a caller
// that only knows the class still recognises it; the correction route publishes it under its own code
// because "the target is wrong" is the fact the branch acts on, and a generic invalid request is not.
type CorrectionTargetInvalid struct{}

func (e *CorrectionTargetInvalid) Error() string {
	return "the movement this correction names is not one it may answer"
}

// Unwrap keeps errors.Is(err, ErrInvalid) true for the named refusal.
func (e *CorrectionTargetInvalid) Unwrap() error { return ErrInvalid }

// CorrectionExceeds is the refusal of a correction that would take the corrections of one movement above
// the amount that movement stated (LC031, S6). It unwraps to ErrStateConflict, so the class is a
// conflict and never an outage, and the correction route names the excess the branch wrote.
type CorrectionExceeds struct{}

func (e *CorrectionExceeds) Error() string {
	return "the corrections of a movement never exceed the amount it stated"
}

// Unwrap keeps errors.Is(err, ErrStateConflict) true for the named refusal.
func (e *CorrectionExceeds) Unwrap() error { return ErrStateConflict }

// DrawerInsufficient is the refusal of a movement the branch's till does not hold (LC032, S1-S4): the
// amount the movement states would leave the drawer below zero, so the branch states a smaller one or
// records the cash it is spending. It carries both quantities the operator acts on -- what the till
// holds and what the movement asked -- and unwraps to ErrStateConflict, so the class is a conflict and
// never an outage. The balance is a signed quantity, because a till that is already negative publishes
// that negative the way the database states it.
type DrawerInsufficient struct {
	Balance   Signed
	Requested Money
}

func (e *DrawerInsufficient) Error() string {
	return "the branch drawer holds " + string(e.Balance) + " and the movement states " +
		string(e.Requested)
}

// Unwrap keeps errors.Is(err, ErrStateConflict) true for the named refusal.
func (e *DrawerInsufficient) Unwrap() error { return ErrStateConflict }

// drawerRefusal reports the SQLSTATE of the bound 060 places on the branch's till: the movement would
// spend more than the drawer holds.
func drawerRefusal(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "LC032"
}

// drawerBalanceOf reads what the branch's till holds through the one expression the admission reads it
// with, so the refusal states the number the rule saw instead of a second arithmetic of the window. The
// number is signed: a drawer that is already below zero -- the one of every instance upgraded from 059,
// whose movements 060 rewrites in no part -- reads as the negative the database states ("-50.00"), so it
// is read with the one rule of a signed amount instead of the one a movement is written with.
func (s *Store) drawerBalanceOf(ctx context.Context, branchID int) (Signed, error) {
	var stored string
	if err := s.pool.QueryRow(ctx, `SELECT branch_drawer_expected($1)::text`,
		int16(branchID)).Scan(&stored); err != nil {
		return "", mapFailure(ctx, err)
	}
	balance := Signed(stored)
	if _, ok := balance.Cents(); !ok {
		return "", ErrUnavailable
	}
	return balance, nil
}

// cashWriteRefusal publishes the refusal of one write to the branch's book (S4), and it is the ONE mapping
// of that refusal: both writers of the book call it, so the two routes cannot drift into publishing the
// same fact differently. The bound of the till answers with its own refusal, stated with the two
// quantities the branch acts on -- what the drawer holds, read through the expression the admission read,
// and what the movement asked -- and every other refusal keeps the mapping of the book's own codes
// (LC001, LC011, LC030, LC031) with its precedence unchanged.
func (s *Store) cashWriteRefusal(ctx context.Context, branchID int, requested Money, err error) error {
	if drawerRefusal(err) {
		balance, readErr := s.drawerBalanceOf(ctx, branchID)
		if readErr != nil {
			return readErr
		}
		return &DrawerInsufficient{Balance: balance, Requested: requested}
	}
	return mapCashCorrectionFailure(ctx, err)
}

// mapCashCorrectionFailure publishes the refusal of a movement of the branch's book. The two corrections of
// this domain are named for the route that acts on them -- a target the book may not answer (LC030) and
// a set of corrections above the amount corrected (LC031), both of migration 046 -- and every other
// refusal, including the freeze of the branch and the admission of the ledger, keeps the plain mapping.
func mapCashCorrectionFailure(ctx context.Context, err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "LC030":
			return &CorrectionTargetInvalid{}
		case "LC031":
			return &CorrectionExceeds{}
		}
	}
	return mapFailure(ctx, err)
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
		case "LC004", "LC025":
			// The sheet of the stock and the sheet of the materials are written while the warehouse
			// holds the settlement, and only the counted quantity moves in either (LC004, LC025).
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
		case "LC030":
			// A correction names a movement it may not answer: an unknown movement, one of another
			// branch, another correction, a settlement's transfer, or a movement of a period a closure
			// already signed (046, S6, S7). The correction path names the fact itself through
			// mapCashCorrectionFailure; this is the class of the same refusal.
			return ErrInvalid
		case "LC031":
			// The corrections of one movement exceed the amount it stated (046, S6). The correction
			// path names the excess through mapCashCorrectionFailure; this is the class of the same
			// refusal.
			return ErrStateConflict
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
