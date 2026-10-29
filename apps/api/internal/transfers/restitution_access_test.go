package transfers_test

import (
	"context"
	"math"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/transfers"
)

func TestR4RestitutionAccessValidation(t *testing.T) {
	ctx := context.Background()
	unqueried := transfers.New(&pgxpool.Pool{})
	for _, tc := range []struct {
		name string
		s    *transfers.Store
		ctx  context.Context
	}{
		{"nil_store", nil, ctx},
		{"nil_pool", transfers.New(nil), ctx},
		{"zero_store", &transfers.Store{}, ctx},
		{"nil_context", unqueried, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.s.CheckRestitutionAccess(tc.ctx, actor(0), 0); err != transfers.ErrUnavailable {
				t.Fatal("dependencies must precede identity and id validation")
			}
		})
	}
	for _, tc := range []struct {
		name     string
		identity auth.Identity
	}{
		{"unassigned", actor(0)},
		{"unknown_account", actor(32768)},
		{"mismatched_assignment", auth.Identity{AccountID: 1, Location: auth.Location{ID: 3}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := unqueried.CheckRestitutionAccess(ctx, tc.identity, 0); err != transfers.ErrForbidden {
				t.Fatal("assignment must precede id validation and SQL")
			}
		})
	}
	for _, id := range []int64{0, -1, math.MinInt64} {
		if err := unqueried.CheckRestitutionAccess(ctx, actor(1), id); err != transfers.ErrNotFound {
			t.Fatal("invalid id reached SQL")
		}
	}
}

// Retain only the assignment check and final header metadata, not history.
// The Store fence reads the actual binding before one participant-only header.
type r4AccessTrace struct {
	mu                sync.Mutex
	count             int
	sql               string
	args              []any
	bounded           bool
	assignmentSQL     string
	assignmentArgs    []any
	assignmentBounded bool
}

func (tr *r4AccessTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	tr.count++
	tr.sql = d.SQL
	tr.args = append([]any(nil), d.Args...)
	deadline, ok := ctx.Deadline()
	remaining := time.Until(deadline)
	tr.bounded = ok && remaining > 0 && remaining <= 10*time.Second
	if tr.count == 1 {
		tr.assignmentSQL = d.SQL
		tr.assignmentArgs = append([]any(nil), d.Args...)
		tr.assignmentBounded = tr.bounded
	}
	return ctx
}
func (*r4AccessTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestR4RestitutionAccessParticipantFence(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 4)
	s := transfers.New(p)
	in := input()
	in.RetryKey = "r4-access-pending-key"
	pending := create(t, ctx, s, 2, in).Request
	before := r2Snapshot(t, ctx, p)
	original := r2Original(t, ctx, p)
	trace := &r4AccessTrace{}
	cfg := p.Config().Copy()
	cfg.ConnConfig.Tracer = trace
	traced, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("access traced pool setup failed")
	}
	defer traced.Close()
	fence := transfers.New(traced)
	for _, tc := range []struct {
		name string
		who  int
		id   int64
		want error
	}{
		{"origin", r.Origin.ID, r.ID, nil},
		{"exact_destination", r.Destination.ID, r.ID, nil},
		{"outsider", 3, r.ID, transfers.ErrNotFound},
		{"nonexistent", r.Origin.ID, math.MaxInt64, transfers.ErrNotFound},
		{"nonreceived_origin", pending.Origin.ID, pending.ID, transfers.ErrDecisionConflict},
		{"nonreceived_destination", pending.Destination.ID, pending.ID, transfers.ErrDecisionConflict},
		{"nonreceived_outsider", 3, pending.ID, transfers.ErrNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			trace.mu.Lock()
			trace.count = 0
			trace.mu.Unlock()
			if err := fence.CheckRestitutionAccess(ctx, actor(tc.who), tc.id); err != tc.want {
				t.Fatal("participant/status fence returned unexpected error")
			}
			trace.mu.Lock()
			defer trace.mu.Unlock()
			const header = `SELECT status FROM transfer_requests WHERE id=$1 AND $2 IN(origin_location_id,destination_location_id)`
			const binding = `SELECT EXISTS(SELECT 1 FROM auth_accounts WHERE id=$1 AND location_id=$2)`
			if trace.count != 2 || trace.assignmentSQL != binding || !trace.assignmentBounded ||
				!reflect.DeepEqual(trace.assignmentArgs, []any{tc.who, tc.who}) ||
				trace.sql != header || !trace.bounded || !reflect.DeepEqual(trace.args, []any{tc.id, tc.who}) {
				t.Fatal("access must check assignment then read only one participant-filtered header within ten seconds")
			}
		})
	}
	for _, tc := range []struct {
		name string
		ctx  context.Context
		want error
	}{
		{"cancellation", func() context.Context { c, cancel := context.WithCancel(ctx); cancel(); return c }(), context.Canceled},
		{"deadline", func() context.Context {
			c, cancel := context.WithDeadline(ctx, time.Now().Add(-time.Second))
			cancel()
			return c
		}(), context.DeadlineExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := fence.CheckRestitutionAccess(tc.ctx, actor(r.Origin.ID), r.ID); err != tc.want {
				t.Fatal("access did not preserve context error")
			}
		})
	}
	// Both endpoints pass the privacy fence, but it grants neither action's
	// authority. SQL must still reject a destination proposal or origin decision.
	t.Run("not_mutation_authority", func(t *testing.T) {
		if _, err := s.ProposeRestitution(ctx, actor(r.Destination.ID), r.ID, r3Proposal("r4-wrong-origin-key", 0, 1)); err != transfers.ErrForbidden {
			t.Fatal("privacy fence authorized destination attestation")
		}
		if _, err := s.DecideRestitution(ctx, actor(r.Origin.ID), r.ID, r3Decision("r4-wrong-destination-key", 0, true)); err != transfers.ErrForbidden {
			t.Fatal("privacy fence authorized origin decision")
		}
	})
	traced.Close()
	t.Run("closed_pool_query_unavailable", func(t *testing.T) {
		if err := fence.CheckRestitutionAccess(ctx, actor(r.Origin.ID), r.ID); err != transfers.ErrUnavailable {
			t.Fatal("query failure must return only sanitized unavailable")
		}
	})
	if before != r2Snapshot(t, ctx, p) || original != r2Original(t, ctx, p) {
		t.Fatal("access reads changed stock, evidence, workflow revisions or invalidations")
	}
}
