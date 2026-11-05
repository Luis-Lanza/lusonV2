// Package catalogadmin owns the warehouse administrator's catalog battery
// contract: create a battery with one or two variants, edit the identity of an
// active battery, and archive it. The database is the catalog authority, so this
// package never allocates an identity, never deletes and never decides the
// retirement rules itself: it sends the canonical input and publishes the
// database's own refusal. A created battery has no branch prices, so it is not
// sellable until the existing price screen prices it per branch; this package
// only reports how many active branches already hold a price.
package catalogadmin

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/catalog"
)

var (
	ErrInvalid     = errors.New("invalid catalog battery")
	ErrForbidden   = errors.New("catalog battery forbidden")
	ErrNotFound    = errors.New("catalog battery not found")
	ErrConflict    = errors.New("catalog battery conflict")
	ErrHasStock    = errors.New("catalog battery has stock")
	ErrHasPending  = errors.New("catalog battery has pending operations")
	ErrUnavailable = errors.New("catalog battery store unavailable")
)

const (
	// maxName is the admitted byte length of a brand or a model. The column is
	// unbounded text, so the bound is this contract's, checked before any statement.
	maxName = 128
	// catalogRetirementFence is the common integrity fence every stock, reservation
	// and retirement writer takes. It is the same pair RetireBranch uses.
	catalogRetirementFenceKey = 714025
	catalogRetirementFenceSub = 1
	// writeTimeout bounds one battery write well below the HTTP write timeout.
	writeTimeout = 10 * time.Second
)

// Variant is one polarity of a battery with the identity the database allocated.
type Variant struct {
	ID       int64
	Polarity catalog.Polarity
}

// Battery is the created or edited battery and its allocated variants. It is the
// record the HTTP surface validates once more before echoing it back.
type Battery struct {
	ID             int64
	Brand          string
	Model          string
	Capacity       catalog.Decimal
	Variants       []Variant
	PricedBranches int
}

// CreateInput is one battery creation: the identity and the polarities that must
// exist for it, in the client's spelling.
type CreateInput struct {
	Brand      string
	Model      string
	Capacity   catalog.Decimal
	Polarities []catalog.Polarity
}

// EditInput is one identity change of an active battery. It never carries ids or
// variants: those are the database's identities, not editable fields.
type EditInput struct {
	Brand    string
	Model    string
	Capacity catalog.Decimal
}

// ValidName admits a brand or model as exact bounded text: valid UTF-8, at most
// 128 bytes, at least one non-space rune and no NUL. Surrounding spaces are
// preserved, never trimmed, so the catalog echoes exactly what was written.
func ValidName(value string) bool {
	return utf8.ValidString(value) && len(value) <= maxName &&
		strings.TrimSpace(value) != "" && !strings.ContainsRune(value, 0)
}

// CanonicalCreate decides the whole creation before any statement runs. At least
// one polarity and at most both must be present, each L or R, distinct and in
// ascending order, so the client never has to sort or de-duplicate them.
func CanonicalCreate(in CreateInput) (CreateInput, error) {
	if !ValidName(in.Brand) || !ValidName(in.Model) {
		return CreateInput{}, ErrInvalid
	}
	capacity, err := catalog.ParseDecimal(string(in.Capacity))
	if err != nil {
		return CreateInput{}, ErrInvalid
	}
	polarities, err := canonicalPolarities(in.Polarities)
	if err != nil {
		return CreateInput{}, err
	}
	return CreateInput{Brand: in.Brand, Model: in.Model, Capacity: capacity, Polarities: polarities}, nil
}

func canonicalPolarities(values []catalog.Polarity) ([]catalog.Polarity, error) {
	if len(values) < 1 || len(values) > 2 {
		return nil, ErrInvalid
	}
	result := make([]catalog.Polarity, len(values))
	copy(result, values)
	for i, value := range result {
		if value != catalog.Left && value != catalog.Right {
			return nil, ErrInvalid
		}
		if i > 0 && value <= result[i-1] {
			return nil, ErrInvalid
		}
	}
	return result, nil
}

// CanonicalEdit decides one identity change. The three fields are the whole
// document: an edit never carries ids, variants or a partial identity.
func CanonicalEdit(in EditInput) (EditInput, error) {
	if !ValidName(in.Brand) || !ValidName(in.Model) {
		return EditInput{}, ErrInvalid
	}
	capacity, err := catalog.ParseDecimal(string(in.Capacity))
	if err != nil {
		return EditInput{}, ErrInvalid
	}
	return EditInput{Brand: in.Brand, Model: in.Model, Capacity: capacity}, nil
}

