package transfers

import (
	"context"

	"luson/api/internal/auth"
)

// Reuse creation's provisioned-account binding for every Store boundary. A
// positive location ID alone is not evidence that this account is assigned.
// Callers preserve dependency/structural guards and bound the query context.
// Live session versions and account lifecycle remain the auth service's job.
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
