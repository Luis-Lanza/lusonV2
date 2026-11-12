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
	err = tx.QueryRow(ctx, `INSERT INTO branch_closings(branch_location_id,period_start,opened_by_account_id)
 VALUES($1,now(),$2) RETURNING id`, int16(branchID), int64(actor.AccountID)).Scan(&id)
	if err != nil {
		return Closing{}, mapOpenFailure(ctx, err, branchID)
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
	var pending int64
	err = tx.QueryRow(ctx, `SELECT variant_id FROM closing_count_lines
 WHERE closing_id=$1 AND counted_quantity IS NULL ORDER BY variant_id LIMIT 1`, id).Scan(&pending)
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
	if _, err := tx.Exec(ctx, `UPDATE branch_closings SET status='proposed',cash_expenses=$2
 WHERE id=$1 AND status IN ('open','rejected')`, id, string(totals.expenses)); err != nil {
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
		var pending int64
		err = tx.QueryRow(ctx, `SELECT variant_id FROM closing_count_lines
 WHERE closing_id=$1 AND counted_quantity IS NULL ORDER BY variant_id LIMIT 1`, id).Scan(&pending)
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
		if _, err := tx.Exec(ctx, `UPDATE branch_closings SET status='closed'
 WHERE id=$1 AND status='proposed'`, id); err != nil {
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

// loadClosing reads one settlement with the database's own money, its count sheet and its
// proposal rounds, and derives the three cash numbers that are never persisted.
func loadClosing(ctx context.Context, q querier, id int64) (Closing, error) {
	var closing Closing
	var status, rate string
	var counted, fund *string
	err := q.QueryRow(ctx, `SELECT c.id,c.branch_location_id,l.name,c.status,
  c.period_start,c.cut_at,c.closed_at,coalesce(c.commission_rate_percent::text,''),
  c.opening_cash::text,c.cash_sales::text,c.cash_expenses::text,c.sales_total::text,
  c.commission_amount::text,c.card_total::text,c.transfer_total::text,c.qr_total::text,
  c.counted_cash::text,c.contributed_cash::text,c.closing_cash::text,c.observation,
  c.opened_by_account_id
 FROM branch_closings c JOIN locations l ON l.id=c.branch_location_id WHERE c.id=$1`, id).Scan(
		&closing.ID, &closing.BranchID, &closing.BranchName, &status,
		&closing.PeriodStart, &closing.CutAt, &closing.ClosedAt, &rate,
		&closing.OpeningCash, &closing.CashSales, &closing.CashExpenses, &closing.SalesTotal,
		&closing.CommissionAmount, &closing.CardTotal, &closing.TransferTotal, &closing.QRTotal,
		&counted, &closing.ContributedCash, &fund, &closing.Observation,
		&closing.OpenedByAccountID)
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
	if closing.CountLines, err = loadCountLines(ctx, q, id); err != nil {
		return Closing{}, err
	}
	if closing.Rounds, err = loadRounds(ctx, q, id); err != nil {
		return Closing{}, err
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

// mapOpenFailure publishes the database's own decision for an open and nothing else.
func mapOpenFailure(ctx context.Context, err error, branchID int64) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "LC017" {
		return &RetiredBranch{BranchID: branchID}
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
		case "LC006":
			return ErrClosureRefused
		case "LC007":
			return ErrReservedStock
		case "LC016":
			return ErrRoundNotAccepted
		case "LC017":
			return ErrInvalid
		case "23505":
			if strings.Contains(pg.ConstraintName, "branch_closings_one_live") {
				return ErrLiveConflict
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
