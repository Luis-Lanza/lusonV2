package transfers_test

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/transfers"
)

func TestA04OutcomeListFlows(t *testing.T) {
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
				pendingInput := in
				pendingInput.RetryKey = "a04-list-pending-key-0001"
				pending := create(t, ctx, s, 2, pendingInput).Request
				var want transfers.Request
				var err error
				if status == "approved" {
					want, err = s.Approve(ctx, actor(original.Approver.ID), original.ID)
				} else {
					want, err = s.Reject(ctx, actor(original.Approver.ID), original.ID)
				}
				if err != nil {
					t.Fatal("list outcome setup failed")
				}
				immutable := want
				immutable.Status, immutable.DecisionLocationID, immutable.DecidedAt = "pending", nil, nil
				if !reflect.DeepEqual(immutable, original) || want.DecisionLocationID == nil || *want.DecisionLocationID != original.Approver.ID || want.DecidedAt == nil || want.DecidedAt.Before(original.CreatedAt) || len(want.Items) != 2 {
					t.Fatal("outcome lost immutable items/actor/time")
				}
				before := outcomeSnapshot(t, ctx, p)
				for participant := 1; participant <= 3; participant++ {
					visible := participant == original.Origin.ID || participant == original.Destination.ID
					for _, selected := range []string{"all", "pending", "approved", "rejected"} {
						page, err := s.List(ctx, actor(participant), transfers.Query{Status: selected})
						if err != nil {
							t.Errorf("%s list rejected: %v", selected, err)
							continue
						}
						records := make([]transfers.Request, 0)
						if visible && selected == status {
							records = append(records, want)
						}
						if visible && selected == "pending" {
							records = append(records, pending)
						}
						if visible && selected == "all" {
							records = append(records, pending, want)
						}
						if page.Status != selected || page.Total != int64(len(records)) || !reflect.DeepEqual(page.Records, records) {
							t.Error("selected status participant list/count mismatch")
						}
						if visible && selected == status {
							detail, err := s.Get(ctx, actor(participant), original.ID)
							if err != nil || !reflect.DeepEqual(detail, page.Records[0]) {
								t.Fatal("list and detail disagree")
							}
						}
					}
				}
				in.Items[0], in.Items[1] = in.Items[1], in.Items[0]
				replay, err := s.Create(ctx, actor(2), in)
				if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Request, want) {
					t.Fatal("list and original creation replay disagree")
				}
				if outcomeSnapshot(t, ctx, p) != before {
					t.Fatal("list/detail/replay mutated complete persisted state")
				}
			})
		}
	}
}

func TestA04OutcomeListPagination(t *testing.T) {
	ctx, p, s := fixture(t)
	allWant := make([]transfers.Request, 0)
	if _, err := p.Exec(ctx, "UPDATE inventory_balances SET existing=1000 WHERE location_id=1 AND variant_id IN(1,2)"); err != nil {
		t.Fatal("owned pagination stock setup failed")
	}
	for _, status := range []string{"approved", "rejected"} {
		want := make([]transfers.Request, 51)
		for i := range want {
			in := input()
			in.RetryKey = fmt.Sprintf("a04-%s-page-key-%03d", status, i)
			original := create(t, ctx, s, 2, in).Request
			var err error
			if status == "approved" {
				want[50-i], err = s.Approve(ctx, actor(1), original.ID)
			} else {
				want[50-i], err = s.Reject(ctx, actor(1), original.ID)
			}
			if err != nil {
				t.Fatal("terminal pagination setup failed")
			}
		}
		allWant = append(want, allWant...)
		before := outcomeSnapshot(t, ctx, p)
		for _, tc := range []struct {
			page              int64
			size, first, last int
		}{{1, 10, 0, 10}, {2, 25, 25, 50}, {2, 50, 50, 51}, {1_000_000, 50, 51, 51}} {
			got, err := s.List(ctx, actor(1), transfers.Query{Page: tc.page, PageSize: tc.size, Status: status})
			if err != nil {
				t.Errorf("terminal paginated list rejected: %v", err)
				continue
			}
			if got.Status != status || got.Total != 51 || got.Page != tc.page || got.PageSize != tc.size || !reflect.DeepEqual(got.Records, want[tc.first:tc.last]) {
				t.Error("terminal total/order/complete page incorrect")
			}
			private, err := s.List(ctx, actor(3), transfers.Query{Page: tc.page, PageSize: tc.size, Status: status})
			if err != nil || private.Total != 0 || private.Records == nil || len(private.Records) != 0 {
				t.Error("terminal list exposed private count")
			}
		}
		for _, pageNumber := range []int64{1, 2, 3, 1_000_000} {
			for _, participant := range []int{1, 2, 3} {
				got, err := s.List(ctx, actor(participant), transfers.Query{Page: pageNumber, PageSize: 50, Status: "all"})
				visible := allWant
				if participant == 3 {
					visible = []transfers.Request{}
				}
				first := min(int((pageNumber-1)*50), len(visible))
				last := min(first+50, len(visible))
				if err != nil || got.Status != "all" || got.Total != int64(len(visible)) || !reflect.DeepEqual(got.Records, visible[first:last]) {
					t.Fatal("all pagination exposed private records or changed count/order")
				}
			}
		}
		if outcomeSnapshot(t, ctx, p) != before {
			t.Fatal("paginated reads changed persisted state")
		}
	}
}

