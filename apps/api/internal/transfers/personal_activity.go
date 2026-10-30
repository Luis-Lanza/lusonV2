package transfers

import (
	"context"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

// PersonalActor is an immutable snapshot, not a live account directory entry.
// Decimal strings retain the full bigint identity through JavaScript clients.
type PersonalActor struct {
	AccountID   string `json:"account_id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}
type Activity struct {
	Category     string        `json:"category"`
	Action       string        `json:"action"`
	Actor        PersonalActor `json:"actor"`
	LocationID   int           `json:"location_id"`
	LocationName string        `json:"location_name"`
	RecordedAt   time.Time     `json:"recorded_at"`
	VariantID    *int64        `json:"variant_id,omitempty"`
}

// Take the common integrity fence before retry, header or stock locks, including
// pending creation. Assignment/activity account reads remain MVCC, not row locks.
// The local setting cannot leak through the pool and is not authorization.
func (s *Store) beginPersonal(ctx context.Context, actor auth.Identity) (pgx.Tx, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('luson.transfer_account_id',$1,true), pg_advisory_xact_lock(714025,1)`, strconv.Itoa(actor.AccountID)); err != nil {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
		return nil, err
	}
	return tx, nil
}

// Called only after the existing participant-scoped header has been admitted.
// List deliberately skips this private, potentially growing operation history.
func loadPersonalActivity(ctx context.Context, q querier, r *Request) error {
	rows, err := q.Query(ctx, `SELECT category,action,account_id::text,username,display_name,
 location_id,location_name,recorded_at,variant_id FROM transfer_personal_activity
 WHERE request_id=$1 ORDER BY ordinal`, r.ID)
	if err != nil {
		return fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var e Activity
		if rows.Scan(&e.Category, &e.Action, &e.Actor.AccountID, &e.Actor.Username, &e.Actor.DisplayName,
			&e.LocationID, &e.LocationName, &e.RecordedAt, &e.VariantID) != nil {
			return fail(ctx)
		}
		e.RecordedAt = e.RecordedAt.UTC()
		r.Activity = append(r.Activity, e)
	}
	if rows.Err() != nil {
		return fail(ctx)
	}
	return nil
}
