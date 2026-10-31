package transfers_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/transfers"
)

// A connection-local tracer reports the actual PID at a SQL stage. An end
// gate pauses only after PostgreSQL has completed the matched statement, so
// tests can deterministically keep the advisory/balance locks until released.
// Production code has no hooks, and assertions never retry domain operations.
type a02StageKey struct{}
type a02Trace struct {
	match   string
	end     bool
	arrived chan uint32
	release chan struct{}
	once    sync.Once
}

func (g *a02Trace) TraceQueryStart(ctx context.Context, c *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	matched := false
	if strings.Contains(d.SQL, g.match) {
		g.once.Do(func() {
			matched = true
			if !g.end {
				g.arrived <- c.PgConn().PID()
			}
		})
	}
	return context.WithValue(ctx, a02StageKey{}, matched)
}

func (g *a02Trace) TraceQueryEnd(ctx context.Context, c *pgx.Conn, _ pgx.TraceQueryEndData) {
	if matched, _ := ctx.Value(a02StageKey{}).(bool); !matched || !g.end {
		return
	}
	g.arrived <- c.PgConn().PID()
	select {
	case <-g.release:
	case <-ctx.Done():
	}
}

func a02Gated(t *testing.T, ctx context.Context, p *pgxpool.Pool, match string, end bool) (*transfers.Store, *a02Trace, func()) {
	t.Helper()
	g := &a02Trace{match: match, end: end, arrived: make(chan uint32, 1), release: make(chan struct{})}
	var once sync.Once
	release := func() { once.Do(func() { close(g.release) }) }
	cfg := p.Config().Copy()
	cfg.ConnConfig.Tracer = g
	owned, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("owned database stage connection failed")
	}
	t.Cleanup(func() {
		release()
		owned.Close()
	})
	return transfers.New(owned), g, release
}

func a02Arrived(t *testing.T, ctx context.Context, g *a02Trace) uint32 {
	t.Helper()
	select {
	case pid := <-g.arrived:
		return pid
	case <-ctx.Done():
		t.Fatal("SQL stage handshake did not arrive")
		return 0
	}
}

type a02Reply struct {
	request transfers.Request
	err     error
}

func a02Start(ctx context.Context, s *transfers.Store, id int64) <-chan a02Reply {
	done := make(chan a02Reply, 1)
	go func() {
		r, err := s.Approve(ctx, actor(1), id)
		done <- a02Reply{r, err}
	}()
	return done
}

func a02Receive(t *testing.T, ctx context.Context, done <-chan a02Reply) a02Reply {
	t.Helper()
	select {
	case reply := <-done:
		return reply
	case <-ctx.Done():
		t.Fatal("approval goroutine did not settle")
		return a02Reply{}
	}
}

func TestA02ApprovalConcurrency(t *testing.T) {
	t.Run("competing_requests", func(t *testing.T) { a02Competing(t, false) })
	t.Run("same_request", func(t *testing.T) { a02Competing(t, true) })
	t.Run("approval_before_rejection", a02ApprovalFirst)
	t.Run("rejection_before_approval", a02RejectionFirst)
	t.Run("guarded_balance_changes", a02BalanceRaces)
	t.Run("creation_before_approval", a02CreationFirst)
	t.Run("approval_before_creation", a02CreationSecond)
	t.Run("canceled_advisory_wait", func(t *testing.T) { a02ContextWait(t, false) })
	t.Run("deadline_advisory_wait", func(t *testing.T) { a02ContextWait(t, true) })
}

