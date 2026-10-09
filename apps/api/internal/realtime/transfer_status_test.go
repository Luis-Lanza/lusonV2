package realtime

import (
	"context"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/transfers"
)

// A committed marker on this same LISTEN stream establishes silence without
// sleeps. Exact payload comparison also rejects request IDs or DTO metadata.
type a04Listener struct{ conn *pgx.Conn }

func a04Listen(t *testing.T, f *brokerFixture) *a04Listener {
	t.Helper()
	c, err := pgx.ConnectConfig(f.ctx, f.p.Config().ConnConfig.Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close(context.Background()) })
	if _, err = c.Exec(f.ctx, "LISTEN luson_realtime; LISTEN a04_boundary"); err != nil {
		t.Fatal(err)
	}
	return &a04Listener{c}
}
func (l *a04Listener) boundary(t *testing.T, f *brokerFixture, want ...string) {
	t.Helper()
	if _, err := f.p.Exec(f.ctx, "SELECT pg_notify('a04_boundary','done')"); err != nil {
		t.Fatal(err)
	}
	var got []string
	for {
		n, err := l.conn.WaitForNotification(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if n.Channel == "a04_boundary" {
			break
		}
		if n.Channel != "luson_realtime" {
			t.Fatal("unexpected notification channel")
		}
		got = append(got, n.Payload)
	}
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("private commit metadata: got %v want %v", got, want)
	}
}
func a04Revisions(t *testing.T, f *brokerFixture, before map[string]int64, inventory int64, participants ...int) {
	t.Helper()
	want := make(map[string]int64, len(before))
	for k, v := range before {
		want[k] = v
	}
	want["inventory"] += inventory
	for _, id := range participants {
		want[fmt.Sprintf("transfers:%d", id)]++
	}
	if got := f.revisions(t); !reflect.DeepEqual(got, want) {
		t.Fatalf("revision delta: got %v want %v", got, want)
	}
}
func a04State(t *testing.T, f *brokerFixture) string {
	t.Helper()
	var state string
	err := f.p.QueryRow(f.ctx, `SELECT jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM transfer_requests r),
 (SELECT jsonb_agg(to_jsonb(i) ORDER BY request_id,variant_id) FROM transfer_request_items i),
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY request_id,variant_id) FROM transfer_request_allocations a),
 (SELECT jsonb_agg(to_jsonb(b) ORDER BY location_id,variant_id) FROM inventory_balances b))::text`).Scan(&state)
	if err != nil {
		t.Fatal(err)
	}
	return state
}
func TestA04TransferStatusDecisions(t *testing.T) {
	for _, approve := range []bool{false, true} {
		for _, flow := range []struct {
			kind                                        transfers.Kind
			counterparty, origin, destination, approver int
		}{{transfers.RequestStock, 1, 1, 2, 1}, {transfers.RequestStock, 3, 3, 2, 3}, {transfers.SendToWarehouse, 1, 2, 1, 1}} {
			t.Run(fmt.Sprintf("approve_%v_%s_%d", approve, flow.kind, flow.origin), func(t *testing.T) {
				f := brokerFixtureDB(t)
				r := f.create(t, 2, f.input(flow.kind, flow.counterparty)).Request
				l := a04Listen(t, f)
				before, stock := f.revisions(t), f.stock(t)
				decision, opposite := f.store.Reject, f.store.Approve
				inventory := int64(0)
				want := []string{fmt.Sprintf("transfers:%d", flow.origin), fmt.Sprintf("transfers:%d", flow.destination)}
				if approve {
					decision, opposite = f.store.Approve, f.store.Reject
					inventory = 1
					want = append(want, "inventory:0")
				}
				out, err := decision(f.ctx, f.actors[flow.approver-1], r.ID)
				if err != nil || out.ID != r.ID || out.DecidedAt == nil {
					t.Fatal("actual decision did not commit", err)
				}
				// Check revisions before notification expectations so RED proves
				// a committed domain decision, not a listener/fixture failure.
				a04Revisions(t, f, before, inventory, flow.origin, flow.destination)
				l.boundary(t, f, want...)
				if !approve {
					f.unchanged(t, stock)
				}
				before, state := f.revisions(t), a04State(t, f)
				retry, err := decision(f.ctx, f.actors[flow.approver-1], r.ID)
				if err != nil || !reflect.DeepEqual(retry, out) {
					t.Fatal("terminal retry changed original outcome", err)
				}
				if _, err := opposite(f.ctx, f.actors[flow.approver-1], r.ID); err != transfers.ErrDecisionConflict {
					t.Fatal("opposite terminal action did not conflict", err)
				}
				// Lifecycle guards forbid row-level no-op UPDATEs. An empty
				// statement is the admitted unchanged-status transition set.
				if _, err := f.p.Exec(f.ctx, "UPDATE transfer_requests SET status=status WHERE false"); err != nil {
					t.Fatal(err)
				}
				if _, err := f.p.Exec(f.ctx, "UPDATE transfer_requests SET status=status WHERE id=$1", r.ID); err == nil {
					t.Fatal("immutable terminal guard bypassed")
				}
				l.boundary(t, f)
				a04Revisions(t, f, before, 0)
				if a04State(t, f) != state {
					t.Fatal("retry/conflict/no-op mutated state")
				}
			})
		}
	}
}

