package transfers_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

func TestC01CancellationConcurrency(t *testing.T) {
	for _, race := range []struct {
		name, first, second string
		approved            bool
	}{
		{"pending_duplicate", "cancel", "cancel", false},
		{"approved_duplicate", "cancel", "cancel", true},
		{"approval_first", "approve", "cancel", false},
		{"cancellation_before_approval", "cancel", "approve", false},
		{"dispatch_first", "dispatch", "cancel", true},
		{"cancellation_before_dispatch", "cancel", "dispatch", true},
	} {
		t.Run(race.name, func(t *testing.T) {
			ctx, p, s := fixture(t)
			r := create(t, ctx, s, 2, input()).Request
			if race.approved {
				if _, err := s.Approve(ctx, actor(1), r.ID); err != nil {
					t.Fatal("race approval setup failed")
				}
			}
			before := stocks(t, ctx, p)
			winner, gate, release := a02Gated(t, ctx, p, "UPDATE transfer_requests SET status=", true)
			loser, waiting, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
			start := func(store *transfers.Store, action string) <-chan a02Reply {
				done := make(chan a02Reply, 1)
				go func() {
					var result transfers.Request
					var err error
					switch action {
					case "cancel":
						result, err = store.Cancel(ctx, actor(2), r.ID)
					case "approve":
						result, err = store.Approve(ctx, actor(1), r.ID)
					case "dispatch":
						result, err = store.Dispatch(ctx, actor(1), r.ID)
					}
					done <- a02Reply{result, err}
				}()
				return done
			}
			one := start(winner, race.first)
			a02Arrived(t, ctx, gate)
			two := start(loser, race.second)
			a01Wait(t, ctx, p, a02Arrived(t, ctx, waiting), "advisory")
			release()
			a, b := a02Receive(t, ctx, one), a02Receive(t, ctx, two)
			if a.err != nil {
				t.Fatal("winning lifecycle operation failed")
			}
			want := a.request
			if race.first == race.second {
				if b.err != nil || !reflect.DeepEqual(a.request, b.request) {
					t.Fatal("concurrent duplicate changed persisted cancellation")
				}
			} else if race.first == "approve" {
				if b.err != nil || b.request.Status != "cancelled" || b.request.DecidedAt == nil || !reflect.DeepEqual(b.request.DecidedAt, a.request.DecidedAt) {
					t.Fatal("serialized approval then cancellation lost approval history")
				}
				want = b.request
			} else if !errors.Is(b.err, transfers.ErrDecisionConflict) {
				t.Fatal("losing conflicting operation replaced the winner")
			}
			for i := range before {
				for _, item := range r.Items {
					if race.approved && before[i].Location == r.Origin.ID && int64(before[i].Variant) == item.VariantID {
						before[i].Reserved -= item.Quantity
						if race.first == "dispatch" {
							before[i].Existing -= item.Quantity
						} else {
							before[i].Available += item.Quantity
						}
					}
				}
			}
			if !reflect.DeepEqual(stocks(t, ctx, p), before) {
				t.Fatal("race duplicated consumption/release or changed unrelated balances")
			}
			got, err := s.Get(ctx, actor(2), r.ID)
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatal("race recovery lost serialized final outcome")
			}
		})
	}
}

func TestC01CancellationDeadlineWait(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	approved, err := s.Approve(ctx, actor(r.Approver.ID), r.ID)
	if err != nil {
		t.Fatal("deadline wait approval setup failed")
	}
	before := outcomeSnapshot(t, ctx, p)
	block := a01Begin(t, ctx, p)
	a01Exec(t, ctx, block, "SELECT pg_advisory_xact_lock(714025,1)")
	store, gate, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
	// Allow the existing five-second lock-observation helper to complete,
	// while expiring before Cancel's own ten-second operation budget.
	operation, cancel := context.WithTimeout(ctx, 7*time.Second)
	done := make(chan a02Reply, 1)
	read := false
	t.Cleanup(func() {
		// Failure cleanup cancels and joins the worker before tracer-pool
		// cleanup. The success path never explicitly cancels the operation.
		cancel()
		cleanup, finish := context.WithTimeout(context.Background(), 5*time.Second)
		defer finish()
		_ = block.Rollback(cleanup)
		if !read {
			<-done
		}
	})
	go func() {
		result, err := store.Cancel(operation, actor(2), r.ID)
		done <- a02Reply{result, err}
	}()
	pid := a02Arrived(t, ctx, gate)
	a01Wait(t, ctx, p, pid, "advisory")
	if operation.Err() != nil {
		t.Fatal("deadline expired before the actual Cancel lock wait was observed")
	}
	// Keep the blocker held until Cancel returns: only natural deadline
	// expiry, not releasing the lock or explicit cancellation, may end it.
	reply := a02Receive(t, ctx, done)
	read = true
	if !errors.Is(reply.err, context.DeadlineExceeded) || !errors.Is(operation.Err(), context.DeadlineExceeded) ||
		!reflect.DeepEqual(reply.request, transfers.Request{}) {
		t.Fatal("deadline lock wait did not return DeadlineExceeded and a zero request")
	}
	if outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("deadline lock wait changed headers, history, stock, reservations or allocations")
	}
	got, err := s.Get(ctx, actor(2), r.ID)
	if err != nil || !reflect.DeepEqual(got, approved) {
		t.Fatal("deadline lock wait changed the persisted Approved request")
	}
	if block.Rollback(ctx) != nil {
		t.Fatal("deadline wait blocker rollback failed")
	}
}

func TestC01CancellationCancelledWait(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	block := a01Begin(t, ctx, p)
	a01Exec(t, ctx, block, "SELECT pg_advisory_xact_lock(714025,1)")
	store, gate, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
	cancelled, cancel := context.WithCancel(ctx)
	defer cancel()
	before := outcomeSnapshot(t, ctx, p)
	done := make(chan a02Reply, 1)
	go func() { r, err := store.Cancel(cancelled, actor(2), r.ID); done <- a02Reply{r, err} }()
	a01Wait(t, ctx, p, a02Arrived(t, ctx, gate), "advisory")
	cancel()
	if reply := a02Receive(t, ctx, done); !errors.Is(reply.err, context.Canceled) {
		t.Fatal("cancelled lock wait did not preserve context error")
	}
	if outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("cancelled lock wait left writes")
	}
}
