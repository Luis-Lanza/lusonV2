package transfers_test

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/transfers"
)

func TestA03RejectionDependencies(t *testing.T) {
	var absent *transfers.Store
	for _, s := range []*transfers.Store{absent, transfers.New(nil)} {
		for _, ctx := range []context.Context{nil, context.Background()} {
			got, err := s.Reject(ctx, actor(1), 1)
			a02Error(t, got, err, transfers.ErrUnavailable)
		}
	}
}

func TestA03RejectionStore(t *testing.T) {
	t.Run("identity_privacy_and_context", a03Refusals)
	t.Run("whole_outcomes_all_flows", a03WholeOutcomes)
	t.Run("unavailable_stock", a03UnavailableStock)
	t.Run("approved_conflict", a03Approved)
	t.Run("update_rollback", func(t *testing.T) { a03Failure(t, false) })
	t.Run("commit_rollback", func(t *testing.T) { a03Failure(t, true) })
}

func a03Refusals(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	before := outcomeSnapshot(t, ctx, p)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	expired, done := context.WithDeadline(ctx, time.Now().Add(-time.Second))
	defer done()
	for _, tc := range []struct {
		name  string
		ctx   context.Context
		actor auth.Identity
		id    int64
		want  error
	}{
		{"nil_context", nil, actor(1), r.ID, transfers.ErrUnavailable},
		{"dependency_before_identity", nil, auth.Identity{}, 0, transfers.ErrUnavailable},
		{"identity_before_id", ctx, auth.Identity{}, 0, transfers.ErrForbidden},
		{"identity_before_cancellation", canceled, auth.Identity{}, r.ID, transfers.ErrForbidden},
		{"canceled", canceled, actor(1), r.ID, context.Canceled},
		{"deadline", expired, actor(1), r.ID, context.DeadlineExceeded},
		{"zero_identity", ctx, auth.Identity{}, r.ID, transfers.ErrForbidden},
		{"unassigned", ctx, actor(32768), r.ID, transfers.ErrForbidden},
		{"mismatch", ctx, auth.Identity{AccountID: 1, Location: auth.Location{ID: 2}}, r.ID, transfers.ErrForbidden},
		{"zero_id", ctx, actor(1), 0, transfers.ErrNotFound},
		{"negative_id", ctx, actor(1), -1, transfers.ErrNotFound},
		{"missing", ctx, actor(1), math.MaxInt64, transfers.ErrNotFound},
		{"foreign", ctx, actor(3), r.ID, transfers.ErrNotFound},
		{"participant_not_approver", ctx, actor(2), r.ID, transfers.ErrForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := s.Reject(tc.ctx, tc.actor, tc.id)
			a02Error(t, got, err, tc.want)
			if outcomeSnapshot(t, ctx, p) != before {
				t.Fatal("refusal changed complete persisted state")
			}
		})
	}
}

// Compare complete inventory rows and owned allocations, not a fixed row count:
// intentionally missing balance rows are valid inputs for rejection.
func a03StockSnapshot(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var value string
	if p.QueryRow(ctx, `SELECT jsonb_build_array(
 (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY request_id,variant_id),'[]') FROM transfer_request_allocations a),
 (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY location_id,variant_id),'[]') FROM inventory_balances b))::text`).Scan(&value) != nil {
		t.Fatal("complete allocation/balance snapshot failed")
	}
	return value
}

