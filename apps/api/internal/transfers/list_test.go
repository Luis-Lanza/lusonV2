package transfers_test

import (
	"context"
	"errors"
	"fmt"
	"math"
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

func TestR02ListDependencies(t *testing.T) {
	for _, tc := range []struct {
		name  string
		store *transfers.Store
		ctx   context.Context
	}{
		{"nil_context", transfers.New(&pgxpool.Pool{}), nil},
		{"nil_pool", transfers.New(nil), context.Background()},
		{"zero_store", &transfers.Store{}, context.Background()},
		{"nil_receiver", nil, context.Background()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if recover() != nil {
					t.Error("List dependency boundary panicked")
				}
			}()
			got, err := tc.store.List(tc.ctx, actor(2), transfers.Query{})
			if err != transfers.ErrUnavailable || !reflect.DeepEqual(got, transfers.Page{}) {
				t.Fatal("List dependency boundary not sanitized/zero")
			}
		})
	}
	for _, tc := range []struct {
		name     string
		identity auth.Identity
		query    transfers.Query
		want     error
	}{
		{"unassigned", actor(0), transfers.Query{}, transfers.ErrForbidden},
		{"unknown_actor", actor(4), transfers.Query{}, transfers.ErrForbidden},
		{"mismatched_account", auth.Identity{AccountID: 2, Location: auth.Location{ID: 3}}, transfers.Query{}, transfers.ErrForbidden},
		{"negative_page", actor(2), transfers.Query{Page: -1}, transfers.ErrInvalid},
		{"page_bound", actor(2), transfers.Query{Page: 1_000_001}, transfers.ErrInvalid},
		{"page_overflow", actor(2), transfers.Query{Page: math.MaxInt64}, transfers.ErrInvalid},
		{"negative_size", actor(2), transfers.Query{PageSize: -1}, transfers.ErrInvalid},
		{"arbitrary_size", actor(2), transfers.Query{PageSize: 11}, transfers.ErrInvalid},
		{"future_status", actor(2), transfers.Query{Status: "approved"}, transfers.ErrInvalid},
		{"status_case", actor(2), transfers.Query{Status: "Pending"}, transfers.ErrInvalid},
		{"status_space", actor(2), transfers.Query{Status: " pending"}, transfers.ErrInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if recover() != nil {
					t.Error("List input guard accessed placeholder pool")
				}
			}()
			got, err := transfers.New(&pgxpool.Pool{}).List(context.Background(), tc.identity, tc.query)
			if !errors.Is(err, tc.want) || !reflect.DeepEqual(got, transfers.Page{}) {
				t.Fatal("List actor/query guard did not reject before SQL")
			}
		})
	}
}
func TestR02ListPostgres(t *testing.T) {
	root := t
	t.Run("three_flow_participants", func(t *testing.T) {
		ctx, p, s := fixture(t)
		registerListAudit(root, p)
		before := stocks(t, ctx, p)
		warehouse := create(t, ctx, s, 2, input())
		in := input()
		in.CounterpartyID = 3
		in.RetryKey = "branch-to-branch-list-key"
		branch := create(t, ctx, s, 2, in)
		in = input()
		in.Kind = transfers.SendToWarehouse
		in.RetryKey = "warehouse-proposal-list-key"
		proposal := create(t, ctx, s, 2, in)
		warehouseB := create(t, ctx, s, 3, input())
		proposalB := create(t, ctx, s, 3, in)
		for _, tc := range []struct {
			name string
			id   int
			want []transfers.Request
		}{
			{"warehouse", 1, []transfers.Request{proposalB.Request, warehouseB.Request, proposal.Request, warehouse.Request}},
			{"branch_a", 2, []transfers.Request{proposal.Request, branch.Request, warehouse.Request}},
			{"branch_b", 3, []transfers.Request{proposalB.Request, warehouseB.Request, branch.Request}},
		} {
			t.Run(tc.name, func(t *testing.T) {
				got, err := s.List(ctx, actor(tc.id), transfers.Query{})
				if err != nil || got.Total != int64(len(tc.want)) || got.Page != 1 || got.PageSize != 25 || !reflect.DeepEqual(got.Records, tc.want) {
					t.Fatal("participant-scoped list/count or complete records incorrect")
				}
			})
		}
		unchanged(t, before, stocks(t, ctx, p))
	})
	t.Run("pagination_and_private_empty", testListPagination)
	t.Run("lossless_complete_catalog", testListExact)
	t.Run("count_ids_same_snapshot", testListSnapshot)
	t.Run("concurrent_commits", testListConcurrent)
	t.Run("cancel_active_snapshot", testListCancelSnapshot)
	t.Run("cancellation_and_sanitization", testListErrors)
}

