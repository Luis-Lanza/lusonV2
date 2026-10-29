package transfers_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/transfers"
)

// Snapshot every row, including private header data and unrelated balances.
func outcomeSnapshot(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var value string
	if p.QueryRow(ctx, `SELECT jsonb_build_array(
 (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM transfer_requests r),
 (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY request_id,variant_id),'[]') FROM transfer_request_items i),
 (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY request_id,variant_id),'[]') FROM transfer_request_allocations a),
 (SELECT jsonb_agg(to_jsonb(b) ORDER BY location_id,variant_id) FROM inventory_balances b))::text`).Scan(&value) != nil {
		t.Fatal("complete outcome snapshot failed")
	}
	return value
}

func TestA01bOutcomeStore(t *testing.T) {
	for _, status := range []string{"approved", "rejected"} {
		for _, flow := range []struct {
			name         string
			kind         transfers.Kind
			counterparty int
		}{
			{"warehouse_request", transfers.RequestStock, 1},
			{"branch_request", transfers.RequestStock, 3},
			{"warehouse_proposal", transfers.SendToWarehouse, 1},
		} {
			t.Run(status+"/"+flow.name, func(t *testing.T) {
				ctx, p, s := fixture(t)
				in := input()
				in.Kind, in.CounterpartyID = flow.kind, flow.counterparty
				original := create(t, ctx, s, 2, in).Request
				if original.Status != "pending" || original.DecisionLocationID != nil || original.DecidedAt != nil {
					t.Fatal("Pending carries decision metadata")
				}
				pendingInput := in
				pendingInput.RetryKey = "outcome-pending-key-0001"
				pending := create(t, ctx, s, 2, pendingInput).Request
				immutable := a01Original(t, ctx, p, original.ID)
				tx := a01Begin(t, ctx, p)
				a01Exec(t, ctx, tx, "SELECT pg_advisory_xact_lock(714025,1)")
				if status == "approved" {
					a01Approve(t, ctx, tx, original.ID, false)
				} else {
					a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='rejected' WHERE id=$1", original.ID)
				}
				a01Commit(t, ctx, tx)
				// Exhaust present availability without touching physical stock or
				// allocations. The original replay must precede fresh stock checks.
				a01Exec(t, ctx, p, "UPDATE inventory_balances SET reserved=existing WHERE location_id=$1 AND variant_id IN(1,2)", original.Origin.ID)
				var decision int
				var decided time.Time
				if p.QueryRow(ctx, "SELECT decision_location_id,decided_at FROM transfer_requests WHERE id=$1", original.ID).Scan(&decision, &decided) != nil {
					t.Fatal("persisted decision lookup failed")
				}
				want := original
				want.Status, want.DecisionLocationID, want.DecidedAt = status, &decision, &decided
				if decision != original.Approver.ID || decided.Before(original.CreatedAt) || a01Original(t, ctx, p, original.ID) != immutable {
					t.Fatal("fixture changed immutable payload or invalid decision")
				}
				before := outcomeSnapshot(t, ctx, p)
				checkUnchanged := func() {
					t.Helper()
					if outcomeSnapshot(t, ctx, p) != before {
						t.Fatal("read/replay/error changed headers, items, allocations or balances")
					}
				}
				for participant := 1; participant <= 3; participant++ {
					got, err := s.Get(ctx, actor(participant), original.ID)
					if participant == original.Origin.ID || participant == original.Destination.ID {
						if err != nil || !reflect.DeepEqual(got, want) {
							t.Error("participant Get refused or changed persisted terminal outcome")
						}
					} else if !errors.Is(err, transfers.ErrNotFound) {
						t.Fatal("outsider learned terminal request existence")
					}
					checkUnchanged()
					if _, err := s.Get(ctx, actor(participant), 9223372036854775807); !errors.Is(err, transfers.ErrNotFound) {
						t.Fatal("missing request not concealed")
					}
					checkUnchanged()
				}
				reordered := in
				reordered.Items = append([]transfers.Line(nil), in.Items...)
				reordered.Items[0], reordered.Items[1] = reordered.Items[1], reordered.Items[0]
				replay, err := s.Create(ctx, actor(2), reordered)
				if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Request, want) {
					t.Error("original reordered creation replay refused or changed terminal outcome")
				}
				checkUnchanged()
				changed := reordered
				changed.Items = append([]transfers.Line(nil), reordered.Items...)
				changed.Items[0].Quantity++
				if _, err := s.Create(ctx, actor(2), changed); !errors.Is(err, transfers.ErrRetryConflict) {
					t.Fatal("changed terminal cart did not conflict")
				}
				checkUnchanged()
				fresh := in
				fresh.RetryKey = "outcome-fresh-key-00001"
				if _, err := s.Create(ctx, actor(2), fresh); !errors.Is(err, transfers.ErrInsufficientStock) {
					t.Fatal("availability exhaustion not proven")
				}
				checkUnchanged()
				if _, err := s.Create(ctx, actor(1), in); !errors.Is(err, transfers.ErrForbidden) {
					t.Fatal("warehouse creation admitted")
				}
				checkUnchanged()
				for participant := 1; participant <= 3; participant++ {
					page, err := s.List(ctx, actor(participant), transfers.Query{Page: 1, PageSize: 25, Status: "pending"})
					visible := participant == pending.Origin.ID || participant == pending.Destination.ID
					if err != nil || (visible && (page.Total != 1 || len(page.Records) != 1 || !t10ListEqual(t, page.Records, []transfers.Request{pending}))) || (!visible && (page.Total != 0 || len(page.Records) != 0)) {
						t.Fatal("mixed outcome list/count is not Pending-only")
					}
					checkUnchanged()
				}
				gotPending, err := s.Get(ctx, actor(2), pending.ID)
				checkUnchanged()
				pendingReplay, replayErr := s.Create(ctx, actor(2), pendingInput)
				if err != nil || !reflect.DeepEqual(gotPending, pending) || replayErr != nil || !pendingReplay.Replayed || !reflect.DeepEqual(pendingReplay.Request, pending) {
					t.Fatal("Pending Get/replay changed or added decision metadata")
				}
				checkUnchanged()
				a01Invariant(t, ctx, p)
			})
		}
	}
}