func TestA04TransferStatusRollback(t *testing.T) {
	f := brokerFixtureDB(t)
	r := f.create(t, 2, f.input(transfers.RequestStock, 1)).Request
	l := a04Listen(t, f)
	before, state := f.revisions(t), a04State(t, f)
	for _, failCommit := range []bool{false, true} {
		tx, err := f.p.Begin(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		func() {
			defer tx.Rollback(context.Background())
			// The same protected ordering as Approve, with complete valid
			// ownership for rollback; deliberately missing ownership only
			// for the deferred-failure case. No guard is disabled.
			queries := []string{"SELECT pg_advisory_xact_lock(714025,1)", "UPDATE inventory_balances SET reserved=reserved+1 WHERE location_id=1 AND variant_id=1"}
			if !failCommit {
				queries = append(queries, fmt.Sprintf("INSERT INTO transfer_request_allocations(request_id,variant_id,quantity) VALUES(%d,1,1)", r.ID))
			}
			queries = append(queries, fmt.Sprintf("UPDATE transfer_requests SET status='approved' WHERE id=%d", r.ID))
			for _, q := range queries {
				if _, err := tx.Exec(f.ctx, q); err != nil {
					t.Fatal("approval stage failed", err)
				}
			}
			var status string
			var rev int64
			if tx.QueryRow(f.ctx, "SELECT status FROM transfer_requests WHERE id=$1", r.ID).Scan(&status) != nil || status != "approved" {
				t.Fatal("staged outcome not reloadable")
			}
			if tx.QueryRow(f.ctx, "SELECT revision FROM realtime_revisions WHERE scope='transfers:1'").Scan(&rev) != nil || rev != before["transfers:1"]+1 {
				t.Fatal("status stage did not invalidate inside transaction")
			}
			l.boundary(t, f)
			a04Revisions(t, f, before, 0)
			if failCommit {
				if tx.Commit(f.ctx) == nil {
					t.Fatal("deferred invalid ownership committed")
				}
			} else if tx.Rollback(f.ctx) != nil {
				t.Fatal("explicit rollback failed")
			}
		}()
		l.boundary(t, f)
		a04Revisions(t, f, before, 0)
		if a04State(t, f) != state {
			t.Fatal("rollback retained status, ownership or inventory")
		}
	}
}

// The trace exposes only PID and query stage, never query arguments. It pauses
// after a successful status statement, while all transaction locks remain held.
type a04Trace struct {
	pid            atomic.Uint32
	staged, resume chan struct{}
	once           sync.Once
	loads          atomic.Int32
	commitFailed   atomic.Bool
}

func (tr *a04Trace) TraceQueryStart(ctx context.Context, conn *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	tr.pid.Store(conn.PgConn().PID())
	return context.WithValue(ctx, tr, d.SQL)
}
func (tr *a04Trace) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryEndData) {
	sql, _ := ctx.Value(tr).(string)
	if strings.HasPrefix(sql, "SELECT r.id,r.kind,r.status") && d.Err == nil {
		tr.loads.Add(1)
	}
	if sql == "commit" && d.Err != nil {
		tr.commitFailed.Store(true)
	}
	if strings.HasPrefix(sql, "UPDATE transfer_requests SET status=") && d.Err == nil && tr.staged != nil {
		tr.once.Do(func() {
			close(tr.staged)
			select {
			case <-tr.resume:
			case <-ctx.Done():
			}
		})
	}
}
func a04Pool(t *testing.T, f *brokerFixture, tr *a04Trace) *pgxpool.Pool {
	t.Helper()
	cfg := f.p.Config()
	cfg.ConnConfig.Tracer = tr
	p, err := pgxpool.NewWithConfig(f.ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}
func a04Blocked(t *testing.T, f *brokerFixture, pid uint32, blocker uint32, event string) {
	t.Helper()
	for {
		var waiting bool
		err := f.p.QueryRow(f.ctx, `SELECT $2=ANY(pg_blocking_pids(pid)) AND wait_event=$3
 FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()`, int32(pid), int32(blocker), event).Scan(&waiting)
		if err == nil && waiting {
			return
		}
		if f.ctx.Err() != nil {
			t.Fatal("expected PostgreSQL lock wait missing", err)
		}
	}
}
func TestA04TransferStatusDeferredDomainFailure(t *testing.T) {
	for _, approve := range []bool{false, true} {
		t.Run(fmt.Sprint(approve), func(t *testing.T) {
			f := brokerFixtureDB(t)
			r := f.create(t, 2, f.input(transfers.RequestStock, 1)).Request
			l := a04Listen(t, f)
			before, state := f.revisions(t), a04State(t, f)
			// Strengthen, never replace, the immutable lifecycle guards.
			if _, err := f.p.Exec(f.ctx, `CREATE FUNCTION a04_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A04 injected deferred failure'; END; $$;
 CREATE CONSTRAINT TRIGGER a04_fail_commit AFTER UPDATE ON transfer_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION a04_fail_commit()`); err != nil {
				t.Fatal(err)
			}
			tr := &a04Trace{staged: make(chan struct{}), resume: make(chan struct{})}
			p := a04Pool(t, f, tr)
			ctx, cancel := context.WithCancel(f.ctx)
			var wg sync.WaitGroup
			defer func() { cancel(); wg.Wait() }()
			done := make(chan error, 1)
			wg.Add(1)
			go func() {
				defer wg.Done()
				decide := transfers.New(p).Reject
				if approve {
					decide = transfers.New(p).Approve
				}
				out, err := decide(ctx, f.actors[0], r.ID)
				if !reflect.DeepEqual(out, transfers.Request{}) {
					err = fmt.Errorf("failed commit exposed outcome")
				}
				done <- err
			}()
			select {
			case <-tr.staged:
			case <-f.ctx.Done():
				t.Fatal("successful status stage absent")
			}
			l.boundary(t, f)
			a04Revisions(t, f, before, 0)
			if a04State(t, f) != state {
				t.Fatal("staged decision became externally visible")
			}
			close(tr.resume)
			select {
			case err := <-done:
				if err != transfers.ErrUnavailable || !tr.commitFailed.Load() || tr.loads.Load() != 2 {
					t.Fatal("failure was not after stage/reload at deferred commit", err)
				}
			case <-f.ctx.Done():
				t.Fatal("failed decision did not join")
			}
			l.boundary(t, f)
			a04Revisions(t, f, before, 0)
			if a04State(t, f) != state {
				t.Fatal("actual failed decision retained effects")
			}
		})
	}
}

func TestA04TransferStatusMultirowSortedLocks(t *testing.T) {
	f := brokerFixtureDB(t)
	first := f.create(t, 2, f.input(transfers.RequestStock, 3)).Request
	second := f.create(t, 2, f.input(transfers.RequestStock, 1)).Request
	l := a04Listen(t, f)
	before, stock := f.revisions(t), f.stock(t)
	blocker, err := f.p.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(f.ctx, "SELECT scope FROM realtime_revisions WHERE scope='transfers:1' FOR UPDATE"); err != nil {
		t.Fatal(err)
	}
	c, err := pgx.ConnectConfig(f.ctx, f.p.Config().ConnConfig.Copy())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	ctx, cancel := context.WithCancel(f.ctx)
	var wg sync.WaitGroup
	defer func() { cancel(); wg.Wait() }()
	done := make(chan error, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		tag, err := c.Exec(ctx, "UPDATE transfer_requests SET status='rejected' WHERE id=ANY($1::bigint[])", []int64{first.ID, second.ID})
		if err == nil && tag.RowsAffected() != 2 {
			err = fmt.Errorf("multirow set incomplete")
		}
		done <- err
	}()
	a04Blocked(t, f, c.PgConn().PID(), blocker.Conn().PgConn().PID(), "transactionid")
	// Both larger keys must still be free: locking per header would retain
	// 2/3 from the first request before discovering 1 in the second request.
	probe, err := f.p.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = probe.Exec(f.ctx, "SELECT scope FROM realtime_revisions WHERE scope IN ('transfers:2','transfers:3') ORDER BY scope FOR UPDATE NOWAIT")
	_ = probe.Rollback(f.ctx)
	if err != nil {
		t.Fatal("complete participant set was not locked ascending", err)
	}
	// Actual INSERT with opposite participants can finish while UPDATE waits;
	// it does not need the reservation advisory lock or inventory revision.
	f.create(t, 3, f.input(transfers.RequestStock, 2))
	l.boundary(t, f, "transfers:2", "transfers:3")
	a04Revisions(t, f, before, 0, 2, 3)
	before = f.revisions(t)
	if blocker.Commit(f.ctx) != nil {
		t.Fatal("sorted lock barrier release failed")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-f.ctx.Done():
		t.Fatal("multirow decision did not join")
	}
	l.boundary(t, f, "transfers:1", "transfers:2", "transfers:3")
	a04Revisions(t, f, before, 0, 3, 2, 1, 2)
	f.unchanged(t, stock)
}

func TestA04TransferStatusProtectedConcurrency(t *testing.T) {
	for _, approve := range []bool{false, true} {
		t.Run(fmt.Sprint(approve), func(t *testing.T) {
			f := brokerFixtureDB(t)
			r := f.create(t, 2, f.input(transfers.RequestStock, 1)).Request
			other := f.create(t, 2, f.input(transfers.RequestStock, 3)).Request
			l := a04Listen(t, f)
			before := f.revisions(t)
			tr := &a04Trace{staged: make(chan struct{}), resume: make(chan struct{})}
			p := a04Pool(t, f, tr)
			ctx, cancel := context.WithCancel(f.ctx)
			var wg sync.WaitGroup
			defer func() { cancel(); wg.Wait() }()
			result := make(chan error, 1)
			wg.Add(1)
			go func() {
				defer wg.Done()
				s := transfers.New(p)
				decide := s.Reject
				if approve {
					decide = s.Approve
				}
				_, err := decide(ctx, f.actors[0], r.ID)
				result <- err
			}()
			select {
			case <-tr.staged:
			case <-f.ctx.Done():
				t.Fatal("actual decision stage absent")
			}
			// Actual Approve already owns inventory before transfer rows.
			// Another protected decision waits on the advisory protocol, not
			// those rows, even with a different inventory source/audience.
			tr2 := &a04Trace{}
			p2 := a04Pool(t, f, tr2)
			second := make(chan error, 1)
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := transfers.New(p2).Reject(ctx, f.actors[2], other.ID)
				second <- err
			}()
			for tr2.pid.Load() == 0 {
				if f.ctx.Err() != nil {
					t.Fatal("second PID absent")
				}
			}
			a04Blocked(t, f, tr2.pid.Load(), tr.pid.Load(), "advisory")
			probe, err := f.p.Begin(f.ctx)
			if err != nil {
				t.Fatal(err)
			}
			_, lockErr := probe.Exec(f.ctx, "SELECT scope FROM realtime_revisions WHERE scope='inventory' FOR UPDATE NOWAIT")
			_ = probe.Rollback(f.ctx)
			if (lockErr != nil) != approve {
				t.Fatal("actual inventory-before-transfer lock evidence mismatch", lockErr)
			}
			tr3 := &a04Trace{}
			p3 := a04Pool(t, f, tr3)
			inserted := make(chan error, 1)
			input := f.input(transfers.RequestStock, 2)
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := transfers.New(p3).Create(ctx, f.actors[2], input)
				inserted <- err
			}()
			for tr3.pid.Load() == 0 {
				if f.ctx.Err() != nil {
					t.Fatal("insert PID absent")
				}
			}
			a04Blocked(t, f, tr3.pid.Load(), tr.pid.Load(), "transactionid")
			l.boundary(t, f)
			a04Revisions(t, f, before, 0)
			close(tr.resume)
			for _, ch := range []<-chan error{result, second, inserted} {
				select {
				case err := <-ch:
					if err != nil {
						t.Fatal(err)
					}
				case <-f.ctx.Done():
					t.Fatal("decision join failed")
				}
			}
			want := []string{"transfers:1", "transfers:2", "transfers:2", "transfers:3", "transfers:2", "transfers:3"}
			inv := int64(0)
			if approve {
				inv = 1
				want = append(want, "inventory:0")
			}
			l.boundary(t, f, want...)
			a04Revisions(t, f, before, inv, 1, 2, 2, 3, 2, 3)
		})
	}
}
