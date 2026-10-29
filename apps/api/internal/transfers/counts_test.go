package transfers_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/transfers"
)

func TestA04CountsDependencies(t *testing.T) {
	for _, tc := range []struct {
		s   *transfers.Store
		ctx context.Context
	}{{nil, context.Background()}, {transfers.New(nil), context.Background()}, {&transfers.Store{}, context.Background()}, {transfers.New(&pgxpool.Pool{}), nil}} {
		got, err := tc.s.Counts(tc.ctx, actor(0))
		if err != transfers.ErrUnavailable || got != (transfers.Totals{}) {
			t.Fatal("dependencies must precede identity and return zero")
		}
	}
	for _, identity := range []auth.Identity{actor(0), actor(32768), {AccountID: 1, Location: auth.Location{ID: 3}}} {
		got, err := transfers.New(&pgxpool.Pool{}).Counts(context.Background(), identity)
		if err != transfers.ErrForbidden || got != (transfers.Totals{}) {
			t.Fatal("invalid assigned identity reached SQL")
		}
	}
}

func TestA04CountsStates(t *testing.T) {
	ctx, p, s := fixture(t)
	check := func(want [3]transfers.Totals) {
		t.Helper()
		before := outcomeSnapshot(t, ctx, p)
		for i, total := range want {
			got, err := s.Counts(ctx, actor(i+1))
			if err != nil || got != total {
				t.Errorf("actor %d totals=%+v want=%+v error=%v", i+1, got, total, err)
			}
		}
		if outcomeSnapshot(t, ctx, p) != before {
			t.Fatal("counts mutated outcomes/items/balances/allocations")
		}
	}
	check([3]transfers.Totals{})
	var pending []transfers.Request
	for i, flow := range []struct {
		kind         transfers.Kind
		counterparty int
	}{{transfers.RequestStock, 1}, {transfers.RequestStock, 3}, {transfers.SendToWarehouse, 1}} {
		in := input()
		in.Kind, in.CounterpartyID, in.RetryKey = flow.kind, flow.counterparty, fmt.Sprintf("a04-count-flow-key-%d", i)
		pending = append(pending, create(t, ctx, s, 2, in).Request)
	}
	check([3]transfers.Totals{
		{PendingTotal: 2, ActionCount: 2, Actions: transfers.ActionBreakdown{Approve: 2}},
		{PendingTotal: 3},
		{PendingTotal: 1, ActionCount: 1, Actions: transfers.ActionBreakdown{Approve: 1}},
	})
	approved, err := s.Approve(ctx, actor(1), pending[0].ID)
	if err != nil {
		t.Fatal("counts approval setup failed")
	}
	rejected, err := s.Reject(ctx, actor(3), pending[1].ID)
	if err != nil {
		t.Fatal("counts rejection setup failed")
	}
	check([3]transfers.Totals{
		{PendingTotal: 1, ActionCount: 2, Actions: transfers.ActionBreakdown{Approve: 1, Dispatch: 1}},
		{PendingTotal: 1}, {},
	})
	before := outcomeSnapshot(t, ctx, p)
	a, ae := s.Approve(ctx, actor(1), pending[0].ID)
	r, re := s.Reject(ctx, actor(3), pending[1].ID)
	if ae != nil || re != nil || !reflect.DeepEqual(a, approved) || !reflect.DeepEqual(r, rejected) || outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("decision retries changed original outcomes or owned state")
	}
	check([3]transfers.Totals{
		{PendingTotal: 1, ActionCount: 2, Actions: transfers.ActionBreakdown{Approve: 1, Dispatch: 1}},
		{PendingTotal: 1}, {},
	})
	for i := 0; i < 51; i++ {
		in := input()
		in.RetryKey = fmt.Sprintf("a04-count-many-key-%03d", i)
		create(t, ctx, s, 3, in)
	}
	// Branch A is not a participant in these 51 two-item requests.
	check([3]transfers.Totals{
		{PendingTotal: 52, ActionCount: 53, Actions: transfers.ActionBreakdown{Approve: 52, Dispatch: 1}},
		{PendingTotal: 1}, {PendingTotal: 51},
	})
	page, err := s.List(ctx, actor(1), transfers.Query{Page: 1_000_000, PageSize: 10})
	if err != nil || page.Total != 52 || len(page.Records) != 0 {
		t.Fatal("counts must not depend on page size or far pages")
	}
}