func registerListAudit(t *testing.T, p *pgxpool.Pool) {
	t.Helper()
	cfg := p.Config().ConnConfig.Copy()
	cfg.Database = "luson_test"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	admin, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal("list fixture audit connection failed")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		defer admin.Close(ctx)
		var user, db string
		if admin.QueryRow(ctx, "SELECT current_user,current_database()").Scan(&user, &db) != nil || user != "luson_test" || db != "luson_test" {
			t.Fatal("list fixture audit identity rejected")
		}
		for {
			var total, owned, foreign int
			if admin.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE datname ~ '^luson_test_[a-f0-9]{32}$'),
    count(*) FILTER (WHERE datname NOT IN ('luson_test','postgres','template0','template1')) FROM pg_database`).Scan(&total, &owned, &foreign) != nil {
				t.Fatal("list final catalog audit failed")
			}
			if total == 4 && owned == 0 && foreign == 0 {
				break
			}
			select {
			case <-ctx.Done():
				t.Fatal("list fixture databases did not settle")
			case <-time.After(10 * time.Millisecond):
			}
		}
		var tables int
		if admin.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables) != nil || tables != 0 {
			t.Fatal("list changed admin schema")
		}
		t.Log("list settled fixture: baseline=4 owned=0 nonbaseline=0 admin_public=0")
	})
}
func testListPagination(t *testing.T) {
	ctx, p, s := fixture(t)
	before := stocks(t, ctx, p)
	empty, err := s.List(ctx, actor(1), transfers.Query{})
	if err != nil || empty.Total != 0 || empty.Records == nil || len(empty.Records) != 0 || empty.Page != 1 || empty.PageSize != 25 {
		t.Fatal("valid empty list shape/defaults incorrect")
	}
	want := make([]transfers.Request, 51)
	for i := range want {
		in := input()
		in.RetryKey = fmt.Sprintf("list-pagination-key-%03d", i)
		want[len(want)-1-i] = create(t, ctx, s, 2, in).Request
	}
	for _, tc := range []struct {
		name        string
		query       transfers.Query
		first, last int
		page        int64
		size        int
	}{
		{"defaults", transfers.Query{}, 0, 25, 1, 25},
		{"size10_first", transfers.Query{PageSize: 10}, 0, 10, 1, 10},
		{"size10_second", transfers.Query{Page: 2, PageSize: 10}, 10, 20, 2, 10},
		{"size25_second", transfers.Query{Page: 2, PageSize: 25, Status: "pending"}, 25, 50, 2, 25},
		{"size50_first", transfers.Query{PageSize: 50}, 0, 50, 1, 50},
		{"size50_last", transfers.Query{Page: 2, PageSize: 50}, 50, 51, 2, 50},
		{"empty_far_page", transfers.Query{Page: 1_000_000, PageSize: 50}, 51, 51, 1_000_000, 50},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := s.List(ctx, actor(2), tc.query)
			if err != nil || got.Total != 51 || got.Page != tc.page || got.PageSize != tc.size || got.Records == nil || !reflect.DeepEqual(got.Records, want[tc.first:tc.last]) {
				t.Fatal("scoped pagination or descending ordering incorrect")
			}
		})
	}
	for _, q := range []transfers.Query{{}, {Page: 1_000_000, PageSize: 50}} {
		got, err := s.List(ctx, actor(3), q)
		if err != nil || got.Total != 0 || got.Records == nil || len(got.Records) != 0 {
			t.Fatal("uninvolved account learned a private count/record")
		}
	}
	unchanged(t, before, stocks(t, ctx, p))
}
func testListExact(t *testing.T) {
	ctx, p, s := fixture(t)
	if _, err := p.Exec(ctx, "UPDATE inventory_balances SET existing=$1 WHERE location_id=1", int64(math.MaxInt64)); err != nil {
		t.Fatal("owned exact-list stock setup failed")
	}
	if _, err := p.Exec(ctx, "SELECT setval('transfer_requests_id_seq',9007199254740992,true)"); err != nil {
		t.Fatal("owned exact-list reference setup failed")
	}
	before := stocks(t, ctx, p)
	in := input()
	in.Items = make([]transfers.Line, 190)
	for i := range in.Items {
		in.Items[i] = transfers.Line{VariantID: int64(190 - i), Quantity: math.MaxInt64}
	}
	r := create(t, ctx, s, 2, in)
	got, err := s.List(ctx, actor(1), transfers.Query{})
	if err != nil || got.Total != 1 || len(got.Records) != 1 || !reflect.DeepEqual(got.Records[0], r.Request) || got.Records[0].ID != 9007199254740993 {
		t.Fatal("lossless complete request not listed")
	}
	fractional := false
	for _, item := range got.Records[0].Items {
		if item.Quantity != math.MaxInt64 || (item.Polarity != "L" && item.Polarity != "R") {
			t.Fatal("quantity/polarity lost")
		}
		if item.Brand == "TOYO_MOTO" && item.Model == "12N6,5_3B" && item.Capacity == "6.5" {
			fractional = true
		}
	}
	if !fractional {
		t.Fatal("exact fractional catalog metadata not listed")
	}
	unchanged(t, before, stocks(t, ctx, p))
}

type countTraceKey struct{}
type listSnapshotTrace struct {
	counted, resume    chan struct{}
	once               sync.Once
	mu                 sync.Mutex
	readonlyRepeatable bool
}

func (tr *listSnapshotTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.HasPrefix(data.SQL, "begin ") {
		tr.mu.Lock()
		tr.readonlyRepeatable = strings.Contains(data.SQL, "repeatable read") && strings.Contains(data.SQL, "read only")
		tr.mu.Unlock()
	}
	if strings.HasPrefix(data.SQL, "SELECT count(*) FROM transfer_requests") {
		return context.WithValue(ctx, countTraceKey{}, true)
	}
	return ctx
}
func (tr *listSnapshotTrace) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if ctx.Value(countTraceKey{}) != true || data.Err != nil {
		return
	}
	tr.once.Do(func() {
		close(tr.counted)
		select {
		case <-tr.resume:
		case <-ctx.Done():
		}
	})
}
func testListSnapshot(t *testing.T) {
	ctx, p, s := fixture(t)
	before := stocks(t, ctx, p)
	first := create(t, ctx, s, 2, input())
	trace := &listSnapshotTrace{counted: make(chan struct{}), resume: make(chan struct{})}
	cfg := p.Config().Copy()
	cfg.ConnConfig.Tracer = trace
	traced, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("snapshot test pool failed")
	}
	t.Cleanup(traced.Close)
	readctx, cancel := context.WithCancel(ctx)
	defer cancel()
	result := make(chan transfers.Page, 1)
	errs := make(chan error, 1)
	go func() {
		page, err := transfers.New(traced).List(readctx, actor(2), transfers.Query{})
		result <- page
		errs <- err
	}()
	select {
	case <-trace.counted:
	case <-ctx.Done():
		t.Fatal("list count handshake not reached")
	}
	// A real writer commits between COUNT and IDs, on another connection.
	in := input()
	in.RetryKey = "snapshot-interleaved-writer-key"
	second := create(t, ctx, s, 2, in)
	close(trace.resume)
	page := <-result
	if err := <-errs; err != nil || page.Total != 1 || !reflect.DeepEqual(page.Records, []transfers.Request{first.Request}) {
		t.Fatal("count/IDs/load observed mixed snapshots")
	}
	trace.mu.Lock()
	rr := trace.readonlyRepeatable
	trace.mu.Unlock()
	if !rr {
		t.Fatal("list did not begin read-only repeatable-read transaction")
	}
	fresh, err := s.List(ctx, actor(2), transfers.Query{})
	if err != nil || fresh.Total != 2 || !reflect.DeepEqual(fresh.Records, []transfers.Request{second.Request, first.Request}) {
		t.Fatal("fresh snapshot did not include committed writer")
	}
	unchanged(t, before, stocks(t, ctx, p))
}
func testListCancelSnapshot(t *testing.T) {
	ctx, p, _ := fixture(t)
	before := stocks(t, ctx, p)
	trace := &listSnapshotTrace{counted: make(chan struct{}), resume: make(chan struct{})}
	cfg := p.Config().Copy()
	cfg.ConnConfig.Tracer = trace
	traced, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("cancel snapshot pool failed")
	}
	t.Cleanup(traced.Close)
	readctx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan transfers.Page, 1)
	errs := make(chan error, 1)
	go func() {
		page, err := transfers.New(traced).List(readctx, actor(2), transfers.Query{})
		results <- page
		errs <- err
	}()
	select {
	case <-trace.counted:
	case <-ctx.Done():
		t.Fatal("cancel snapshot handshake not reached")
	}
	cancel()
	select {
	case err := <-errs:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("active snapshot cancellation not preserved")
		}
	case <-ctx.Done():
		t.Fatal("canceled snapshot did not release")
	}
	if !reflect.DeepEqual(<-results, transfers.Page{}) {
		t.Fatal("canceled snapshot exposed partial page")
	}
	fresh, err := transfers.New(traced).List(ctx, actor(2), transfers.Query{})
	if err != nil || fresh.Total != 0 || fresh.Records == nil {
		t.Fatal("canceled snapshot retained pool/transaction resources")
	}
	unchanged(t, before, stocks(t, ctx, p))
}

func testListConcurrent(t *testing.T) {
	ctx, p, s := fixture(t)
	before := stocks(t, ctx, p)
	// First commit is an explicit handshake; subsequent lists overlap a writer
	// without requiring any particular scheduler timing or arbitrary sleeps.
	firstCommit := make(chan error, 1)
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 12; i++ {
			in := input()
			in.RetryKey = fmt.Sprintf("concurrent-list-writer-key-%03d", i)
			if _, err := s.Create(ctx, actor(2), in); err != nil {
				if i == 0 {
					firstCommit <- err
				}
				done <- err
				return
			}
			if i == 0 {
				firstCommit <- nil
			}
		}
		done <- nil
	}()
	select {
	case err := <-firstCommit:
		if err != nil {
			t.Fatal("concurrent list writer failed")
		}
	case <-ctx.Done():
		t.Fatal("concurrent list writer handshake failed")
	}
	for i := 0; i < 12; i++ {
		got, err := s.List(ctx, actor(2), transfers.Query{PageSize: 10})
		if err != nil || got.Total < 1 || got.Total > 12 || len(got.Records) != int(min(got.Total, 10)) {
			t.Fatal("concurrent list count/page inconsistent")
		}
		for j, r := range got.Records {
			if r.Destination.ID != 2 || (j > 0 && got.Records[j-1].ID <= r.ID) {
				t.Fatal("concurrent list privacy/order changed")
			}
		}
	}
	if err := <-done; err != nil {
		t.Fatal("concurrent writer did not complete")
	}
	final, err := s.List(ctx, actor(2), transfers.Query{PageSize: 25})
	if err != nil || final.Total != 12 || len(final.Records) != 12 {
		t.Fatal("final committed snapshot incomplete")
	}
	unchanged(t, before, stocks(t, ctx, p))
}
func testListErrors(t *testing.T) {
	ctx, p, s := fixture(t)
	expired, cancel := context.WithDeadline(ctx, time.Now().Add(-time.Second))
	defer cancel()
	got, err := s.List(expired, actor(2), transfers.Query{})
	if !errors.Is(err, context.DeadlineExceeded) || !reflect.DeepEqual(got, transfers.Page{}) {
		t.Fatal("List deadline/zero result not preserved")
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, err := s.List(canceled, actor(2), transfers.Query{}); !errors.Is(err, context.Canceled) {
		t.Fatal("List cancellation not preserved")
	}
	p.Close()
	got, err = s.List(ctx, actor(2), transfers.Query{})
	if err != transfers.ErrUnavailable || !reflect.DeepEqual(got, transfers.Page{}) {
		t.Fatal("List pool error was not sanitized")
	}
}