func a02Competing(t *testing.T, same bool) {
	ctx, p, s := fixture(t)
	in := input()
	in.Items = []transfers.Line{{VariantID: 2, Quantity: 13}, {VariantID: 1, Quantity: 10}}
	first := create(t, ctx, s, 2, in).Request
	second := first
	if !same {
		in.RetryKey = "a02-competing-key-0002"
		second = create(t, ctx, s, 2, in).Request
	}
	winner, gate, release := a02Gated(t, ctx, p, "ORDER BY b.variant_id FOR UPDATE OF b", true)
	loser, waiting, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
	one := a02Start(ctx, winner, first.ID)
	a02Arrived(t, ctx, gate)
	two := a02Start(ctx, loser, second.ID)
	pid := a02Arrived(t, ctx, waiting)
	a01Wait(t, ctx, p, pid, "advisory")
	release()
	a, b := a02Receive(t, ctx, one), a02Receive(t, ctx, two)
	if a.err != nil || a.request.Status != "approved" {
		t.Fatal("first domain approval did not win")
	}
	if same {
		if b.err != nil || !reflect.DeepEqual(a.request, b.request) {
			t.Fatal("concurrent same-action retry did not return identical persisted outcome")
		}
	} else {
		a02Error(t, b.request, b.err, transfers.ErrInsufficientStock)
		pending, err := s.Get(ctx, actor(2), second.ID)
		if err != nil || !reflect.DeepEqual(pending, second) {
			t.Fatal("competing loser changed immutable Pending request")
		}
	}
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests WHERE status='approved'") != 1 || scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations") != 2 {
		t.Fatal("concurrent approvals duplicated decisions or owned holds")
	}
	if scalar(t, ctx, p, "SELECT reserved FROM inventory_balances WHERE location_id=1 AND variant_id=1") != 10 || scalar(t, ctx, p, "SELECT reserved FROM inventory_balances WHERE location_id=1 AND variant_id=2") != 13 {
		t.Fatal("concurrent reservations were not exact")
	}
	a01Invariant(t, ctx, p)
}

func a02ApprovalFirst(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	winner, gate, release := a02Gated(t, ctx, p, "ORDER BY b.variant_id FOR UPDATE OF b", true)
	done := a02Start(ctx, winner, r.ID)
	a02Arrived(t, ctx, gate)
	tx := a01Begin(t, ctx, p)
	rejected := make(chan error, 1)
	go func() {
		_, err := tx.Exec(ctx, "UPDATE transfer_requests SET status='rejected' WHERE id=$1", r.ID)
		rejected <- err
	}()
	a01Wait(t, ctx, p, tx.Conn().PgConn().PID(), "advisory")
	release()
	approved := a02Receive(t, ctx, done)
	if approved.err != nil || !sqlState(<-rejected, "23514") {
		t.Fatal("guarded rejection replaced or blocked winning domain approval")
	}
	_ = tx.Rollback(ctx)
	before := outcomeSnapshot(t, ctx, p)
	got, err := s.Get(ctx, actor(2), r.ID)
	if err != nil || !reflect.DeepEqual(got, approved.request) || outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("losing rejection changed winning outcome")
	}
	a01Invariant(t, ctx, p)
}

func a02RejectionFirst(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	tx := a01Begin(t, ctx, p)
	a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='rejected' WHERE id=$1", r.ID)
	loser, gate, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
	done := a02Start(ctx, loser, r.ID)
	pid := a02Arrived(t, ctx, gate)
	a01Wait(t, ctx, p, pid, "advisory")
	a01Commit(t, ctx, tx)
	before := outcomeSnapshot(t, ctx, p)
	reply := a02Receive(t, ctx, done)
	a02Error(t, reply.request, reply.err, transfers.ErrDecisionConflict)
	if outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("waiting approval changed committed rejection")
	}
	a01Invariant(t, ctx, p)
}

func a02BalanceRaces(t *testing.T) {
	for _, change := range []struct {
		name, before, after string
	}{
		{"stock", "existing=1", "existing=1"},
		{"other_holds", "reserved=existing", "reserved=0"},
	} {
		for _, approvalFirst := range []bool{false, true} {
			order := "balance_first"
			if approvalFirst {
				order = "approval_first"
			}
			t.Run(change.name+"/"+order, func(t *testing.T) {
				ctx, p, s := fixture(t)
				r := create(t, ctx, s, 2, input()).Request
				tx := a01Begin(t, ctx, p)
				if !approvalFirst {
					a01Exec(t, ctx, tx, "UPDATE inventory_balances SET "+change.before+" WHERE location_id=1 AND variant_id=1")
					waiting, gate, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
					done := a02Start(ctx, waiting, r.ID)
					pid := a02Arrived(t, ctx, gate)
					a01Wait(t, ctx, p, pid, "advisory")
					a01Commit(t, ctx, tx)
					before := outcomeSnapshot(t, ctx, p)
					reply := a02Receive(t, ctx, done)
					a02Error(t, reply.request, reply.err, transfers.ErrInsufficientStock)
					if outcomeSnapshot(t, ctx, p) != before {
						t.Fatal("approval ignored committed stock/other-hold change")
					}
				} else {
					winner, gate, release := a02Gated(t, ctx, p, "ORDER BY b.variant_id FOR UPDATE OF b", true)
					done := a02Start(ctx, winner, r.ID)
					a02Arrived(t, ctx, gate)
					changed := make(chan error, 1)
					go func() {
						_, err := tx.Exec(ctx, "UPDATE inventory_balances SET "+change.after+" WHERE location_id=1 AND variant_id=1")
						changed <- err
					}()
					a01Wait(t, ctx, p, tx.Conn().PgConn().PID(), "advisory")
					release()
					if a02Receive(t, ctx, done).err != nil {
						t.Fatal("domain approval did not settle before guarded change")
					}
					before := outcomeSnapshot(t, ctx, p)
					err := <-changed
					if err == nil {
						err = tx.Commit(ctx)
					}
					if !sqlState(err, "23514") {
						t.Fatal("guarded balance change escaped owned reservation coverage")
					}
					_ = tx.Rollback(ctx)
					if outcomeSnapshot(t, ctx, p) != before {
						t.Fatal("losing guarded change altered approval")
					}
				}
				a01Invariant(t, ctx, p)
			})
		}
	}
}

