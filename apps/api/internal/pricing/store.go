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
// identity of every admitted battery together with the polarities that exist for it,
// and the prices the active branches hold. The actor guard and the provisioned-account
// binding are the write's, and the page is one count plus one page statement, so the
// total is the database's own number.
func (s *Store) Matrix(ctx context.Context, actor auth.Identity, q BranchQuery) (Matrix, error) {
	result := Matrix{Page: q.Page, PageSize: q.PageSize, Branches: []Branch{}, Batteries: []Battery{}}
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
	args := []any{literalPattern(q.Search), q.Brand, capacityArg(q.Capacity)}
	if tx.QueryRow(ctx, "SELECT count(*)"+matrixFilter, args...).Scan(&result.TotalBatteries) != nil {
		return Matrix{}, fail(ctx)
	}
	args = append(args, int64(q.PageSize), int64(q.Page-1)*int64(q.PageSize))
	// The polarities of a battery are aggregated in ascending order, so one matrix row
	// carries every polarity the battery exists in instead of one row per polarity.
	rows, err := tx.Query(ctx, `SELECT e.id,e.brand,e.model,e.capacity_ah::text,
  (SELECT array_agg(v.polarity ORDER BY v.polarity) FROM catalog_variants v WHERE v.catalog_entry_id=e.id)`+
		matrixFilter+` ORDER BY e.id LIMIT $4 OFFSET $5`, args...)
	if err != nil {
		return Matrix{}, fail(ctx)
	}
	batteries := make([]Battery, 0, q.PageSize)
	ids := make([]int32, 0, q.PageSize)
	for rows.Next() {
		var item Battery
		var capacity string
		if rows.Scan(&item.CatalogEntryID, &item.Brand, &item.Model, &capacity,
			&item.Polarities) != nil {
			rows.Close()
			return Matrix{}, fail(ctx)
		}
		if item.CatalogEntryID < 1 || item.Brand == "" || item.Model == "" ||
			!validPolarities(item.Polarities) ||
			(len(batteries) > 0 && item.CatalogEntryID <= batteries[len(batteries)-1].CatalogEntryID) {
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
		batteries = append(batteries, item)
		ids = append(ids, int32(item.CatalogEntryID))
	}
	if rows.Err() != nil {
		rows.Close()
		return Matrix{}, fail(ctx)
	}
	rows.Close()
	if len(ids) > 0 {
		if err := loadPrices(ctx, tx, branches, ids, batteries); err != nil {
			return Matrix{}, err
		}
	}
	result.Batteries = batteries
	if tx.Commit(ctx) != nil {
		return Matrix{}, fail(ctx)
	}
	return result, nil
}

// validPolarities admits the aggregated polarities of one battery: at least one, at
// most both, each of them L or R and in ascending order, so the client never has to
// sort or de-duplicate them.
func validPolarities(polarities []string) bool {
	if len(polarities) < 1 || len(polarities) > 2 {
		return false
	}
	previous := ""
	for _, polarity := range polarities {
		if (polarity != "L" && polarity != "R") || polarity <= previous {
			return false
		}
		previous = polarity
	}
	return true
}

// matrixFilter is shared by the count and the page, so both answer the same question.
// The capacity is a nullable numeric parameter: an absent filter never casts an empty
// string. The matrix is a list of batteries, so the filter never looks at a polarity.
const matrixFilter = ` FROM catalog_entries e
 WHERE ($1='' OR e.brand ILIKE $1 ESCAPE '\' OR e.model ILIKE $1 ESCAPE '\')
 AND ($2='' OR e.brand=$2) AND ($3::numeric IS NULL OR e.capacity_ah=$3::numeric)`

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

// loadPrices attaches the persisted pairs of one page to its batteries. Only the
// listed active branches are read: a price of a retired branch is still persisted
// (prices are never deleted) but it is no longer a sale price of this matrix.
func loadPrices(ctx context.Context, q querier, branches []Branch, ids []int32, batteries []Battery) error {
	index := make(map[int64]int, len(batteries))
	for i, item := range batteries {
		index[item.CatalogEntryID] = i
	}
	active := make(map[int64]bool, len(branches))
	for _, item := range branches {
		active[item.ID] = true
	}
	rows, err := q.Query(ctx, `SELECT p.catalog_entry_id,p.branch_location_id,p.min_price::text,p.suggested_price::text,
  p.updated_at,p.updated_by_account_id,a.display_name
 FROM branch_prices p
 JOIN locations l ON l.id=p.branch_location_id AND l.deleted_at IS NULL
 JOIN auth_accounts a ON a.id=p.updated_by_account_id
 WHERE p.catalog_entry_id = ANY($1::integer[])
 ORDER BY p.catalog_entry_id,p.branch_location_id`, ids)
	if err != nil {
		return fail(ctx)
	}
	defer rows.Close()
	var previousEntry int64
	var previousBranch int64
	for rows.Next() {
		var entryID int64
		var price Price
		var min, suggested string
		if rows.Scan(&entryID, &price.BranchLocationID, &min, &suggested, &price.UpdatedAt,
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
		position, known := index[entryID]
		if !known || !active[price.BranchLocationID] || price.BranchLocationID < firstBranchID ||
			price.UpdatedAt.IsZero() || price.UpdatedByAccountID < 1 ||
			(entryID == previousEntry && price.BranchLocationID <= previousBranch) {
			return ErrUnavailable
		}
		previousEntry, previousBranch = entryID, price.BranchLocationID
		batteries[position].Prices = append(batteries[position].Prices, price)
	}
	if rows.Err() != nil {
		return fail(ctx)
	}
	return nil
}

// Write applies one price assignment atomically: every chosen branch receives the
// pair, or nothing is written at all. The warehouse administrator is the only
// admitted actor and the writing account is the session identity, never a value from
// the request. Rows are written in ascending branch order, which is the database's
// own lock order.
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
	known, err := entryExists(ctx, tx, canonical.CatalogEntryID)
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
		// The key is the battery, so one row per (branch, battery) is written and a
		// second write replaces it: the two polarities of the battery can never diverge.
		if _, err := tx.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id,updated_at)
 VALUES($1,$2,$3,$4,$5,now())
 ON CONFLICT (branch_location_id,catalog_entry_id) DO UPDATE
 SET min_price=EXCLUDED.min_price,suggested_price=EXCLUDED.suggested_price,
     updated_by_account_id=EXCLUDED.updated_by_account_id,updated_at=EXCLUDED.updated_at`,
			int16(branchID), int32(canonical.CatalogEntryID), string(canonical.MinPrice),
			string(canonical.SuggestedPrice), int64(actor.AccountID)); err != nil {
			return WriteResult{}, mapFailure(ctx, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return WriteResult{}, mapFailure(ctx, err)
	}
	return WriteResult{
		CatalogEntryID: canonical.CatalogEntryID,
		BranchIDs:      canonical.BranchIDs,
		MinPrice:       canonical.MinPrice,
		SuggestedPrice: canonical.SuggestedPrice,
	}, nil
}

// entryExists refuses an unknown battery before any pair is written: an unknown id is
// a request error, and one assignment is applied completely or not at all.
func entryExists(ctx context.Context, q querier, entryID int64) (bool, error) {
	var known bool
	if err := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM catalog_entries WHERE id=$1)", int32(entryID)).Scan(&known); err != nil {
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
		// amount, an unknown battery or an inactive branch is the same public
		// refusal, because the database decides it and the client cannot act on a
		// different answer.
		case "LP00N", "23503", "23514", "22003":
			return ErrInvalid
		}
	}
	return ErrUnavailable
}