func TestA04OutcomeListSnapshot(t *testing.T) {
	for _, status := range []string{"approved", "rejected"} {
		t.Run(status, func(t *testing.T) {
			ctx, p, s := fixture(t)
			first := create(t, ctx, s, 2, input()).Request
			var want transfers.Request
			var err error
			if status == "approved" {
				want, err = s.Approve(ctx, actor(1), first.ID)
			} else {
				want, err = s.Reject(ctx, actor(1), first.ID)
			}
			if err != nil {
				t.Fatal("terminal snapshot setup failed")
			}
			if _, err := s.List(ctx, actor(1), transfers.Query{Status: status}); err != nil {
				t.Fatal("terminal status must be admitted before snapshot test")
			}
			trace := &listSnapshotTrace{counted: make(chan struct{}), resume: make(chan struct{})}
			cfg := p.Config().Copy()
			cfg.ConnConfig.Tracer = trace
			pids := make(chan uint32, 1)
			cfg.AfterConnect = func(_ context.Context, conn *pgx.Conn) error {
				pids <- conn.PgConn().PID()
				return nil
			}
			traced, err := pgxpool.NewWithConfig(ctx, cfg)
			if err != nil {
				t.Fatal("terminal snapshot pool failed")
			}
			defer traced.Close()
			readctx, cancel := context.WithCancel(ctx)
			defer cancel()
			type result struct {
				page transfers.Page
				err  error
			}
			done := make(chan result, 1)
			go func() {
				page, err := transfers.New(traced).List(readctx, actor(1), transfers.Query{Status: status})
				done <- result{page, err}
			}()
			joined := false
			defer func() {
				cancel()
				if !joined {
					<-done
				}
			}()
			select {
			case <-trace.counted:
			case <-ctx.Done():
				t.Fatal("terminal count handshake missing")
			}
			var waiting bool
			if p.QueryRow(ctx, "SELECT state='idle in transaction' AND wait_event_type='Client' AND wait_event='ClientRead' FROM pg_stat_activity WHERE pid=$1", <-pids).Scan(&waiting) != nil || !waiting {
				t.Fatal("terminal list backend did not retain its open snapshot")
			}
			in := input()
			in.RetryKey = "a04-snapshot-second-key"
			second := create(t, ctx, s, 2, in).Request
			var secondOutcome transfers.Request
			if status == "approved" {
				secondOutcome, err = s.Approve(ctx, actor(1), second.ID)
			} else {
				secondOutcome, err = s.Reject(ctx, actor(1), second.ID)
			}
			if err != nil {
				t.Fatal("interleaved terminal writer failed")
			}
			before := outcomeSnapshot(t, ctx, p)
			close(trace.resume)
			got := <-done
			joined = true
			if got.err != nil || got.page.Total != 1 || !reflect.DeepEqual(got.page.Records, []transfers.Request{want}) {
				t.Fatal("terminal count/IDs/load mixed snapshots")
			}
			fresh, err := s.List(ctx, actor(1), transfers.Query{Status: status})
			if err != nil || fresh.Total != 2 || !reflect.DeepEqual(fresh.Records, []transfers.Request{secondOutcome, want}) {
				t.Fatal("fresh terminal snapshot missed commit")
			}
			trace.mu.Lock()
			rr := trace.readonlyRepeatable
			trace.mu.Unlock()
			if !rr || outcomeSnapshot(t, ctx, p) != before {
				t.Fatal("terminal snapshot mode/state incorrect")
			}
		})
	}
}
