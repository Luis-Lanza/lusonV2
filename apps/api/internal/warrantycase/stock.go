package warrantycase

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

// UsedStock reads the stock of used batteries of the whole installation: one row per location and
// per model, the terms of the two formulas of S24 and their signed sum (S18, S24).
//
// There is no balance to read: the sum is derived from the facts already registered -- what each
// location bought (032), what a closed settlement counted and delivered (045, 047, 066), what a loan
// took out or brought back (065) and what the factory returned to the pool (065) -- so a certificate
// that disagrees with the documents cannot exist. The database states the arithmetic once, in
// `used_battery_stock()`, and this read publishes it: it never recomputes a term of its own and never
// loads the documents the sum is made of, so one answer is one aggregate and not one query per model.
//
// The warehouse that holds the pool and the branch that lends it both read the whole table: a loan may
// come from the case's branch, the warehouse or another branch (S6), so the counter has to see the
// stock of the three of them before it promises a battery. The read is quantities of models and
// nothing else -- no client, no case, no money.
func (s *Store) UsedStock(ctx context.Context, actor auth.Identity) ([]StockPosition, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return nil, ErrUnavailable
	}
	if !provisioned(actor) {
		return nil, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	rows, err := tx.Query(ctx, `SELECT location_id,model,purchased,factory_returns,
  loans_returned,delivered,loans_given,available
 FROM used_battery_stock() ORDER BY location_id,model COLLATE "C"`)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	stock := make([]StockPosition, 0, MaxListed)
	for rows.Next() {
		var row StockPosition
		var location int16
		var model string
		if err := rows.Scan(&location, &model, &row.Purchased, &row.FactoryReturns,
			&row.LoansReturned, &row.Delivered, &row.LoansGiven, &row.Available); err != nil {
			return nil, fail(ctx)
		}
		row.LocationID = int(location)
		row.Model = model
		if !validStockPosition(row) {
			// A row this domain could not have written is never published as a balance.
			return nil, ErrUnavailable
		}
		if len(stock) > 0 {
			previous := stock[len(stock)-1]
			if previous.LocationID > row.LocationID ||
				(previous.LocationID == row.LocationID && previous.Model >= row.Model) {
				return nil, ErrUnavailable
			}
		}
		stock = append(stock, row)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, fail(ctx)
	}
	return stock, nil
}

// validStockPosition admits only a row whose terms are quantities and whose sum is the arithmetic of
// S24 for its own location: a negative term, a location outside the installation, a model that is not the canonical key a
// purchase stores, or a balance that is not the signed sum of the five terms is a row this store did
// not write, and it fails closed instead of publishing a number nobody can act on. The balance itself
// may be negative, because it is a sum of the whole history and never a clamp.
func validStockPosition(row StockPosition) bool {
	if row.LocationID < warehouseLocationID || row.LocationID > maxBranchLocationID {
		return false
	}
	model, ok := canonicalLoanModel(row.Model)
	if !ok || model != row.Model {
		return false
	}
	for _, term := range []int64{row.Purchased, row.FactoryReturns, row.LoansReturned, row.Delivered,
		row.LoansGiven} {
		if term < 0 {
			return false
		}
	}
	return row.Available == stockSum(row)
}

// stockSum is the signed sum of S24 for the location of one row: bought plus factory returns plus
// loans brought back, minus what was lent, and the delivered quantity moves in the direction the
// location is on -- a branch delivered it and the warehouse received it, which is the same units
// counted once on each side.
func stockSum(row StockPosition) int64 {
	total := row.Purchased + row.FactoryReturns + row.LoansReturned - row.LoansGiven
	if row.LocationID == warehouseLocationID {
		return total + row.Delivered
	}
	return total - row.Delivered
}
