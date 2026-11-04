package stockentries

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
	"luson/api/internal/catalog"
)

type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// fail retains cancellation semantics but never driver/config/SQL details.
func fail(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrUnavailable
}

// entryLock serializes one operation key, so an identical concurrent submission
// resolves to a replay instead of a unique violation. Transaction scoped: the
// database releases it on commit, rollback or disconnect.
func entryLock(key string) int64 {
	h := sha256.Sum256([]byte("luson.stock-entry/retry/v1:" + key))
	return int64(binary.BigEndian.Uint64(h[:8]))
}

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// checkAssignment reuses creation's provisioned-account binding: a positive
// location id alone is not evidence that this account is assigned to it.
func checkAssignment(ctx context.Context, q querier, actor auth.Identity) error {
	var provisioned bool
	if err := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM auth_accounts WHERE id=$1 AND location_id=$2)", actor.AccountID, actor.Location.ID).Scan(&provisioned); err != nil {
		return fail(ctx)
	}
	if !provisioned {
		return ErrForbidden
	}
	return nil
}

// CreateEntry applies one immutable ingress document atomically. The warehouse
// administrator is the only admitted actor; the canonical payload is resolved
// first, so an identical replay returns the persisted document and a different
// payload under the same operation key is a conflict, never a second document.
// Lines are inserted in ascending variant order, which is the database's
// balance-row lock order.
func (s *Store) CreateEntry(ctx context.Context, actor auth.Identity, input CreateInput) (Entry, bool, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Entry{}, false, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return Entry{}, false, ErrForbidden
	}
	canonical, err := Validate(input)
	if err != nil {
		return Entry{}, false, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Entry{}, false, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", entryLock(canonical.OperationKey)); err != nil {
		return Entry{}, false, fail(ctx)
	}
	if err := checkAssignment(ctx, tx, actor); err != nil {
		return Entry{}, false, err
	}
	var id int64
	err = tx.QueryRow(ctx, "SELECT id FROM stock_entries WHERE operation_key=$1", canonical.OperationKey).Scan(&id)
	if err == nil {
		entry, err := loadEntry(ctx, tx, id)
		if err != nil {
			return Entry{}, false, err
		}
		if entry.Note != canonical.Note || !sameLines(entry.Lines, canonical.Lines) {
			return Entry{}, false, ErrRetryConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return Entry{}, false, fail(ctx)
		}
		return entry, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Entry{}, false, fail(ctx)
	}
	err = tx.QueryRow(ctx, `INSERT INTO stock_entries(operation_key,location_id,note,created_by_account_id)
 VALUES($1,$2,$3,$4) RETURNING id`, canonical.OperationKey, warehouseLocationID, canonical.Note, actor.AccountID).Scan(&id)
	if err != nil {
		return Entry{}, false, mapFailure(ctx, err)
	}
	for _, line := range canonical.Lines {
		if _, err := tx.Exec(ctx, "INSERT INTO stock_entry_lines(entry_id,variant_id,quantity) VALUES($1,$2,$3)", id, int32(line.VariantID), line.Quantity); err != nil {
			return Entry{}, false, mapFailure(ctx, err)
		}
	}
	entry, err := loadEntry(ctx, tx, id)
	if err != nil {
		return Entry{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Entry{}, false, mapFailure(ctx, err)
	}
	return entry, false, nil
}

