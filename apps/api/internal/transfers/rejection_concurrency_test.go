package transfers_test

import (
	"context"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/transfers"
)

// Unlike a02Start, this starter invokes the actual rejection method.
func a03Start(ctx context.Context, s *transfers.Store, id int64) <-chan a02Reply {
	done := make(chan a02Reply, 1)
	go func() {
		r, err := s.Reject(ctx, actor(1), id)
		done <- a02Reply{r, err}
	}()
	return done
}

func TestA03RejectionConcurrency(t *testing.T) {
	t.Run("same_request", a03SameRequest)
	t.Run("approval_first", func(t *testing.T) { a03DecisionRace(t, true) })
	t.Run("rejection_first", func(t *testing.T) { a03DecisionRace(t, false) })
	for _, row := range []bool{false, true} {
		name := "advisory"
		if row {
			name = "header"
		}
		t.Run("canceled_"+name, func(t *testing.T) { a03ContextWait(t, row, false) })
		t.Run("deadline_"+name, func(t *testing.T) { a03ContextWait(t, row, true) })
	}
}

func a03SameRequest(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	stock := a03StockSnapshot(t, ctx, p)
	winner, gate, release := a02Gated(t, ctx, p, "UPDATE transfer_requests SET status='rejected'", true)
	loser, waiting, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
	one := a03Start(ctx, winner, r.ID)
	// Register cleanup before any handshake assertion: even failed assertions
	// release gates and await every started worker before pool cleanup.
	var first, second a02Reply
	var firstRead, secondRead bool
	var two <-chan a02Reply
	t.Cleanup(func() {
		release()
		if !firstRead {
			<-one
		}
		if two != nil && !secondRead {
			<-two
		}
	})
	a02Arrived(t, ctx, gate)
	two = a03Start(ctx, loser, r.ID)
	pid := a02Arrived(t, ctx, waiting)
	a01Wait(t, ctx, p, pid, "advisory")
	release()
	first = a02Receive(t, ctx, one)
	firstRead = true
	second = a02Receive(t, ctx, two)
	secondRead = true
	if first.err != nil || first.request.Status != "rejected" || second.err != nil || !reflect.DeepEqual(first.request, second.request) {
		t.Fatal("concurrent actual Reject calls did not return one stable complete outcome")
	}
	before := outcomeSnapshot(t, ctx, p)
	got, err := s.Get(ctx, actor(2), r.ID)
	if err != nil || !reflect.DeepEqual(got, first.request) || outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("concurrent rejection outcome was not persisted identically")
	}
	if a03StockSnapshot(t, ctx, p) != stock || scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations") != 0 {
		t.Fatal("concurrent rejection changed stock or created allocations")
	}
	a01Invariant(t, ctx, p)
}

func a03DecisionRace(t *testing.T, approvalFirst bool) {
	ctx, p, s := fixture(t)
	in := input()
	other := in
	other.RetryKey = "a03-race-owned-key-0002"
	owned := create(t, ctx, s, 2, other).Request
	if _, err := s.Approve(ctx, actor(1), owned.ID); err != nil {
		t.Fatal("unrelated owned reservation setup failed")
	}
	a01Exec(t, ctx, p, "UPDATE inventory_balances SET reserved=reserved+1 WHERE location_id=1 AND variant_id IN(1,2)")
	r := create(t, ctx, s, 2, in).Request
	stock := stocks(t, ctx, p)
	allocations := scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations")
	match := "UPDATE transfer_requests SET status='rejected'"
	if approvalFirst {
		match = "UPDATE transfer_requests SET status='approved'"
	}
	winner, gate, release := a02Gated(t, ctx, p, match, true)
	loser, waiting, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
	var one, two <-chan a02Reply
	if approvalFirst {
		one = a02Start(ctx, winner, r.ID)
	} else {
		one = a03Start(ctx, winner, r.ID)
	}
	var firstRead, secondRead bool
	t.Cleanup(func() {
		release()
		if !firstRead {
			<-one
		}
		if two != nil && !secondRead {
			<-two
		}
	})
	a02Arrived(t, ctx, gate)
	if approvalFirst {
		two = a03Start(ctx, loser, r.ID)
	} else {
		two = a02Start(ctx, loser, r.ID)
	}
	pid := a02Arrived(t, ctx, waiting)
	a01Wait(t, ctx, p, pid, "advisory")
	release()
	first := a02Receive(t, ctx, one)
	firstRead = true
	second := a02Receive(t, ctx, two)
	secondRead = true
	status := "rejected"
	wantStock := append([]stockRow(nil), stock...)
	wantAllocations := allocations
	if approvalFirst {
		status = "approved"
		wantAllocations += int64(len(r.Items))
		for i := range wantStock {
			for _, item := range r.Items {
				if wantStock[i].Location == r.Origin.ID && int64(wantStock[i].Variant) == item.VariantID {
					wantStock[i].Reserved += item.Quantity
					wantStock[i].Available -= item.Quantity
				}
			}
		}
	}
	if first.err != nil || first.request.Status != status {
		t.Fatal("first actual domain decision did not win")
	}
	a02Error(t, second.request, second.err, transfers.ErrDecisionConflict)
	if !reflect.DeepEqual(stocks(t, ctx, p), wantStock) || scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations") != wantAllocations {
		t.Fatal("decision race changed independent holds or left partial reservations")
	}
	// The full invariant proves exact ownership, not merely aggregate counts.
	a01Invariant(t, ctx, p)
	before := outcomeSnapshot(t, ctx, p)
	got, err := s.Get(ctx, actor(2), r.ID)
	if err != nil || !reflect.DeepEqual(got, first.request) || outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("losing actual method changed the committed winning outcome")
	}
}