func a03WholeOutcomes(t *testing.T) {
	for _, flow := range []struct {
		name         string
		kind         transfers.Kind
		counterparty int
	}{
		{"warehouse_request", transfers.RequestStock, 1},
		{"branch_request", transfers.RequestStock, 3},
		{"warehouse_proposal", transfers.SendToWarehouse, 1},
	} {
		t.Run(flow.name, func(t *testing.T) {
			ctx, p, s := fixture(t)
			in := input()
			in.Kind, in.CounterpartyID = flow.kind, flow.counterparty
			original := create(t, ctx, s, 2, in).Request
			// Preserve actual owned reservations as well as independent holds.
			other := in
			other.RetryKey = "a03-other-approved-key-0002"
			owned := create(t, ctx, s, 2, other).Request
			if _, err := s.Approve(ctx, actor(owned.Approver.ID), owned.ID); err != nil {
				t.Fatal("unrelated actual approval setup failed")
			}
			a01Exec(t, ctx, p, "UPDATE inventory_balances SET reserved=reserved+1 WHERE location_id=$1 AND variant_id IN(1,2)", original.Origin.ID)
			immutable := a01Original(t, ctx, p, original.ID)
			stock := a03StockSnapshot(t, ctx, p)
			// A connection-local tracer sees application SQL only. Deferred
			// database guards remain enabled and may inspect stock internally.
			traced, probe, _ := a02Gated(t, ctx, p, "inventory", false)
			got, err := traced.Reject(ctx, actor(original.Approver.ID), original.ID)
			if err != nil {
				t.Fatal("assigned approver could not reject valid whole request")
			}
			if len(probe.arrived) != 0 {
				t.Fatal("Pending rejection queried application stock")
			}
			var decision int
			var decided time.Time
			if p.QueryRow(ctx, "SELECT decision_location_id,decided_at FROM transfer_requests WHERE id=$1", original.ID).Scan(&decision, &decided) != nil {
				t.Fatal("decision lookup failed")
			}
			want := original
			want.Status, want.DecisionLocationID, want.DecidedAt = "rejected", &decision, &decided
			if !reflect.DeepEqual(got, want) || decision != original.Approver.ID || decided.Before(original.CreatedAt) || a01Original(t, ctx, p, original.ID) != immutable {
				t.Fatal("rejection did not preserve full immutable payload and server outcome")
			}
			if a03StockSnapshot(t, ctx, p) != stock {
				t.Fatal("rejection changed balances, independent holds or owned allocations")
			}
			terminal := outcomeSnapshot(t, ctx, p)
			retryStore, retryProbe, _ := a02Gated(t, ctx, p, "inventory", false)
			retry, err := retryStore.Reject(ctx, actor(original.Approver.ID), original.ID)
			if err != nil || !reflect.DeepEqual(retry, got) || len(retryProbe.arrived) != 0 {
				t.Fatal("Rejected retry changed outcome/time or queried stock")
			}
			recovered, err := s.Get(ctx, actor(2), original.ID)
			if err != nil || !reflect.DeepEqual(recovered, got) {
				t.Fatal("lost-reply Get did not recover identical rejection")
			}
			in.Items[0], in.Items[1] = in.Items[1], in.Items[0]
			replay, err := s.Create(ctx, actor(2), in)
			if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Request, got) {
				t.Fatal("reordered original creation replay changed rejection")
			}
			unauthorized, err := s.Reject(ctx, actor(2), original.ID)
			a02Error(t, unauthorized, err, transfers.ErrForbidden)
			foreign, err := s.Reject(ctx, actor(6-original.Origin.ID-original.Destination.ID), original.ID)
			a02Error(t, foreign, err, transfers.ErrNotFound)
			if _, err := s.Create(ctx, actor(1), in); !errors.Is(err, transfers.ErrForbidden) {
				t.Fatal("warehouse rejection enabled warehouse creation")
			}
			page, err := s.List(ctx, actor(2), transfers.Query{Page: 1, PageSize: 25, Status: "pending"})
			if err != nil || page.Total != 0 || len(page.Records) != 0 {
				t.Fatal("terminal rejection escaped Pending-only list")
			}
			if outcomeSnapshot(t, ctx, p) != terminal {
				t.Fatal("retry, replay, reads or refusals changed terminal state")
			}
			a01Invariant(t, ctx, p)
		})
	}
}

