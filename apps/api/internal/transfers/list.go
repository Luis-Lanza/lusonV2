package transfers

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

// Query has no client-selectable actor or consulted inventory location.
type Query struct {
	Page     int64
	PageSize int
	Status   string
}
type Page struct {
	Records  []Request
	Total    int64
	Page     int64
	PageSize int
	Status   string
}

func normalizeQuery(q Query) (Query, error) {
	if q.Page == 0 {
		q.Page = 1
	}
	if q.PageSize == 0 {
		q.PageSize = 25
	}
	if q.Status == "" {
		q.Status = "pending"
	}
	if q.Status != "pending" && q.Status != "approved" && q.Status != "rejected" && q.Status != "in_transit" {
		return Query{}, ErrInvalid
	}
	if q.Page < 1 || q.Page > 1_000_000 || (q.PageSize != 10 && q.PageSize != 25 && q.PageSize != 50) {
		return Query{}, ErrInvalid
	}
	return q, nil
}

// List counts and loads complete records from one read-only repeatable-read
// snapshot. Both queries scope physical participants before status/pagination.
// load uses this same transaction and rechecks participant visibility; at most
// 50 bounded canonical records are loaded, never aggregate battery quantities.
func (s *Store) List(ctx context.Context, actor auth.Identity, q Query) (Page, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Page{}, ErrUnavailable
	}
	if !assigned(actor) {
		return Page{}, ErrForbidden
	}
	q, err := normalizeQuery(q)
	if err != nil {
		return Page{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Page{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	page := Page{Records: make([]Request, 0), Page: q.Page, PageSize: q.PageSize, Status: q.Status}
	if tx.QueryRow(ctx, `SELECT count(*) FROM transfer_requests
  WHERE $1 IN (origin_location_id,destination_location_id) AND status=$2`, actor.AccountID, q.Status).Scan(&page.Total) != nil {
		return Page{}, fail(ctx)
	}
	offset := (q.Page - 1) * int64(q.PageSize)
	rows, err := tx.Query(ctx, `SELECT id FROM transfer_requests
  WHERE $1 IN (origin_location_id,destination_location_id) AND status=$2
  ORDER BY id DESC LIMIT $3 OFFSET $4`, actor.AccountID, q.Status, int64(q.PageSize), offset)
	if err != nil {
		return Page{}, fail(ctx)
	}
	ids := make([]int64, 0, q.PageSize)
	for rows.Next() {
		var id int64
		if rows.Scan(&id) != nil {
			rows.Close()
			return Page{}, fail(ctx)
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Page{}, fail(ctx)
	}
	for _, id := range ids {
		r, err := load(ctx, tx, actor.AccountID, id)
		if err != nil {
			return Page{}, err
		}
		page.Records = append(page.Records, r)
	}
	if tx.Commit(ctx) != nil {
		return Page{}, fail(ctx)
	}
	return page, nil
}