// ReverseEntry appends the immutable counter-entry of one original document. The
// client never supplies lines: they are derived from the persisted original, so a
// partial reversal is impossible by construction, and the whole reversal is
// refused when it would leave any line below its reserved quantity.
//
// The operation key is serialized first, so an identical concurrent submission
// resolves to a replay instead of a unique violation. A pure request shape is
// rejected before the transaction; everything the database decides (reversal
// mirror, single counter-entry, covered stock) is trusted only through its
// SQLSTATE.
func (s *Store) ReverseEntry(ctx context.Context, actor auth.Identity, targetID int64, operationKey, reason string) (Entry, bool, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Entry{}, false, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return Entry{}, false, ErrForbidden
	}
	if targetID < 1 {
		return Entry{}, false, ErrNotFound
	}
	if !ValidOperationKey(operationKey) {
		return Entry{}, false, ErrInvalid
	}
	canonicalReason, valid := CanonicalReason(reason)
	if !valid {
		return Entry{}, false, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Entry{}, false, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", entryLock(operationKey)); err != nil {
		return Entry{}, false, fail(ctx)
	}
	if err := checkAssignment(ctx, tx, actor); err != nil {
		return Entry{}, false, err
	}
	// An existing operation key is resolved before the target is touched: the
	// same key with the same target and reason is a replay, anything else is a
	// conflict and never a second counter-entry.
	var existingID int64
	var existingTarget *int64
	var existingReason string
	err = tx.QueryRow(ctx, "SELECT id,reverses_entry_id,reason FROM stock_entries WHERE operation_key=$1", operationKey).Scan(&existingID, &existingTarget, &existingReason)
	if err == nil {
		entry, loadErr := loadEntry(ctx, tx, existingID)
		if loadErr != nil {
			return Entry{}, false, loadErr
		}
		if existingTarget == nil || *existingTarget != targetID || existingReason != canonicalReason {
			return Entry{}, false, ErrRetryConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return Entry{}, false, fail(ctx)
		}
		return entry, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Entry{}, false, fail(ctx)
	}
	// The target row is locked before it is judged, so a concurrent reversal of
	// the same document cannot slip between the check and the insert.
	var location int
	var targetReverses *int64
	var alreadyReversed bool
	err = tx.QueryRow(ctx, `SELECT e.location_id,e.reverses_entry_id,
  EXISTS(SELECT 1 FROM stock_entries counter WHERE counter.reverses_entry_id=e.id)
 FROM stock_entries e WHERE e.id=$1 FOR UPDATE`, targetID).Scan(&location, &targetReverses, &alreadyReversed)
	if errors.Is(err, pgx.ErrNoRows) {
		return Entry{}, false, ErrNotFound
	}
	if err != nil {
		return Entry{}, false, fail(ctx)
	}
	// A document of another location is not part of this warehouse's ledger.
	if location != warehouseLocationID {
		return Entry{}, false, ErrNotFound
	}
	if targetReverses != nil || alreadyReversed {
		return Entry{}, false, ErrDecisionConflict
	}
	derived, err := derivedLines(ctx, tx, targetID)
	if err != nil {
		return Entry{}, false, err
	}
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO stock_entries(operation_key,location_id,note,reverses_entry_id,reason,created_by_account_id)
 VALUES($1,$2,'',$3,$4,$5) RETURNING id`, operationKey, warehouseLocationID, targetID, canonicalReason, actor.AccountID).Scan(&id)
	if err != nil {
		return Entry{}, false, mapFailure(ctx, err)
	}
	// Ascending variant order is the database's balance-row lock order.
	for _, line := range derived {
		if _, err := tx.Exec(ctx, "INSERT INTO stock_entry_lines(entry_id,variant_id,quantity) VALUES($1,$2,$3)", id, int32(line.VariantID), line.Quantity); err != nil {
			return Entry{}, false, mapFailure(ctx, err)
		}
	}
	entry, err := loadEntry(ctx, tx, id)
	if err != nil {
		return Entry{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Entry{}, false, mapFailure(ctx, err)
	}
	return entry, false, nil
}

// derivedLines mirrors the persisted original: every line is negated, in the
// original's ascending variant order. A persisted line outside the admitted
// ingress bounds means the ledger is not what this domain wrote, so it fails
// closed instead of deriving a document the database would reject.
func derivedLines(ctx context.Context, q querier, targetID int64) ([]Line, error) {
	rows, err := q.Query(ctx, "SELECT variant_id,quantity FROM stock_entry_lines WHERE entry_id=$1 ORDER BY variant_id", targetID)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	lines := make([]Line, 0)
	for rows.Next() {
		var line Line
		if rows.Scan(&line.VariantID, &line.Quantity) != nil {
			return nil, fail(ctx)
		}
		if line.VariantID < 1 || line.VariantID > math.MaxInt32 || line.Quantity < 1 || line.Quantity > maxQuantity {
			return nil, ErrUnavailable
		}
		line.Quantity = -line.Quantity
		lines = append(lines, line)
		if len(lines) > maxLines {
			return nil, ErrUnavailable
		}
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	if len(lines) == 0 {
		return nil, ErrUnavailable
	}
	return lines, nil
}

// ListEntries reads one newest-first page of persisted documents for the
// warehouse. The actor guard and the provisioned-account binding are creation's,
// and the page is one statement plus one total: line counts and unit totals are
// summed by the database, never by a Go loop over every line. The unit total is
// cast to text before it becomes an int64, so an out-of-range sum fails closed
// instead of wrapping.
func (s *Store) ListEntries(ctx context.Context, actor auth.Identity, page, pageSize int) (EntryPage, error) {
	result := EntryPage{Page: page, PageSize: pageSize, Entries: []EntrySummary{}}
	if ctx == nil || s == nil || s.pool == nil {
		return EntryPage{}, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return EntryPage{}, ErrForbidden
	}
	// Every rejected page or size stops here, before the first statement.
	if !ValidPage(page, pageSize) {
		return EntryPage{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return EntryPage{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return EntryPage{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if tx.QueryRow(ctx, "SELECT count(*) FROM stock_entries WHERE location_id=$1", warehouseLocationID).Scan(&result.TotalEntries) != nil {
		return EntryPage{}, fail(ctx)
	}
	rows, err := tx.Query(ctx, `SELECT e.id,e.note,e.created_at,
  count(l.variant_id)::bigint,
  coalesce(sum(l.quantity),0)::text,
  (SELECT counter.id FROM stock_entries counter WHERE counter.reverses_entry_id=e.id)
 FROM stock_entries e
 LEFT JOIN stock_entry_lines l ON l.entry_id=e.id
 WHERE e.location_id=$1
 GROUP BY e.id
 ORDER BY e.id DESC
 LIMIT $2 OFFSET $3`, warehouseLocationID, int64(pageSize), int64(page-1)*int64(pageSize))
	if err != nil {
		return EntryPage{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var summary EntrySummary
		var lines int64
		var units string
		if rows.Scan(&summary.ID, &summary.Note, &summary.CreatedAt, &lines, &units, &summary.ReversedBy) != nil {
			return EntryPage{}, fail(ctx)
		}
		// A persisted document always has between one and maxLines lines.
		if lines < 1 || lines > maxLines {
			return EntryPage{}, ErrUnavailable
		}
		total, err := strconv.ParseInt(units, 10, 64)
		if err != nil || total > maxLines*maxQuantity || total < -(maxLines*maxQuantity) {
			return EntryPage{}, ErrUnavailable
		}
		summary.Lines = int(lines)
		summary.TotalUnits = total
		result.Entries = append(result.Entries, summary)
	}
	if rows.Err() != nil {
		return EntryPage{}, fail(ctx)
	}
	if tx.Commit(ctx) != nil {
		return EntryPage{}, fail(ctx)
	}
	return result, nil
}

// ReadEntry reads one persisted document with its lines joined to the catalogue:
// the actor guard and the provisioned-account binding are creation's, the snapshot
// is the history read's (RepeatableRead, read-only), and the document is resolved
// by one header statement plus one variant-ordered line statement, so the
// catalogue identity of a line is never an N+1 lookup. Capacity is rendered by the
// same `::text` + catalog.ParseDecimal pair the inventory read uses, and a document
// of another location is not part of this warehouse's ledger: it is not found.
func (s *Store) ReadEntry(ctx context.Context, actor auth.Identity, id int64) (EntryDetail, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return EntryDetail{}, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return EntryDetail{}, ErrForbidden
	}
	// Only a positive document id reaches the database; an aliased or impossible one
	// stays not found exactly like an unknown document.
	if id < 1 {
		return EntryDetail{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return EntryDetail{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return EntryDetail{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	var detail EntryDetail
	err = tx.QueryRow(ctx, `SELECT e.id,e.location_id,e.note,e.created_by_account_id,e.created_at,e.reverses_entry_id,e.reason,
  (SELECT counter.id FROM stock_entries counter WHERE counter.reverses_entry_id=e.id)
 FROM stock_entries e WHERE e.id=$1 AND e.location_id=$2`, id, warehouseLocationID).Scan(
		&detail.ID, &detail.LocationID, &detail.Note, &detail.CreatedByAccountID, &detail.CreatedAt,
		&detail.ReversesEntryID, &detail.Reason, &detail.ReversedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return EntryDetail{}, ErrNotFound
	}
	if err != nil {
		return EntryDetail{}, fail(ctx)
	}
	rows, err := tx.Query(ctx, `SELECT l.variant_id,e.brand,e.model,e.capacity_ah::text,v.polarity,l.quantity
 FROM stock_entry_lines l
 JOIN catalog_variants v ON v.id=l.variant_id
 JOIN catalog_entries e ON e.id=v.catalog_entry_id
 WHERE l.entry_id=$1 ORDER BY l.variant_id`, id)
	if err != nil {
		return EntryDetail{}, fail(ctx)
	}
	defer rows.Close()
	lines := make([]DetailLine, 0, 8)
	var total int64
	for rows.Next() {
		var line DetailLine
		var capacity string
		if rows.Scan(&line.VariantID, &line.Brand, &line.Model, &capacity, &line.Polarity, &line.Quantity) != nil {
			return EntryDetail{}, fail(ctx)
		}
		// A persisted line outside the admitted bounds means the ledger is not what
		// this domain wrote, so the read fails closed instead of describing it.
		if line.VariantID < 1 || line.VariantID > math.MaxInt32 || line.Brand == "" || line.Model == "" ||
			(line.Polarity != "L" && line.Polarity != "R") || line.Quantity == 0 ||
			line.Quantity > maxQuantity || line.Quantity < -maxQuantity ||
			(len(lines) > 0 && line.VariantID <= lines[len(lines)-1].VariantID) {
			return EntryDetail{}, ErrUnavailable
		}
		if line.Capacity, err = catalog.ParseDecimal(capacity); err != nil {
			return EntryDetail{}, ErrUnavailable
		}
		if (line.Quantity > 0 && total > math.MaxInt64-line.Quantity) ||
			(line.Quantity < 0 && total < math.MinInt64-line.Quantity) {
			return EntryDetail{}, ErrUnavailable
		}
		total += line.Quantity
		lines = append(lines, line)
		if len(lines) > maxLines {
			return EntryDetail{}, ErrUnavailable
		}
	}
	if rows.Err() != nil {
		return EntryDetail{}, fail(ctx)
	}
	if len(lines) == 0 {
		return EntryDetail{}, ErrUnavailable
	}
	// A counter-entry negates its original and always states why; an ingress
	// document has no motive of its own and only ever adds units.
	if detail.ReversesEntryID != nil {
		reason, valid := CanonicalReason(detail.Reason)
		if *detail.ReversesEntryID < 1 || *detail.ReversesEntryID >= detail.ID || !valid || reason != detail.Reason || total > -1 {
			return EntryDetail{}, ErrUnavailable
		}
	} else if detail.Reason != "" || total < 1 {
		return EntryDetail{}, ErrUnavailable
	}
	// A document can only be reversed by a later document of this warehouse.
	if detail.ReversedBy != nil && (*detail.ReversedBy < 1 || *detail.ReversedBy <= detail.ID) {
		return EntryDetail{}, ErrUnavailable
	}
	detail.Lines = lines
	detail.TotalUnits = total
	if tx.Commit(ctx) != nil {
		return EntryDetail{}, fail(ctx)
	}
	return detail, nil
}

// loadEntry reads the durable document: lines ordered by variant id and the
// total computed only after an exact int64 bound check on every line. The
// reversal target is internal only; it never reaches the wire.
func loadEntry(ctx context.Context, q querier, id int64) (Entry, error) {
	var entry Entry
	err := q.QueryRow(ctx, `SELECT id,location_id,note,created_by_account_id,created_at,reverses_entry_id
 FROM stock_entries WHERE id=$1 AND location_id=$2`, id, warehouseLocationID).Scan(
		&entry.ID, &entry.LocationID, &entry.Note, &entry.CreatedByAccountID, &entry.CreatedAt, &entry.ReversesEntryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Entry{}, ErrUnavailable
	}
	if err != nil {
		return Entry{}, fail(ctx)
	}
	rows, err := q.Query(ctx, "SELECT variant_id,quantity FROM stock_entry_lines WHERE entry_id=$1 ORDER BY variant_id", id)
	if err != nil {
		return Entry{}, fail(ctx)
	}
	defer rows.Close()
	lines := []EntryLine{}
	var total int64
	for rows.Next() {
		var line EntryLine
		if rows.Scan(&line.VariantID, &line.Quantity) != nil {
			return Entry{}, fail(ctx)
		}
		if (line.Quantity > 0 && total > math.MaxInt64-line.Quantity) ||
			(line.Quantity < 0 && total < math.MinInt64-line.Quantity) {
			return Entry{}, ErrUnavailable
		}
		total += line.Quantity
		lines = append(lines, line)
	}
	if rows.Err() != nil {
		return Entry{}, fail(ctx)
	}
	entry.Lines = lines
	entry.TotalUnits = total
	return entry, nil
}

// mapFailure publishes the database's own decision and nothing else: SQLSTATE
// is the only trusted evidence, and cancellation keeps its semantics.
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
		case "LS001":
			return ErrInsufficientStock
		case "LS002", "LS003", "LS005", "LS006", "LS007":
			return ErrInvalid
		}
	}
	return ErrUnavailable
}