// Store is the catalog battery writer. It holds the pool and the authentication
// service, because the warehouse administrator gate is the same authority the
// administration surface uses, rechecked here so a caller outside the HTTP
// surface cannot write either.
type Store struct {
	pool    *pgxpool.Pool
	service *auth.Service
}

func New(pool *pgxpool.Pool, service *auth.Service) *Store {
	return &Store{pool: pool, service: service}
}

// fail retains cancellation semantics but never driver/config/SQL details.
func fail(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrUnavailable
}

func pgError(err error) *pgconn.PgError {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg
	}
	return nil
}

// writeError publishes the database's own refusal of a creation or an edit. A
// duplicate active pair and any other uniqueness decision is a conflict; a domain
// check, an out-of-range capacity or a malformed argument is an invalid request.
func writeError(err error) error {
	if pg := pgError(err); pg != nil {
		switch pg.Code {
		case "23505":
			return ErrConflict
		case "23503", "23514", "22003", "22P02":
			return ErrInvalid
		}
	}
	return err
}

// retiredError publishes the database's own retirement refusal. The pre-checked
// blocker carries the precise cause; this fallback only names a conflict when the
// trigger refused for a reason the pre-check did not see.
func retiredError(err error) error {
	if pg := pgError(err); pg != nil && pg.Code == "23514" && pg.ConstraintName == "catalog_retirement_blocked" {
		return ErrConflict
	}
	return err
}

func (s *Store) begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, fail(ctx)
	}
	return tx, nil
}