func a03UnavailableStock(t *testing.T) {
	for _, tc := range []struct {
		name, query string
	}{
		{"exhausted", "UPDATE inventory_balances SET reserved=existing WHERE location_id=1 AND variant_id IN(1,2)"},
		{"missing", "DELETE FROM inventory_balances WHERE location_id=1 AND variant_id=2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, p, s := fixture(t)
			in := input()
			r := create(t, ctx, s, 2, in).Request
			a01Exec(t, ctx, p, tc.query)
			before := a03StockSnapshot(t, ctx, p)
			traced, probe, _ := a02Gated(t, ctx, p, "inventory", false)
			got, err := traced.Reject(ctx, actor(1), r.ID)
			if err != nil || got.Status != "rejected" || len(probe.arrived) != 0 {
				t.Fatal("Pending rejection required application stock availability")
			}
			terminal := outcomeSnapshot(t, ctx, p)
			retryStore, retryProbe, _ := a02Gated(t, ctx, p, "inventory", false)
			retry, err := retryStore.Reject(ctx, actor(1), r.ID)
			if err != nil || !reflect.DeepEqual(retry, got) || len(retryProbe.arrived) != 0 {
				t.Fatal("Rejected retry required stock or changed result")
			}
			replay, err := s.Create(ctx, actor(2), in)
			if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Request, got) {
				t.Fatal("rejection replay required stock")
			}
			if a03StockSnapshot(t, ctx, p) != before || outcomeSnapshot(t, ctx, p) != terminal {
				t.Fatal("unavailable-stock rejection/retry mutated allocations or balances")
			}
			if scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations") != 0 {
				t.Fatal("rejection created allocations")
			}
			a01Invariant(t, ctx, p)
		})
	}
}

func a03Approved(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	approved, err := s.Approve(ctx, actor(1), r.ID)
	if err != nil || approved.Status != "approved" {
		t.Fatal("actual approval setup failed")
	}
	before := outcomeSnapshot(t, ctx, p)
	for _, tc := range []struct {
		id   int
		want error
	}{
		{1, transfers.ErrDecisionConflict},
		{2, transfers.ErrForbidden},
		{3, transfers.ErrNotFound},
	} {
		got, err := s.Reject(ctx, actor(tc.id), r.ID)
		a02Error(t, got, err, tc.want)
		if outcomeSnapshot(t, ctx, p) != before {
			t.Fatal("Approved rejection released allocations or changed state")
		}
	}
	a01Invariant(t, ctx, p)
}

func a03Failure(t *testing.T, commit bool) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	// Nontransactional sequence instrumentation proves the intended failure
	// stage was reached. Guards are strengthened inside this owned DB only.
	a01Exec(t, ctx, p, "CREATE SEQUENCE a03_failure_seen")
	a01Exec(t, ctx, p, `CREATE FUNCTION a03_fail_decision() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF NEW.status='rejected' THEN
   PERFORM nextval('a03_failure_seen');
   RAISE EXCEPTION 'injected rejection failure' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
 END $$`)
	if commit {
		a01Exec(t, ctx, p, `CREATE CONSTRAINT TRIGGER a03_fail_decision
 AFTER UPDATE ON transfer_requests DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION a03_fail_decision()`)
	} else {
		a01Exec(t, ctx, p, `CREATE TRIGGER a03_fail_decision
 AFTER UPDATE ON transfer_requests FOR EACH ROW EXECUTE FUNCTION a03_fail_decision()`)
	}
	before := outcomeSnapshot(t, ctx, p)
	traced, observed := a03Observed(t, ctx, p)
	got, err := traced.Reject(ctx, actor(1), r.ID)
	a02Error(t, got, err, transfers.ErrUnavailable)
	observed.mu.Lock()
	reloads, attempted, succeeded := observed.reloads, observed.commit, observed.commitOK
	observed.mu.Unlock()
	if commit && (reloads != 2 || !attempted || succeeded) {
		t.Fatal("deferred failure did not follow successful UPDATE/reload and failed COMMIT")
	}
	if !commit && (reloads != 1 || attempted) {
		t.Fatal("update failure unexpectedly reached reload or COMMIT")
	}
	if scalar(t, ctx, p, "SELECT count(*) FROM a03_failure_seen WHERE is_called AND last_value=1") != 1 {
		t.Fatal("injected rejection failure stage was not reached")
	}
	if outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("failed rejection did not restore complete Pending state")
	}
	got, err = s.Get(ctx, actor(2), r.ID)
	if err != nil || !reflect.DeepEqual(got, r) {
		t.Fatal("failed rejection left terminal metadata or payload effects")
	}
	a01Invariant(t, ctx, p)
}
