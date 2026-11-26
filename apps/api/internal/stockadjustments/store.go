package stockadjustments

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math"
	"strconv"
	"strings"
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

// adjustmentLock serializes one operation key, so an identical concurrent
// submission resolves to a replay instead of a unique violation. Transaction
// scoped: the database releases it on commit, rollback or disconnect. It is
// namespaced away from the stock ingress key space.
func adjustmentLock(key string) int64 {
	h := sha256.Sum256([]byte("luson.stock-adjustment/retry/v1:" + key))
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

// checkVariants refuses a document that names a variant outside the catalogue and
// any document that mixes kinds, before the ledger is touched: an unknown variant
// is a request error, one document is of one kind derived from its lines and never
// stored, and one document is applied completely or not at all.
func checkVariants(ctx context.Context, q querier, lines []Line) error {
	ids := make([]int32, len(lines))
	for i, line := range lines {
		ids[i] = int32(line.VariantID)
	}
	var known, kinds int64
	if err := q.QueryRow(ctx, `SELECT count(*),count(DISTINCT e.kind) FROM catalog_variants v
 JOIN catalog_entries e ON e.id=v.catalog_entry_id WHERE v.id = ANY($1) AND e.deleted_at IS NULL`, ids).Scan(&known, &kinds); err != nil {
		return fail(ctx)
	}
	if known != int64(len(lines)) || kinds > 1 {
		return ErrInvalid
	}
	return nil
}

// Create applies one immutable physical-count document atomically, in the actor's own
// location. Any operating account may record one (S36.1): the section states the session and
// the document is written where that account counts, never where a request says. The
// canonical payload is resolved first, so an identical replay returns the persisted document
// and a different payload under the same operation key is a conflict, never a second
// document. The client supplies counted quantities only: the database overwrites the expected
// snapshot from its own locked balance and applies the difference. Lines are inserted in
// ascending variant order, which is the database's balance-row lock order.
func (s *Store) Create(ctx context.Context, actor auth.Identity, input CreateInput) (Adjustment, bool, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Adjustment{}, false, ErrUnavailable
	}
	if !adjustingAccount(actor) {
		return Adjustment{}, false, ErrForbidden
	}
	location := actor.Location.ID
	canonical, err := Validate(input)
	if err != nil {
		return Adjustment{}, false, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Adjustment{}, false, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", adjustmentLock(canonical.OperationKey)); err != nil {
		return Adjustment{}, false, fail(ctx)
	}
	if err := checkAssignment(ctx, tx, actor); err != nil {
		return Adjustment{}, false, err
	}
	// An operation key is one intent of one location: the same key from another location
	// states a different payload -- the location is part of it -- so it is a conflict and
	// never a replay of another location's document.
	var id int64
	var storedLocation int
	err = tx.QueryRow(ctx, "SELECT id,location_id FROM stock_adjustments WHERE operation_key=$1", canonical.OperationKey).Scan(&id, &storedLocation)
	if err == nil {
		if storedLocation != location {
			return Adjustment{}, false, ErrRetryConflict
		}
		adjustment, err := loadAdjustment(ctx, tx, id, location)
		if err != nil {
			return Adjustment{}, false, err
		}
		if adjustment.Reason != canonical.Reason || adjustment.Detail != canonical.Detail ||
			!sameLines(adjustment.Lines, canonical.Lines) {
			return Adjustment{}, false, ErrRetryConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return Adjustment{}, false, fail(ctx)
		}
		return adjustment, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Adjustment{}, false, fail(ctx)
	}
	if err := checkVariants(ctx, tx, canonical.Lines); err != nil {
		return Adjustment{}, false, err
	}
	err = tx.QueryRow(ctx, `INSERT INTO stock_adjustments(operation_key,location_id,reason,detail,created_by_account_id)
 VALUES($1,$2,$3,$4,$5) RETURNING id`,
		canonical.OperationKey, location, canonical.Reason, canonical.Detail, actor.AccountID).Scan(&id)
	if err != nil {
		return Adjustment{}, false, mapFailure(ctx, err)
	}
	for _, line := range canonical.Lines {
		// expected_quantity is supplied only because the column is NOT NULL: the
		// database's admission trigger overwrites it with its own locked balance,
		// which is the blind-count contract, never a caller promise.
		if _, err := tx.Exec(ctx, `INSERT INTO stock_adjustment_lines(adjustment_id,variant_id,expected_quantity,counted_quantity)
 VALUES($1,$2,0,$3)`, id, int32(line.VariantID), line.Counted); err != nil {
			return Adjustment{}, false, mapFailure(ctx, err)
		}
	}
	adjustment, err := loadAdjustment(ctx, tx, id, location)
	if err != nil {
		return Adjustment{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Adjustment{}, false, mapFailure(ctx, err)
	}
	return adjustment, false, nil
}

// Reverse appends the immutable counter-entry of one original document. The client
// never supplies lines: they are derived from the persisted original with counted
// and expected swapped, so a partial reversal is impossible by construction, and
// the whole reversal is refused when it would leave any line below its reserved
// quantity.
//
// The operation key is serialized first, so an identical concurrent submission
// resolves to a replay instead of a unique violation. A pure request shape is
// rejected before the transaction; everything the database decides (reversal
// mirror, single counter-entry, covered stock) is trusted only through its
// SQLSTATE. The counter-entry follows its original: it is written in the original's
// location, and only the account that counts there can reverse it (S36.1).
func (s *Store) Reverse(ctx context.Context, actor auth.Identity, targetID int64, operationKey, reason string) (Adjustment, bool, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Adjustment{}, false, ErrUnavailable
	}
	if !adjustingAccount(actor) {
		return Adjustment{}, false, ErrForbidden
	}
	if targetID < 1 {
		return Adjustment{}, false, ErrNotFound
	}
	if !ValidOperationKey(operationKey) {
		return Adjustment{}, false, ErrInvalid
	}
	canonicalReason, valid := CanonicalReason(reason)
	if !valid {
		return Adjustment{}, false, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Adjustment{}, false, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", adjustmentLock(operationKey)); err != nil {
		return Adjustment{}, false, fail(ctx)
	}
	if err := checkAssignment(ctx, tx, actor); err != nil {
		return Adjustment{}, false, err
	}
	// An existing operation key is resolved before the target is touched: the same
	// key with the same target and reason is a replay, anything else is a conflict
	// and never a second counter-entry. The key is one intent of one location, so a
	// key another location already spent is a conflict too.
	var existingID int64
	var existingLocation int
	var existingTarget *int64
	var existingReason string
	err = tx.QueryRow(ctx, "SELECT id,location_id,reverses_adjustment_id,reason FROM stock_adjustments WHERE operation_key=$1", operationKey).Scan(&existingID, &existingLocation, &existingTarget, &existingReason)
	if err == nil {
		if existingLocation != actor.Location.ID {
			return Adjustment{}, false, ErrRetryConflict
		}
		adjustment, loadErr := loadAdjustment(ctx, tx, existingID, actor.Location.ID)
		if loadErr != nil {
			return Adjustment{}, false, loadErr
		}
		if existingTarget == nil || *existingTarget != targetID || existingReason != canonicalReason {
			return Adjustment{}, false, ErrRetryConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return Adjustment{}, false, fail(ctx)
		}
		return adjustment, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Adjustment{}, false, fail(ctx)
	}
	// The target row is locked before it is judged, so a concurrent reversal of the
	// same document cannot slip between the check and the insert.
	var location int
	var targetReverses *int64
	var alreadyReversed bool
	err = tx.QueryRow(ctx, `SELECT a.location_id,a.reverses_adjustment_id,
  EXISTS(SELECT 1 FROM stock_adjustments counter WHERE counter.reverses_adjustment_id=a.id)
 FROM stock_adjustments a WHERE a.id=$1 FOR UPDATE`, targetID).Scan(&location, &targetReverses, &alreadyReversed)
	if errors.Is(err, pgx.ErrNoRows) {
		return Adjustment{}, false, ErrNotFound
	}
	if err != nil {
		return Adjustment{}, false, fail(ctx)
	}
	// A document of another location is not part of this actor's ledger: it does not exist
	// here. Answering "unavailable" would claim an outage over a document that simply is not
	// yours, so the reversal of another location's document is not found, exactly like an
	// unknown id.
	if location != actor.Location.ID {
		return Adjustment{}, false, ErrNotFound
	}
	if targetReverses != nil || alreadyReversed {
		return Adjustment{}, false, ErrDecisionConflict
	}
	derived, err := derivedLines(ctx, tx, targetID)
	if err != nil {
		return Adjustment{}, false, err
	}
	// A counter-entry states its own motive in the mandatory reason column, and it is written
	// in the original's own location.
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO stock_adjustments(operation_key,location_id,reason,reverses_adjustment_id,created_by_account_id)
 VALUES($1,$2,$3,$4,$5) RETURNING id`,
		operationKey, location, canonicalReason, targetID, actor.AccountID).Scan(&id)
	if err != nil {
		return Adjustment{}, false, mapFailure(ctx, err)
	}
	// Ascending variant order is the database's balance-row lock order.
	for _, line := range derived {
		if _, err := tx.Exec(ctx, `INSERT INTO stock_adjustment_lines(adjustment_id,variant_id,expected_quantity,counted_quantity)
 VALUES($1,$2,$3,$4)`, id, int32(line.variantID), line.expected, line.counted); err != nil {
			return Adjustment{}, false, mapFailure(ctx, err)
		}
	}
	adjustment, err := loadAdjustment(ctx, tx, id, location)
	if err != nil {
		return Adjustment{}, false, err
	}
	// The counter-entry completeness check is a deferred constraint trigger, so a
	// partial reversal is still rejected here, at commit.
	if err := tx.Commit(ctx); err != nil {
		return Adjustment{}, false, mapFailure(ctx, err)
	}
	return adjustment, false, nil
}

// reversalLine is one mirrored line of a counter-entry: the original's counted
// quantity becomes the expected snapshot and the original's expected becomes the
// count, so the applied difference is the exact negation of the original line.
type reversalLine struct{ variantID, expected, counted int64 }

// derivedLines mirrors the persisted original in the original's ascending variant
// order. A persisted line outside the admitted bounds means the ledger is not what
// this domain wrote, so it fails closed instead of deriving a document the
// database would reject.
func derivedLines(ctx context.Context, q querier, targetID int64) ([]reversalLine, error) {
	rows, err := q.Query(ctx, "SELECT variant_id,expected_quantity,counted_quantity FROM stock_adjustment_lines WHERE adjustment_id=$1 ORDER BY variant_id", targetID)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	lines := make([]reversalLine, 0)
	for rows.Next() {
		var variant, expected, counted int64
		if rows.Scan(&variant, &expected, &counted) != nil {
			return nil, fail(ctx)
		}
		if variant < 1 || variant > math.MaxInt32 || expected < 0 || counted < 0 || counted > maxCounted ||
			expected > maxCounted {
			return nil, ErrUnavailable
		}
		lines = append(lines, reversalLine{variantID: variant, expected: counted, counted: expected})
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

// List reads one newest-first page of the actor's own documents, in its own location
// (S36.1): the history is each location's ledger, never the installation's. The actor guard
// and the provisioned-account binding are creation's, and the page is one statement plus one
// total: line counts, the kind derived from those lines and differences are computed by the
// database, never by a Go loop over every line. The difference total is cast to text before
// it becomes an int64, so an out-of-range sum fails closed instead of wrapping.
func (s *Store) List(ctx context.Context, actor auth.Identity, page, pageSize int) (Page, error) {
	result := Page{Page: page, PageSize: pageSize, Adjustments: []Summary{}}
	if ctx == nil || s == nil || s.pool == nil {
		return Page{}, ErrUnavailable
	}
	if !adjustingAccount(actor) {
		return Page{}, ErrForbidden
	}
	// Every rejected page or size stops here, before the first statement.
	if !ValidPage(page, pageSize) {
		return Page{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return Page{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Page{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	location := actor.Location.ID
	if tx.QueryRow(ctx, "SELECT count(*) FROM stock_adjustments WHERE location_id=$1", location).Scan(&result.TotalAdjustments) != nil {
		return Page{}, fail(ctx)
	}
	rows, err := tx.Query(ctx, `SELECT a.id,a.reason,a.detail,a.created_at,a.reverses_adjustment_id,
  count(l.variant_id)::bigint,
  coalesce(sum(l.counted_quantity-l.expected_quantity),0)::text,
  (SELECT counter.id FROM stock_adjustments counter WHERE counter.reverses_adjustment_id=a.id),
  count(DISTINCT e.kind)::bigint,
  coalesce(min(e.kind),'')
 FROM stock_adjustments a
 LEFT JOIN stock_adjustment_lines l ON l.adjustment_id=a.id
 LEFT JOIN catalog_variants v ON v.id=l.variant_id
 LEFT JOIN catalog_entries e ON e.id=v.catalog_entry_id
 WHERE a.location_id=$1
 GROUP BY a.id
 ORDER BY a.id DESC
 LIMIT $2 OFFSET $3`, location, int64(pageSize), int64(page-1)*int64(pageSize))
	if err != nil {
		return Page{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var summary Summary
		var lines, kinds int64
		var difference, soleKind string
		if rows.Scan(&summary.ID, &summary.Reason, &summary.Detail, &summary.CreatedAt,
			&summary.ReversesAdjustmentID, &lines, &difference, &summary.ReversedBy,
			&kinds, &soleKind) != nil {
			return Page{}, fail(ctx)
		}
		// A persisted document always has between one and maxLines lines.
		if lines < 1 || lines > maxLines {
			return Page{}, ErrUnavailable
		}
		// The kind of the row is derived from its lines here, so a document whose
		// lines disagree reads no kind instead of the kind of one of them.
		kind, err := documentKind(kinds, soleKind)
		if err != nil {
			return Page{}, err
		}
		total, err := strconv.ParseInt(difference, 10, 64)
		// A single line can only add maxCounted and can only subtract an existing
		// balance, so a total above the admitted line bound is not this ledger's.
		if err != nil || total > int64(maxLines)*maxCounted {
			return Page{}, ErrUnavailable
		}
		summary.Lines = int(lines)
		summary.Kind = kind
		summary.TotalDifference = total
		result.Adjustments = append(result.Adjustments, summary)
	}
	if rows.Err() != nil {
		return Page{}, fail(ctx)
	}
	if tx.Commit(ctx) != nil {
		return Page{}, fail(ctx)
	}
	return result, nil
}

// Read reads one persisted document of the actor's own location with its lines joined to the
// catalogue: the actor guard and the provisioned-account binding are creation's, the snapshot
// is the history read's (RepeatableRead, read-only), and the document is resolved by one header
// statement plus one variant-ordered line statement, so the catalogue identity of a line is
// never an N+1 lookup. Capacity is rendered by the same `::text` + catalog.ParseDecimal pair
// the inventory read uses. A document of another location is not part of this actor's ledger:
// it is not found.
func (s *Store) Read(ctx context.Context, actor auth.Identity, id int64) (Detail, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Detail{}, ErrUnavailable
	}
	if !adjustingAccount(actor) {
		return Detail{}, ErrForbidden
	}
	// Only a positive document id reaches the database; an aliased or impossible one
	// stays not found exactly like an unknown document.
	if id < 1 {
		return Detail{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return Detail{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Detail{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	var detail Detail
	// One header statement carries the counter-entry's identity and its own motive
	// from the same correlated row, so the reversed document is described without a
	// second round trip and without a second read of the ledger.
	err = tx.QueryRow(ctx, `SELECT a.id,a.location_id,a.reason,a.detail,a.created_by_account_id,
  a.created_at,a.reverses_adjustment_id,
  (SELECT counter.id FROM stock_adjustments counter WHERE counter.reverses_adjustment_id=a.id),
  coalesce((SELECT counter.reason FROM stock_adjustments counter WHERE counter.reverses_adjustment_id=a.id),'')
 FROM stock_adjustments a WHERE a.id=$1 AND a.location_id=$2`, id, actor.Location.ID).Scan(
		&detail.ID, &detail.LocationID, &detail.Reason, &detail.Detail,
		&detail.CreatedByAccountID, &detail.CreatedAt, &detail.ReversesAdjustmentID, &detail.ReversedBy,
		&detail.ReversedByReason)
	if errors.Is(err, pgx.ErrNoRows) {
		return Detail{}, ErrNotFound
	}
	if err != nil {
		return Detail{}, fail(ctx)
	}
	rows, err := tx.Query(ctx, `SELECT l.variant_id,e.id,e.kind,coalesce(e.brand,''),coalesce(e.model,''),
  e.capacity_ah::text,coalesce(v.polarity,''),coalesce(e.name,''),l.expected_quantity,l.counted_quantity
 FROM stock_adjustment_lines l
 JOIN catalog_variants v ON v.id=l.variant_id
 JOIN catalog_entries e ON e.id=v.catalog_entry_id
 WHERE l.adjustment_id=$1 ORDER BY l.variant_id`, id)
	if err != nil {
		return Detail{}, fail(ctx)
	}
	defer rows.Close()
	// persisted is one stored line before its identity is composed: the typed
	// fields of a product are read in one statement instead of a lookup per line.
	type persisted struct {
		variant           catalog.Row
		expected, counted int64
	}
	stored := make([]persisted, 0, 8)
	entryIDs := make([]int32, 0, 8)
	var total int64
	for rows.Next() {
		var line persisted
		var capacity *string
		if rows.Scan(&line.variant.VariantID, &line.variant.CatalogEntryID, &line.variant.Kind,
			&line.variant.Brand, &line.variant.Model, &capacity, &line.variant.Polarity,
			&line.variant.Name, &line.expected, &line.counted) != nil {
			return Detail{}, fail(ctx)
		}
		// A numeric column never travels as a float: its own text is parsed back
		// into the canonical decimal of the contract.
		if capacity != nil {
			line.variant.Capacity = *capacity
		}
		// A persisted line outside the admitted bounds means the ledger is not what
		// this domain wrote, so the read fails closed instead of describing it.
		if line.variant.VariantID < 1 || line.variant.VariantID > math.MaxInt32 ||
			line.variant.CatalogEntryID < 1 || line.expected < 0 || line.counted < 0 ||
			line.counted > maxCounted ||
			(len(stored) > 0 && line.variant.VariantID <= stored[len(stored)-1].variant.VariantID) {
			return Detail{}, ErrUnavailable
		}
		difference := line.counted - line.expected
		if total, err = addDifference(total, difference); err != nil {
			return Detail{}, err
		}
		if line.variant.Kind == catalog.OtherKind {
			entryIDs = append(entryIDs, int32(line.variant.CatalogEntryID))
		}
		stored = append(stored, line)
		if len(stored) > maxLines {
			return Detail{}, ErrUnavailable
		}
	}
	rows.Close()
	if rows.Err() != nil {
		return Detail{}, fail(ctx)
	}
	if len(stored) == 0 {
		return Detail{}, ErrUnavailable
	}
	// The variant identity of every line is the one the whole installation reads: a
	// battery keeps its battery attributes and a product its typed fields.
	fields, err := catalog.ReadFields(ctx, tx, entryIDs)
	if err != nil {
		return Detail{}, fail(ctx)
	}
	lines := make([]DetailLine, 0, len(stored))
	for _, line := range stored {
		identity, err := line.variant.Identity(fields[line.variant.CatalogEntryID])
		if err != nil {
			return Detail{}, ErrUnavailable
		}
		lines = append(lines, DetailLine{Identity: identity, CatalogEntryID: int64(line.variant.CatalogEntryID),
			Expected: line.expected, Counted: line.counted,
			Difference: line.counted - line.expected})
	}
	// Every document states a mandatory motive; a counter-entry mirrors a strictly
	// earlier document of this location.
	reason, validReason := CanonicalReason(detail.Reason)
	if !validReason || reason != detail.Reason {
		return Detail{}, ErrUnavailable
	}
	if detail.ReversesAdjustmentID != nil &&
		(*detail.ReversesAdjustmentID < 1 || *detail.ReversesAdjustmentID >= detail.ID) {
		return Detail{}, ErrUnavailable
	}
	if !validDetail(detail.Detail) {
		return Detail{}, ErrUnavailable
	}
	// A document can only be reversed by a later document of this location.
	if detail.ReversedBy != nil && (*detail.ReversedBy < 1 || *detail.ReversedBy <= detail.ID) {
		return Detail{}, ErrUnavailable
	}
	// A reversed document also reports its counter-entry's own motive. The counter
	// entry states a mandatory motive, so a reversed document without a canonical
	// one is not this ledger's and fails closed; a document that is not reversed
	// reports no motive at all.
	if detail.ReversedBy == nil {
		if detail.ReversedByReason != "" {
			return Detail{}, ErrUnavailable
		}
	} else {
		counterReason, validCounterReason := CanonicalReason(detail.ReversedByReason)
		if !validCounterReason || counterReason != detail.ReversedByReason {
			return Detail{}, ErrUnavailable
		}
	}
	detail.Lines = lines
	detail.TotalDifference = total
	if tx.Commit(ctx) != nil {
		return Detail{}, fail(ctx)
	}
	return detail, nil
}

// Catalog reads the blind capture catalogue of the actor's own location: the identity of
// every variant that location holds a balance row for, and nothing else. No
// quantity column is selected and no quantity field exists on the result, so the
// expected stock, the difference and every other stock number stay out of the
// capture screen. The balance join only proves the variant belongs to this
// location's ledger; it read no stock value.
func (s *Store) Catalog(ctx context.Context, actor auth.Identity, q CatalogQuery) (CatalogPage, error) {
	result := CatalogPage{Page: q.Page, PageSize: q.PageSize, Items: []CatalogItem{}}
	if ctx == nil || s == nil || s.pool == nil {
		return CatalogPage{}, ErrUnavailable
	}
	if !adjustingAccount(actor) {
		return CatalogPage{}, ErrForbidden
	}
	if !ValidPage(q.Page, q.PageSize) || (q.Polarity != "" && q.Polarity != "L" && q.Polarity != "R") ||
		!q.Kind.Valid() || !validText(q.Search) || !validText(q.Brand) {
		return CatalogPage{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return CatalogPage{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return CatalogPage{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	args := []any{actor.Location.ID, literalPattern(q.Search), q.Brand, q.Polarity, string(q.Kind.Filter())}
	if err := tx.QueryRow(ctx, "SELECT count(*)"+catalogFilter, args...).Scan(&result.TotalVariants); err != nil {
		return CatalogPage{}, fail(ctx)
	}
	args = append(args, int64(q.PageSize), int64(q.Page-1)*int64(q.PageSize))
	rows, err := tx.Query(ctx, `SELECT v.id,e.id,e.kind,coalesce(e.brand,''),coalesce(e.model,''),
  e.capacity_ah::text,coalesce(v.polarity,''),coalesce(e.name,'')`+catalogFilter+
		` ORDER BY v.id LIMIT $6 OFFSET $7`, args...)
	if err != nil {
		return CatalogPage{}, fail(ctx)
	}
	defer rows.Close()
	selected := make([]catalog.Row, 0, q.PageSize)
	entryIDs := make([]int32, 0, q.PageSize)
	for rows.Next() {
		var row catalog.Row
		var capacity *string
		if rows.Scan(&row.VariantID, &row.CatalogEntryID, &row.Kind, &row.Brand, &row.Model,
			&capacity, &row.Polarity, &row.Name) != nil {
			return CatalogPage{}, fail(ctx)
		}
		// A numeric column never travels as a float: its own text is parsed back
		// into the canonical decimal of the contract.
		if capacity != nil {
			row.Capacity = *capacity
		}
		if row.VariantID < 1 || row.CatalogEntryID < 1 ||
			(len(selected) > 0 && row.VariantID <= selected[len(selected)-1].VariantID) {
			return CatalogPage{}, ErrUnavailable
		}
		if row.Kind == catalog.OtherKind {
			entryIDs = append(entryIDs, int32(row.CatalogEntryID))
		}
		selected = append(selected, row)
	}
	rows.Close()
	if rows.Err() != nil {
		return CatalogPage{}, fail(ctx)
	}
	// The typed fields of the listed products are one statement, never a lookup
	// per item, and a row this contract could not publish fails the read closed.
	fields, err := catalog.ReadFields(ctx, tx, entryIDs)
	if err != nil {
		return CatalogPage{}, fail(ctx)
	}
	for _, row := range selected {
		identity, err := row.Identity(fields[row.CatalogEntryID])
		if err != nil {
			return CatalogPage{}, ErrUnavailable
		}
		result.Items = append(result.Items, CatalogItem{Identity: identity, CatalogEntryID: int64(row.CatalogEntryID)})
	}
	if tx.Commit(ctx) != nil {
		return CatalogPage{}, fail(ctx)
	}
	return result, nil
}

// catalogFilter is shared by the count and the page, so both answer the same question for
// the actor's own location ($1). It selects no stock quantity at all, a retired entry is
// never a valid target for an adjustment, and the kind selection is the stock read's own: an
// absent kind is the battery-only catalogue every caller already had.
const catalogFilter = ` FROM catalog_variants v
 JOIN catalog_entries e ON e.id=v.catalog_entry_id
 JOIN inventory_balances b ON b.location_id=$1 AND b.variant_id=v.id
 WHERE e.deleted_at IS NULL
 AND ($5='all' OR e.kind=$5)
 AND ($2='' OR e.brand ILIKE $2 ESCAPE '\' OR e.model ILIKE $2 ESCAPE '\' OR e.name ILIKE $2 ESCAPE '\')
 AND ($3='' OR e.brand=$3) AND ($4='' OR v.polarity=$4)`

// literalPattern turns a free search into a literal substring, so % and _ in the
// operator's own words never become wildcards.
func literalPattern(search string) string {
	if search == "" {
		return ""
	}
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search) + "%"
}

// validText keeps an optional filter inside the database's own text bounds.
func validText(text string) bool {
	return len(text) <= maxSearch && validDetail(text)
}

// loadAdjustment reads the durable document of one location: lines ordered by variant id with
// the expected snapshot and the counted quantity, and the difference derived from them. The
// bounds are re-checked, so a document this domain did not write is a store failure rather than
// a described one, while a document of another location is simply not found: it is not this
// ledger's, and a 503 would claim the system is broken over a document that is not yours.
func loadAdjustment(ctx context.Context, q querier, id int64, location int) (Adjustment, error) {
	var adjustment Adjustment
	err := q.QueryRow(ctx, `SELECT id,location_id,reason,detail,created_by_account_id,created_at,reverses_adjustment_id
 FROM stock_adjustments WHERE id=$1 AND location_id=$2`, id, location).Scan(
		&adjustment.ID, &adjustment.LocationID, &adjustment.Reason, &adjustment.Detail,
		&adjustment.CreatedByAccountID, &adjustment.CreatedAt, &adjustment.ReversesAdjustmentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Adjustment{}, ErrNotFound
	}
	if err != nil {
		return Adjustment{}, fail(ctx)
	}
	rows, err := q.Query(ctx, "SELECT variant_id,expected_quantity,counted_quantity FROM stock_adjustment_lines WHERE adjustment_id=$1 ORDER BY variant_id", id)
	if err != nil {
		return Adjustment{}, fail(ctx)
	}
	defer rows.Close()
	lines := []AdjustmentLine{}
	var total int64
	for rows.Next() {
		var line AdjustmentLine
		if rows.Scan(&line.VariantID, &line.Expected, &line.Counted) != nil {
			return Adjustment{}, fail(ctx)
		}
		if line.VariantID < 1 || line.Expected < 0 || line.Counted < 0 || line.Counted > maxCounted {
			return Adjustment{}, ErrUnavailable
		}
		line.Difference = line.Counted - line.Expected
		if total, err = addDifference(total, line.Difference); err != nil {
			return Adjustment{}, err
		}
		lines = append(lines, line)
		if len(lines) > maxLines {
			return Adjustment{}, ErrUnavailable
		}
	}
	if rows.Err() != nil {
		return Adjustment{}, fail(ctx)
	}
	adjustment.Lines = lines
	adjustment.TotalDifference = total
	return adjustment, nil
}

// addDifference sums exactly: a total that leaves int64 is a store failure, never
// a wrapped number.
func addDifference(total, difference int64) (int64, error) {
	if (difference > 0 && total > math.MaxInt64-difference) || (difference < 0 && total < math.MinInt64-difference) {
		return 0, ErrUnavailable
	}
	return total + difference, nil
}

// mapFailure publishes the database's own decision and nothing else: SQLSTATE is
// the only trusted evidence, and cancellation keeps its semantics.
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
		case "LS002", "LS003", "LS005", "LS006", "LS007", "LS008":
			return ErrInvalid
		// The branch is held by a live settlement (LC001, the freeze of 035 wired to this
		// document by 075): the branch closes or waits out its settlement, so this is a fact
		// the operator acts on and never an outage.
		case "LC001":
			return ErrBranchFrozen
		}
	}
	return ErrUnavailable
}