// Pause after the aggregate has executed, before commit, on an actual backend.
// A decision committed on a different connection cannot split the two totals.
type a04CountTrace struct {
	done, resume chan struct{}
	pid          chan uint32
	once         sync.Once
	mu           sync.Mutex
	rr           bool
}
type a04CountKey struct{}

func (tr *a04CountTrace) TraceQueryStart(ctx context.Context, conn *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	if strings.HasPrefix(d.SQL, "begin ") {
		tr.mu.Lock()
		tr.rr = strings.Contains(d.SQL, "repeatable read") && strings.Contains(d.SQL, "read only")
		tr.mu.Unlock()
	}
	if strings.Contains(d.SQL, "count(*) FILTER") && strings.Contains(d.SQL, "transfer_requests") {
		tr.pid <- conn.PgConn().PID()
		return context.WithValue(ctx, a04CountKey{}, true)
	}
	return ctx
}
func (tr *a04CountTrace) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryEndData) {
	if ctx.Value(a04CountKey{}) != true || d.Err != nil {
		return
	}
	tr.once.Do(func() {
		close(tr.done)
		select {
		case <-tr.resume:
		case <-ctx.Done():
		}
	})
}
func TestA04CountsSnapshot(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	if got, err := s.Counts(ctx, actor(1)); err != nil || got.PendingTotal != 1 {
		t.Fatal("snapshot requires a correct initial aggregate")
	}
	trace := &a04CountTrace{done: make(chan struct{}), resume: make(chan struct{}), pid: make(chan uint32, 1)}
	cfg := p.Config().Copy()
	cfg.ConnConfig.Tracer = trace
	traced, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("counts traced pool failed")
	}
	defer traced.Close()
	readctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type result struct {
		totals transfers.Totals
		err    error
	}
	done := make(chan result, 1)
	go func() {
		got, err := transfers.New(traced).Counts(readctx, actor(1))
		done <- result{got, err}
	}()
	// Always join before pool/owned database cleanup, including failed handshakes.
	joined := false
	defer func() {
		cancel()
		if !joined {
			<-done
		}
	}()
	select {
	case <-trace.done:
	case <-ctx.Done():
		t.Fatal("counts aggregate handshake missing")
	}
	pid := <-trace.pid
	var waiting bool
	if p.QueryRow(ctx, "SELECT state='idle in transaction' AND wait_event_type='Client' AND wait_event='ClientRead' FROM pg_stat_activity WHERE pid=$1", pid).Scan(&waiting) != nil || !waiting {
		t.Fatal("counts backend did not retain its open snapshot")
	}
	if _, err := s.Reject(ctx, actor(1), r.ID); err != nil {
		t.Fatal("interleaved decision failed")
	}
	before := outcomeSnapshot(t, ctx, p)
	close(trace.resume)
	got := <-done
	joined = true
	if got.err != nil || got.totals != (transfers.Totals{PendingTotal: 1, ActionCount: 1, Actions: transfers.ActionBreakdown{Approve: 1}}) {
		t.Fatal("aggregate observed split or newer counts")
	}
	trace.mu.Lock()
	rr := trace.rr
	trace.mu.Unlock()
	if !rr {
		t.Fatal("counts snapshot was not read-only repeatable-read")
	}
	fresh, err := s.Counts(ctx, actor(1))
	if err != nil || fresh != (transfers.Totals{}) || outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("fresh aggregate or read-only state incorrect")
	}
}