func a02CreationFirst(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	creator, gate, release := a02Gated(t, ctx, p, "ORDER BY b.variant_id FOR UPDATE OF b", true)
	in := input()
	in.RetryKey = "a02-create-first-key-0002"
	created := make(chan error, 1)
	go func() {
		_, err := creator.Create(ctx, actor(2), in)
		created <- err
	}()
	a02Arrived(t, ctx, gate)
	approver, waiting, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
	done := a02Start(ctx, approver, r.ID)
	pid := a02Arrived(t, ctx, waiting)
	a01Wait(t, ctx, p, pid, "advisory")
	// Creation owns the common integrity fence as well as source balance locks;
	// approval must queue at that fence before revalidating source availability.
	release()
	if <-created != nil || a02Receive(t, ctx, done).err != nil {
		t.Fatal("creation could not finish while approval waited on its source locks")
	}
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests WHERE status='pending'") != 1 {
		t.Fatal("concurrent creation changed or acquired reservation effects")
	}
	a01Invariant(t, ctx, p)
}

func a02CreationSecond(t *testing.T) {
	ctx, p, s := fixture(t)
	in := input()
	in.Items = []transfers.Line{{VariantID: 1, Quantity: 10}, {VariantID: 2, Quantity: 13}}
	r := create(t, ctx, s, 2, in).Request
	winner, gate, release := a02Gated(t, ctx, p, "ORDER BY b.variant_id FOR UPDATE OF b", true)
	done := a02Start(ctx, winner, r.ID)
	a02Arrived(t, ctx, gate)
	creator, waiting, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
	in.RetryKey = "a02-create-second-key-0002"
	created := make(chan error, 1)
	go func() {
		_, err := creator.Create(ctx, actor(2), in)
		created <- err
	}()
	pid := a02Arrived(t, ctx, waiting)
	a01Wait(t, ctx, p, pid, "advisory")
	release()
	if a02Receive(t, ctx, done).err != nil || !errors.Is(<-created, transfers.ErrInsufficientStock) {
		t.Fatal("waiting creation did not revalidate committed source availability")
	}
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests") != 1 {
		t.Fatal("failed creation left a header")
	}
	a01Invariant(t, ctx, p)
}

func a02ContextWait(t *testing.T, deadline bool) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	tx := a01Begin(t, ctx, p)
	a01Exec(t, ctx, tx, "SELECT pg_advisory_xact_lock(714025,1)")
	waiting, gate, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
	before := outcomeSnapshot(t, ctx, p)
	operation, cancel := context.WithCancel(ctx)
	want := error(context.Canceled)
	if deadline {
		cancel()
		operation, cancel = context.WithTimeout(ctx, 2*time.Second)
		want = context.DeadlineExceeded
	}
	defer cancel()
	done := a02Start(operation, waiting, r.ID)
	pid := a02Arrived(t, ctx, gate)
	a01Wait(t, ctx, p, pid, "advisory")
	if !deadline {
		cancel()
	}
	reply := a02Receive(t, ctx, done)
	a02Error(t, reply.request, reply.err, want)
	_ = tx.Rollback(ctx)
	if outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("canceled approval lock wait changed persisted state")
	}
}
