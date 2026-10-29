package transfers

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

// Query has no client-selectable actor or consulted inventory location.
type Query struct {
	Page           int64
	PageSize       int
	Status         string
	RequiresAction bool
}
type Page struct {
	Records         []Request
	Total           int64
	Page            int64
	PageSize        int
	Status          string
	RequiresAction  bool
	RequiredActions map[int64][]string
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
	if q.Status != "all" && q.Status != "pending" && q.Status != "approved" && q.Status != "rejected" && q.Status != "in_transit" && q.Status != "received" && q.Status != "cancelled" {
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
	page := Page{Records: make([]Request, 0), Page: q.Page, PageSize: q.PageSize, Status: q.Status,
		RequiresAction: q.RequiresAction, RequiredActions: make(map[int64][]string)}
	projection := ` FROM (` + requiredActionsSQL + `) actions
  WHERE ($2='all' OR status=$2) AND (NOT $3 OR ` + anyRequiredActionSQL + `)`
	if tx.QueryRow(ctx, `SELECT count(*)`+projection, actor.Location.ID, q.Status, q.RequiresAction).Scan(&page.Total) != nil {
		return Page{}, fail(ctx)
	}
	offset := (q.Page - 1) * int64(q.PageSize)
	rows, err := tx.Query(ctx, `SELECT id,approve,dispatch,receive,review_count,review_restitution,review_dispatch_reconciliation`+projection+
		` ORDER BY id DESC LIMIT $4 OFFSET $5`, actor.Location.ID, q.Status, q.RequiresAction, int64(q.PageSize), offset)
	if err != nil {
		return Page{}, fail(ctx)
	}
	ids := make([]int64, 0, q.PageSize)
	for rows.Next() {
		var id int64
		var flags [6]bool
		if rows.Scan(&id, &flags[0], &flags[1], &flags[2], &flags[3], &flags[4], &flags[5]) != nil {
			rows.Close()
			return Page{}, fail(ctx)
		}
		ids = append(ids, id)
		reasons := make([]string, 0, 6)
		for i, reason := range []string{"approve", "dispatch", "receive", "review_count", "review_restitution", "review_dispatch_reconciliation"} {
			if flags[i] {
				reasons = append(reasons, reason)
			}
		}
		page.RequiredActions[id] = reasons
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Page{}, fail(ctx)
	}
	for _, id := range ids {
		r, err := load(ctx, tx, actor.Location.ID, id)
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