func TestR1CountsReceiptSnapshot(t *testing.T) {
	ctx, p, s := fixture(t)
	r := receiptDispatch(t, ctx, s, input())
	trace := &a04CountTrace{done: make(chan struct{}), resume: make(chan struct{}), pid: make(chan uint32, 1)}
	cfg := p.Config().Copy()
	cfg.ConnConfig.Tracer = trace
	traced, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("receipt count traced pool")
	}
	defer traced.Close()
	readctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type result struct {
		totals transfers.Totals
		err    error
	}
	done := make(chan result, 1)
	joined := false
	defer func() {
		cancel()
		if !joined {
			<-done
		}
	}()
	go func() { got, err := transfers.New(traced).Counts(readctx, actor(2)); done <- result{got, err} }()
	select {
	case <-trace.done:
	case <-ctx.Done():
		t.Fatal("receipt aggregate handshake missing")
	}
	if _, err := s.Receive(ctx, actor(2), r.ID, receiptInput(r)); err != nil {
		t.Fatal("concurrent receipt finalization", err)
	}
	before := receiptSnapshot(t, ctx, p)
	close(trace.resume)
	got := <-done
	joined = true
	if got.err != nil || got.totals != (transfers.Totals{ActionCount: 1, Actions: transfers.ActionBreakdown{Receive: 1}}) {
		t.Fatal("receipt split the read-only aggregate snapshot", got.err)
	}
	trace.mu.Lock()
	rr := trace.rr
	trace.mu.Unlock()
	if !rr {
		t.Fatal("receipt aggregate was not read-only repeatable-read")
	}
	fresh, err := s.Counts(ctx, actor(2))
	if err != nil || fresh != (transfers.Totals{}) || receiptSnapshot(t, ctx, p) != before {
		t.Fatal("fresh final receipt counts incorrect or mutated state")
	}
}

func TestA04CountsErrors(t *testing.T) {
	ctx, p, s := fixture(t)
	create(t, ctx, s, 2, input())
	before := outcomeSnapshot(t, ctx, p)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	expired, stop := context.WithDeadline(ctx, time.Now().Add(-time.Second))
	defer stop()
	for _, tc := range []struct {
		ctx  context.Context
		want error
	}{{canceled, context.Canceled}, {expired, context.DeadlineExceeded}} {
		got, err := s.Counts(tc.ctx, actor(1))
		if !errors.Is(err, tc.want) || got != (transfers.Totals{}) {
			t.Error("context failure must return zero totals")
		}
	}
	if got, err := s.Counts(ctx, actor(1)); err != nil || got.PendingTotal != 1 {
		t.Fatal("active cancellation requires a correct initial aggregate")
	}
	// Valid identity reaches SQL, where a locked table forces active cancellation.
	tx := a01Begin(t, ctx, p)
	defer tx.Rollback(context.Background())
	a01Exec(t, ctx, tx, "LOCK TABLE transfer_requests IN ACCESS EXCLUSIVE MODE")
	cfg := p.Config().Copy()
	trace := &a04CountTrace{pid: make(chan uint32, 1)}
	cfg.ConnConfig.Tracer = trace
	traced, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("counts error pool failed")
	}
	defer traced.Close()
	readctx, finish := context.WithCancel(ctx)
	defer finish()
	done := make(chan error, 1)
	go func() {
		got, err := transfers.New(traced).Counts(readctx, actor(1))
		if got != (transfers.Totals{}) {
			err = errors.New("nonzero failed aggregate")
		}
		done <- err
	}()
	joined := false
	defer func() {
		finish()
		if !joined {
			<-done
		}
	}()
	var pid uint32
	select {
	case pid = <-trace.pid:
	case <-ctx.Done():
		t.Fatal("active aggregate did not reach SQL")
	}
	a01Wait(t, ctx, p, pid, "relation")
	finish()
	activeErr := <-done
	joined = true
	if !errors.Is(activeErr, context.Canceled) {
		t.Fatal("active counts cancellation not preserved")
	}
	if tx.Rollback(ctx) != nil {
		t.Fatal("counts lock rollback failed")
	}
	traced.Close()
	got, err := transfers.New(traced).Counts(ctx, actor(1))
	if err != transfers.ErrUnavailable || got != (transfers.Totals{}) {
		t.Fatal("closed pool error not sanitized/zero")
	}
	if _, err := p.Exec(ctx, "ALTER TABLE transfer_requests RENAME TO a04_unavailable_requests"); err != nil {
		t.Fatal("owned SQL failure setup failed")
	}
	got, err = s.Counts(ctx, actor(1))
	if err != transfers.ErrUnavailable || got != (transfers.Totals{}) {
		t.Error("SQL failure leaked or returned totals")
	}
	if _, err := p.Exec(ctx, "ALTER TABLE a04_unavailable_requests RENAME TO transfer_requests"); err != nil {
		t.Fatal("owned SQL failure restoration failed")
	}
	if outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("failed counts changed complete state")
	}
}
