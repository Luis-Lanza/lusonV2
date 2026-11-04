package pricing

import (
	"context"
	"errors"
	"strings"
	"sync"
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

// Matrix reads one page of the price list: the active branches, the catalogue
// identity of every admitted variant, its warranty term when it has one and the
// prices the active branches hold. The actor guard and the provisioned-account
// binding are the write's, and the page is one count plus one page statement, so the
// total is the database's own number.
func (s *Store) Matrix(ctx context.Context, actor auth.Identity, q BranchQuery) (Matrix, error) {
	result := Matrix{Page: q.Page, PageSize: q.PageSize, Branches: []Branch{}, Variants: []VariantPrice{}}
	if ctx == nil || s == nil || s.pool == nil {
		return Matrix{}, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return Matrix{}, ErrForbidden
	}
	// Every rejected page, size or filter stops here, before the first statement.
	if !ValidQuery(q) {
		return Matrix{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return Matrix{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Matrix{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	branches, err := loadBranches(ctx, tx)
	if err != nil {
		return Matrix{}, err
	}
	result.Branches = branches
	args := []any{literalPattern(q.Search), q.Brand, capacityArg(q.Capacity), q.Polarity}
	if tx.QueryRow(ctx, "SELECT count(*)"+matrixFilter, args...).Scan(&result.TotalVariants) != nil {
		return Matrix{}, fail(ctx)
	}
	args = append(args, int64(q.PageSize), int64(q.Page-1)*int64(q.PageSize))
	rows, err := tx.Query(ctx, `SELECT v.id,e.id,e.brand,e.model,e.capacity_ah::text,v.polarity`+matrixFilter+
		` ORDER BY v.id LIMIT $5 OFFSET $6`, args...)
	if err != nil {
		return Matrix{}, fail(ctx)
	}
	variants := make([]VariantPrice, 0, q.PageSize)
	ids := make([]int32, 0, q.PageSize)
	for rows.Next() {
		var item VariantPrice
		var capacity string
		if rows.Scan(&item.VariantID, &item.CatalogEntryID, &item.Brand, &item.Model, &capacity, &item.Polarity) != nil {
			rows.Close()
			return Matrix{}, fail(ctx)
		}
		if item.VariantID < 1 || item.CatalogEntryID < 1 || item.Brand == "" || item.Model == "" ||
			(item.Polarity != "L" && item.Polarity != "R") ||
			(len(variants) > 0 && item.VariantID <= variants[len(variants)-1].VariantID) {
			rows.Close()
			return Matrix{}, ErrUnavailable
		}
		if item.Capacity, err = catalog.ParseDecimal(capacity); err != nil {
			rows.Close()
			return Matrix{}, ErrUnavailable
		}
		if item.Cells, err = cellsOf(item.CatalogEntryID); err != nil {
			rows.Close()
			return Matrix{}, err
		}
		item.Prices = []Price{}
		variants = append(variants, item)
		ids = append(ids, int32(item.VariantID))
	}
	if rows.Err() != nil {
		rows.Close()
		return Matrix{}, fail(ctx)
	}
	rows.Close()
	if len(ids) > 0 {
		if err := loadPrices(ctx, tx, branches, ids, variants); err != nil {
			return Matrix{}, err
		}
		if err := loadWarranties(ctx, tx, ids, variants); err != nil {
			return Matrix{}, err
		}
	}
	result.Variants = variants
	if tx.Commit(ctx) != nil {
		return Matrix{}, fail(ctx)
	}
	return result, nil
}

// matrixFilter is shared by the count and the page, so both answer the same
// question. The capacity is a nullable numeric parameter: an absent filter never
// casts an empty string.
const matrixFilter = ` FROM catalog_variants v
 JOIN catalog_entries e ON e.id=v.catalog_entry_id
 WHERE ($1='' OR e.brand ILIKE $1 ESCAPE '\' OR e.model ILIKE $1 ESCAPE '\')
 AND ($2='' OR e.brand=$2) AND ($3::numeric IS NULL OR e.capacity_ah=$3::numeric)
 AND ($4='' OR v.polarity=$4)`

// loadBranches reads the active branches of the matrix in id order. The warehouse is
// not a sale branch and a retired branch has no sale prices, so neither is listed.
func loadBranches(ctx context.Context, q querier) ([]Branch, error) {
	rows, err := q.Query(ctx, "SELECT id,name FROM locations WHERE id>=$1 AND deleted_at IS NULL ORDER BY id", firstBranchID)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	branches := make([]Branch, 0, 4)
	for rows.Next() {
		var item Branch
		if rows.Scan(&item.ID, &item.Name) != nil {
			return nil, fail(ctx)
		}
		if item.ID < firstBranchID || item.Name == "" ||
			(len(branches) > 0 && item.ID <= branches[len(branches)-1].ID) {
			return nil, ErrUnavailable
		}
		branches = append(branches, item)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return branches, nil
}

// loadPrices attaches the persisted pairs of one page to its variants. Only the
// listed active branches are read: a price of a retired branch is still persisted
// (prices are never deleted) but it is no longer a sale price of this matrix.
func loadPrices(ctx context.Context, q querier, branches []Branch, ids []int32, variants []VariantPrice) error {
	index := make(map[int64]int, len(variants))
	for i, item := range variants {
		index[item.VariantID] = i
	}
	active := make(map[int64]bool, len(branches))
	for _, item := range branches {
		active[item.ID] = true
	}
	rows, err := q.Query(ctx, `SELECT p.variant_id,p.branch_location_id,p.min_price::text,p.suggested_price::text,
  p.updated_at,p.updated_by_account_id,a.display_name
 FROM branch_prices p
 JOIN locations l ON l.id=p.branch_location_id AND l.deleted_at IS NULL
 JOIN auth_accounts a ON a.id=p.updated_by_account_id
 WHERE p.variant_id = ANY($1::integer[])
 ORDER BY p.variant_id,p.branch_location_id`, ids)
	if err != nil {
		return fail(ctx)
	}
	defer rows.Close()
	var previousVariant int64
	var previousBranch int64
	for rows.Next() {
		var variantID int64
		var price Price
		var min, suggested string
		if rows.Scan(&variantID, &price.BranchLocationID, &min, &suggested, &price.UpdatedAt,
			&price.UpdatedByAccountID, &price.UpdatedByDisplayName) != nil {
			return fail(ctx)
		}
		money, err := ParseMoney(min)
		if err != nil || string(money) != min {
			return ErrUnavailable
		}
		price.MinPrice = money
		if money, err = ParseMoney(suggested); err != nil || string(money) != suggested ||
			!money.AtLeast(price.MinPrice) {
			return ErrUnavailable
		}
		price.SuggestedPrice = money
		position, known := index[variantID]
		if !known || !active[price.BranchLocationID] || price.BranchLocationID < firstBranchID ||
			price.UpdatedAt.IsZero() || price.UpdatedByAccountID < 1 ||
			(variantID == previousVariant && price.BranchLocationID <= previousBranch) {
			return ErrUnavailable
		}
		previousVariant, previousBranch = variantID, price.BranchLocationID
		variants[position].Prices = append(variants[position].Prices, price)
	}
	if rows.Err() != nil {
		return fail(ctx)
	}
	return nil
}

// loadWarranties attaches the warranty term of one page to its variants. A variant
// without a term keeps nil, so the client shows no term instead of a default.
func loadWarranties(ctx context.Context, q querier, ids []int32, variants []VariantPrice) error {
	index := make(map[int64]int, len(variants))
	for i, item := range variants {
		index[item.VariantID] = i
	}
	rows, err := q.Query(ctx, `SELECT variant_id,warranty_months,updated_at FROM variant_warranties
 WHERE variant_id = ANY($1::integer[]) ORDER BY variant_id`, ids)
	if err != nil {
		return fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var variantID int64
		var months int
		var updatedAt time.Time
		if rows.Scan(&variantID, &months, &updatedAt) != nil {
			return fail(ctx)
		}
		position, known := index[variantID]
		if !known || months < MinWarrantyMonths || months > MaxWarrantyMonths || updatedAt.IsZero() ||
			variants[position].WarrantyMonths != nil {
			return ErrUnavailable
		}
		value := months
		variants[position].WarrantyMonths = &value
		variants[position].WarrantyAt = &updatedAt
	}
	if rows.Err() != nil {
		return fail(ctx)
	}
	return nil
}

// Write applies one price assignment atomically: every chosen branch receives the
// pair and the warranty term is written with it, or nothing is written at all. The
// warehouse administrator is the only admitted actor and the writing account is the
// session identity, never a value from the request. Rows are written in ascending
// branch order, which is the database's own lock order.
func (s *Store) Write(ctx context.Context, actor auth.Identity, input WriteInput) (WriteResult, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return WriteResult{}, ErrUnavailable
	}
	if !warehouseAdmin(actor) {
		return WriteResult{}, ErrForbidden
	}
	canonical, err := ValidateWrite(input)
	if err != nil {
		return WriteResult{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return WriteResult{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if err := checkAssignment(ctx, tx, actor); err != nil {
		return WriteResult{}, err
	}
	known, err := variantExists(ctx, tx, canonical.VariantID)
	if err != nil {
		return WriteResult{}, err
	}
	if !known {
		return WriteResult{}, ErrInvalid
	}
	if err := checkBranches(ctx, tx, canonical.BranchIDs); err != nil {
		return WriteResult{}, err
	}
	for _, branchID := range canonical.BranchIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,variant_id,min_price,suggested_price,updated_by_account_id,updated_at)
 VALUES($1,$2,$3,$4,$5,now())
 ON CONFLICT (branch_location_id,variant_id) DO UPDATE
 SET min_price=EXCLUDED.min_price,suggested_price=EXCLUDED.suggested_price,
     updated_by_account_id=EXCLUDED.updated_by_account_id,updated_at=EXCLUDED.updated_at`,
			int16(branchID), int32(canonical.VariantID), string(canonical.MinPrice),
			string(canonical.SuggestedPrice), int64(actor.AccountID)); err != nil {
			return WriteResult{}, mapFailure(ctx, err)
		}
	}
	if canonical.WarrantyMonths != nil {
		if _, err := tx.Exec(ctx, `INSERT INTO variant_warranties(variant_id,warranty_months,updated_by_account_id,updated_at)
 VALUES($1,$2,$3,now())
 ON CONFLICT (variant_id) DO UPDATE
 SET warranty_months=EXCLUDED.warranty_months,updated_by_account_id=EXCLUDED.updated_by_account_id,
     updated_at=EXCLUDED.updated_at`,
			int32(canonical.VariantID), int16(*canonical.WarrantyMonths), int64(actor.AccountID)); err != nil {
			return WriteResult{}, mapFailure(ctx, err)
		}
	}
	// The term in force is read back from the database, so an omitted term reports
	// exactly what is stored instead of a value invented here.
	months, err := storedWarranty(ctx, tx, canonical.VariantID)
	if err != nil {
		return WriteResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WriteResult{}, mapFailure(ctx, err)
	}
	return WriteResult{
		VariantID:      canonical.VariantID,
		BranchIDs:      canonical.BranchIDs,
		MinPrice:       canonical.MinPrice,
		SuggestedPrice: canonical.SuggestedPrice,
		WarrantyMonths: months,
	}, nil
}

// variantExists refuses an unknown variant before any pair is written: an unknown
// id is a request error, and one assignment is applied completely or not at all.
func variantExists(ctx context.Context, q querier, variantID int64) (bool, error) {
	var known bool
	if err := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM catalog_variants WHERE id=$1)", int32(variantID)).Scan(&known); err != nil {
		return false, fail(ctx)
	}
	return known, nil
}

// checkBranches admits only the requested branches that exist and are still active.
// A retired branch is named by its id, because the client must know exactly which
// row to drop; an id that is not a branch at all is an invalid request.
func checkBranches(ctx context.Context, q querier, ids []int64) error {
	requested := make([]int16, len(ids))
	for i, id := range ids {
		requested[i] = int16(id)
	}
	rows, err := q.Query(ctx, "SELECT id,deleted_at IS NOT NULL FROM locations WHERE id = ANY($1::smallint[]) ORDER BY id", requested)
	if err != nil {
		return fail(ctx)
	}
	defer rows.Close()
	active := make(map[int64]bool, len(ids))
	retired := make(map[int64]bool, len(ids))
	for rows.Next() {
		var id int64
		var isRetired bool
		if rows.Scan(&id, &isRetired) != nil {
			return fail(ctx)
		}
		if isRetired {
			retired[id] = true
		} else {
			active[id] = true
		}
	}
	if rows.Err() != nil {
		return fail(ctx)
	}
	for _, id := range ids {
		if retired[id] {
			return &RetiredBranch{BranchID: id}
		}
		if !active[id] {
			return ErrInvalid
		}
	}
	return nil
}

// storedWarranty reads the term in force, or nil when the variant has none.
func storedWarranty(ctx context.Context, q querier, variantID int64) (*int, error) {
	var months *int
	err := q.QueryRow(ctx, "SELECT warranty_months FROM variant_warranties WHERE variant_id=$1", int32(variantID)).Scan(&months)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fail(ctx)
	}
	if months != nil && (*months < MinWarrantyMonths || *months > MaxWarrantyMonths) {
		return nil, ErrUnavailable
	}
	return months, nil
}

// capacityArg turns the optional capacity filter into a nullable numeric parameter,
// so an absent filter never casts an empty string.
func capacityArg(capacity catalog.Decimal) any {
	if capacity == "" {
		return nil
	}
	return string(capacity)
}

// literalPattern turns a free search into a literal substring, so % and _ in the
// operator's own words never become wildcards.
func literalPattern(search string) string {
	if search == "" {
		return ""
	}
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search) + "%"
}

// cellsOf reads the three source cells of a catalogue entry. The cells are part of
// the preloaded source catalogue, so they are loaded once and validated there; a
// missing entry is a store failure, never an empty list.
func cellsOf(entryID int64) ([]string, error) {
	cells.cache.Do(func() {
		source, err := catalog.Load()
		if err != nil {
			cells.err = err
			return
		}
		byEntry := make(map[int64][]string, len(source.Entries))
		for _, entry := range source.Entries {
			if len(entry.Cells) != 3 {
				cells.err = ErrUnavailable
				return
			}
			byEntry[int64(entry.ID)] = entry.Cells
		}
		cells.byEntry = byEntry
	})
	if cells.err != nil {
		return nil, ErrUnavailable
	}
	value, known := cells.byEntry[entryID]
	if !known {
		return nil, ErrUnavailable
	}
	return append([]string(nil), value...), nil
}

var cells struct {
	cache   sync.Once
	byEntry map[int64][]string
	err     error
}

// mapFailure publishes the database's own decision and nothing else: SQLSTATE is the
// only trusted evidence, and cancellation keeps its semantics.
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
		// LP00N: the sale scope guard and the replace-not-delete guard. A refused
		// amount, an unknown variant or an inactive branch is the same public
		// refusal, because the database decides it and the client cannot act on a
		// different answer.
		case "LP00N", "23503", "23514", "22003":
			return ErrInvalid
		}
	}
	return ErrUnavailable
}