// Create is one atomic operation: the entry and its one or two variants are
// written in one transaction, so no caller ever observes a battery without its
// polarities. Identities are allocated by the database sequences and the variant
// trigger fans a zero balance row out to every active branch. The response is
// read back from the written rows, never assembled from the input.
func (s *Store) Create(ctx context.Context, token string, in CreateInput) (Battery, error) {
	if ctx == nil || s == nil || s.pool == nil || s.service == nil {
		return Battery{}, ErrUnavailable
	}
	if err := s.service.Administrator(ctx, token); err != nil {
		return Battery{}, err
	}
	canonical, err := CanonicalCreate(in)
	if err != nil {
		return Battery{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	tx, err := s.begin(ctx)
	if err != nil {
		return Battery{}, err
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	var id int32
	if err = tx.QueryRow(ctx, `INSERT INTO catalog_entries(brand,model,capacity_ah)
 VALUES($1,$2,$3) RETURNING id`, canonical.Brand, canonical.Model, string(canonical.Capacity)).Scan(&id); err != nil {
		return Battery{}, writeError(err)
	}
	for _, polarity := range canonical.Polarities {
		var variant int32
		if err = tx.QueryRow(ctx, `INSERT INTO catalog_variants(catalog_entry_id,polarity)
 VALUES($1,$2) RETURNING id`, id, string(polarity)).Scan(&variant); err != nil {
			return Battery{}, writeError(err)
		}
	}
	battery, err := readBattery(ctx, tx, int64(id))
	if err != nil {
		return Battery{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Battery{}, fail(ctx)
	}
	return battery, nil
}

// Edit changes brand, model and capacity of an active battery. The battery id is
// the path's identity and is never rewritten, and the variants are untouched. The
// update's own row count is the decision, so there is no read-then-write window: a
// retired battery has left the editable catalog and is answered exactly like an
// unknown one.
func (s *Store) Edit(ctx context.Context, token string, id int64, in EditInput) (Battery, error) {
	if ctx == nil || s == nil || s.pool == nil || s.service == nil {
		return Battery{}, ErrUnavailable
	}
	if err := s.service.Administrator(ctx, token); err != nil {
		return Battery{}, err
	}
	if id < 1 || id > math.MaxInt32 {
		return Battery{}, ErrInvalid
	}
	canonical, err := CanonicalEdit(in)
	if err != nil {
		return Battery{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	tx, err := s.begin(ctx)
	if err != nil {
		return Battery{}, err
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	tag, err := tx.Exec(ctx, `UPDATE catalog_entries SET brand=$2,model=$3,capacity_ah=$4
 WHERE id=$1 AND deleted_at IS NULL`, int32(id), canonical.Brand, canonical.Model, string(canonical.Capacity))
	if err != nil {
		return Battery{}, writeError(err)
	}
	if tag.RowsAffected() == 0 {
		return Battery{}, ErrNotFound
	}
	battery, err := readBattery(ctx, tx, id)
	if err != nil {
		return Battery{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Battery{}, fail(ctx)
	}
	return battery, nil
}

// Archive retires a battery in the same shape RetireBranch retires a branch: the
// common fence is taken first, an already retired battery is a successful no-op,
// and the database's blocker names stock or an open operation before anything is
// written. A retirement is never reversed.
func (s *Store) Archive(ctx context.Context, token string, id int64) error {
	if ctx == nil || s == nil || s.pool == nil || s.service == nil {
		return ErrUnavailable
	}
	if err := s.service.Administrator(ctx, token); err != nil {
		return err
	}
	if id < 1 || id > math.MaxInt32 {
		return ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	tx, err := s.begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	// Ordered fence first: the blocker is then authoritative for every writer that
	// moves stock, reserves a variant or retires a battery.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1,$2)`, catalogRetirementFenceKey, catalogRetirementFenceSub); err != nil {
		return fail(ctx)
	}
	var retired bool
	if err = tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM catalog_entries WHERE id=$1`, int32(id)).Scan(&retired); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fail(ctx)
	}
	// A repeated retirement is the same successful answer, exactly like RetireBranch:
	// the marker is not rewritten a second time.
	if retired {
		return tx.Commit(ctx)
	}
	blocker, err := retirementBlocker(ctx, tx, id)
	if err != nil {
		return err
	}
	switch blocker {
	case "":
	case "stock":
		return ErrHasStock
	case "operations":
		return ErrHasPending
	default:
		return ErrConflict
	}
	if _, err = tx.Exec(ctx, `UPDATE catalog_entries SET deleted_at=CURRENT_TIMESTAMP
 WHERE id=$1 AND deleted_at IS NULL`, int32(id)); err != nil {
		return retiredError(err)
	}
	return tx.Commit(ctx)
}

// retirementBlocker asks the database's own function, which is the same decision
// the retirement guard applies. It is called under the fence so the answer holds
// for the following update.
func retirementBlocker(ctx context.Context, q querier, id int64) (string, error) {
	var blocker *string
	if err := q.QueryRow(ctx, `SELECT catalog_entry_retirement_blocker($1::integer)`, int32(id)).Scan(&blocker); err != nil {
		return "", fail(ctx)
	}
	if blocker == nil {
		return "", nil
	}
	return *blocker, nil
}

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// readBattery reads the written battery back and validates the persisted record
// before it can be echoed: the identity text, the canonical capacity, the
// allocated variants in polarity order and the priced branch count.
func readBattery(ctx context.Context, q querier, id int64) (Battery, error) {
	var battery Battery
	var capacity string
	err := q.QueryRow(ctx, `SELECT id,brand,model,capacity_ah::text FROM catalog_entries WHERE id=$1`, int32(id)).Scan(
		&battery.ID, &battery.Brand, &battery.Model, &capacity)
	if errors.Is(err, pgx.ErrNoRows) {
		return Battery{}, ErrNotFound
	}
	if err != nil {
		return Battery{}, fail(ctx)
	}
	canonical, err := catalog.ParseDecimal(capacity)
	if err != nil || canonical == "" || !ValidName(battery.Brand) || !ValidName(battery.Model) {
		return Battery{}, ErrUnavailable
	}
	battery.Capacity = canonical
	rows, err := q.Query(ctx, `SELECT id,polarity FROM catalog_variants WHERE catalog_entry_id=$1 ORDER BY polarity`, int32(id))
	if err != nil {
		return Battery{}, fail(ctx)
	}
	for rows.Next() {
		var variant Variant
		var polarity string
		if rows.Scan(&variant.ID, &polarity) != nil {
			rows.Close()
			return Battery{}, fail(ctx)
		}
		variant.Polarity = catalog.Polarity(polarity)
		if variant.ID < 1 || (variant.Polarity != catalog.Left && variant.Polarity != catalog.Right) ||
			(len(battery.Variants) > 0 && variant.Polarity <= battery.Variants[len(battery.Variants)-1].Polarity) {
			rows.Close()
			return Battery{}, ErrUnavailable
		}
		battery.Variants = append(battery.Variants, variant)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return Battery{}, fail(ctx)
	}
	if len(battery.Variants) < 1 || len(battery.Variants) > 2 {
		return Battery{}, ErrUnavailable
	}
	var priced int64
	// A price of a retired branch is still persisted but it is no longer a sale
	// price, so only active branches are counted. A created battery has none.
	if err = q.QueryRow(ctx, `SELECT count(*) FROM branch_prices p
 JOIN locations l ON l.id=p.branch_location_id AND l.deleted_at IS NULL
 WHERE p.catalog_entry_id=$1`, int32(id)).Scan(&priced); err != nil {
		return Battery{}, fail(ctx)
	}
	if priced < 0 || priced > math.MaxInt32 {
		return Battery{}, ErrUnavailable
	}
	battery.PricedBranches = int(priced)
	return battery, nil
}