func a03ContextWait(t *testing.T, row, deadline bool) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	tx := a01Begin(t, ctx, p)
	match, event := "pg_advisory_xact_lock(714025,1)", "advisory"
	if row {
		// This blocker ONLY reads/locks the header: never a protected UPDATE
		// after prelocking, which would invert the admitted lock order.
		a01Exec(t, ctx, tx, "SELECT id FROM transfer_requests WHERE id=$1 FOR UPDATE", r.ID)
		match, event = "FOR UPDATE", "transactionid"
	} else {
		a01Exec(t, ctx, tx, "SELECT pg_advisory_xact_lock(714025,1)")
	}
	waiting, gate, _ := a02Gated(t, ctx, p, match, false)
	before := outcomeSnapshot(t, ctx, p)
	operation, cancel := context.WithCancel(ctx)
	want := error(context.Canceled)
	if deadline {
		cancel()
		operation, cancel = context.WithTimeout(ctx, 2*time.Second)
		want = context.DeadlineExceeded
	}
	done := a03Start(operation, waiting, r.ID)
	read := false
	t.Cleanup(func() {
		cancel()
		_ = tx.Rollback(ctx)
		if !read {
			<-done
		}
	})
	pid := a02Arrived(t, ctx, gate)
	a01Wait(t, ctx, p, pid, event)
	if !deadline {
		cancel()
	}
	reply := a02Receive(t, ctx, done)
	read = true
	cancel()
	a02Error(t, reply.request, reply.err, want)
	_ = tx.Rollback(ctx)
	if outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("canceled/deadline rejection lock wait changed complete state")
	}
}

// Observe successful reload query completion and the subsequent failed COMMIT
// on the same connection. This is test-only, read-only instrumentation.
type a03ObservationKey struct{}
type a03Observation struct {
	mu       sync.Mutex
	reloads  int
	commit   bool
	commitOK bool
}

func (o *a03Observation) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, a03ObservationKey{}, d.SQL)
}

func (o *a03Observation) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryEndData) {
	sql, _ := ctx.Value(a03ObservationKey{}).(string)
	o.mu.Lock()
	defer o.mu.Unlock()
	if strings.Contains(sql, "FROM transfer_request_items i") && d.Err == nil {
		o.reloads++
	}
	if strings.EqualFold(sql, "commit") {
		o.commit, o.commitOK = true, d.Err == nil
	}
}

func a03Observed(t *testing.T, ctx context.Context, p *pgxpool.Pool) (*transfers.Store, *a03Observation) {
	t.Helper()
	o := &a03Observation{}
	cfg := p.Config().Copy()
	cfg.ConnConfig.Tracer = o
	owned, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("owned observation connection failed")
	}
	t.Cleanup(owned.Close)
	return transfers.New(owned), o
}
