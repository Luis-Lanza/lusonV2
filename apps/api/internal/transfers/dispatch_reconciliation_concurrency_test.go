package transfers_test

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

func TestDR1Concurrency(t *testing.T) {
	for _, mode := range []string{"count", "restitution", "reservation", "exact_replay"} {
		t.Run(mode, func(t *testing.T) {
			actual := int64(7)
			if mode == "restitution" {
				actual = 4
			}
			ctx, p, r := r2Receipt(t, 5, actual)
			dr1Do(t, ctx, p, r, 1, "dr1-race-propose", "propose", 0, actual)
			before := dr1Snapshot(t, ctx, p, r)
			stock := dr1Inventory(t, ctx, p)
			holder := a01Begin(t, ctx, p)
			switch mode {
			case "count":
				a01Exec(t, ctx, holder, c2Call, r.ID, 1, 1, "dr1-race-count-propose", "propose", 0, 8, "verified")
			case "restitution":
				a01Exec(t, ctx, holder, r2Call, r.ID, 1, 1, "dr1-race-rest-propose", "propose", 0, 1, true, "verified")
			case "reservation":
				a01Exec(t, ctx, holder, `UPDATE inventory_balances SET reserved=existing WHERE location_id=1 AND variant_id=1`)
			case "exact_replay":
				a01Exec(t, ctx, holder, dr1Call, r.ID, 1, 2, "dr1-race-accept", "accept", 1, nil, "verified")
			}
			if before != dr1Snapshot(t, ctx, p, r) {
				t.Fatal("uncommitted holder effects visible through Store")
			}
			waiter := a01Begin(t, ctx, p)
			work, cancel := context.WithCancel(ctx)
			done := make(chan error, 1)
			joined := make(chan struct{})
			t.Cleanup(func() { cancel(); <-joined })
			go func() {
				defer close(joined)
				_, err := waiter.Exec(work, dr1Call, r.ID, 1, 2, "dr1-race-accept", "accept", 1, nil, "verified")
				done <- err
			}()
			r3bWaitLock(t, ctx, p, holder.Conn().PgConn().PID(), waiter.Conn().PgConn().PID())
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var err error
			select {
			case err = <-done:
			case <-ctx.Done():
				t.Fatal("queued reconciliation did not settle")
			}
			if mode == "exact_replay" {
				if err != nil || waiter.Commit(ctx) != nil {
					t.Fatal("serialized exact replay failed", err)
				}
				stock[0].Items[0].Existing -= 2
				stock[0].Items[0].Available -= 2
				stock[4].Items[0].Existing += 2
				stock[4].Items[0].Available += 2
				if scalar(t, ctx, p, `SELECT count(*) FROM transfer_dispatch_operations`) != 2 || scalar(t, ctx, p, `SELECT count(*) FROM transfer_dispatch_applications`) != 1 {
					t.Fatal("race duplicated acceptance")
				}
			} else {
				if !sqlState(err, "23514") {
					t.Fatal("queued reconciliation ignored changed predecessor or reservation", err)
				}
				_ = waiter.Rollback(ctx)
				if scalar(t, ctx, p, `SELECT count(*) FROM transfer_dispatch_operations`) != 1 {
					t.Fatal("refused race persisted acceptance")
				}
				if mode == "reservation" {
					stock[0].Items[0].Reserved = stock[0].Items[0].Existing
					stock[0].Items[0].Available = 0
				}
			}
			if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
				t.Fatal("race violated public stock conservation")
			}
			settled := dr1Snapshot(t, ctx, p, r)
			if mode == "exact_replay" {
				// This helper uses a different reason, so reuse is a conflict.
				dr1Refuse(t, ctx, p, r, "23505", dr1Call, r.ID, 1, 2, "dr1-race-accept", "accept", 1, nil, "changed")
			} else {
				dr1Refuse(t, ctx, p, r, "23514", dr1Call, r.ID, 1, 2, "dr1-race-accept", "accept", 1, nil, "verified")
			}
			if settled != dr1Snapshot(t, ctx, p, r) {
				t.Fatal("race retry changed settled public state or counters")
			}
		})
	}
}

func TestDR1AllocationCoverage(t *testing.T) {
	for _, location := range []int{1, 2} {
		t.Run(fmt.Sprint(location), func(t *testing.T) {
			ctx, p, r := r2Receipt(t, 5, 7)
			s := transfers.New(p)
			in := input()
			who := 2
			if location == 2 {
				in.Kind = transfers.SendToWarehouse
			}
			in.Items = []transfers.Line{{VariantID: 1, Quantity: 1}}
			in.RetryKey = "dr1-released-reservation"
			released := create(t, ctx, s, who, in).Request
			if _, err := s.Approve(ctx, actor(released.Approver.ID), released.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Cancel(ctx, actor(released.Creator.ID), released.ID); err != nil {
				t.Fatal(err)
			}
			in.RetryKey = "dr1-active-reservation"
			live := create(t, ctx, s, who, in).Request
			if _, err := s.Approve(ctx, actor(live.Approver.ID), live.ID); err != nil {
				t.Fatal(err)
			}
			original := r2Original(t, ctx, p)
			dr1Do(t, ctx, p, r, 1, "dr1-covered-propose", "propose", 0, 7)
			before := dr1Snapshot(t, ctx, p, r)
			tx := a01Begin(t, ctx, p)
			a01Exec(t, ctx, tx, `UPDATE inventory_balances SET reserved=0 WHERE location_id=$1 AND variant_id=1`, location)
			if _, err := tx.Exec(ctx, dr1Call, r.ID, 1, 2, "dr1-uncovered-accept", "accept", 1, nil, "verified"); !sqlState(err, "23514") {
				t.Fatal("active allocation not checked before application", err)
			}
			_ = tx.Rollback(ctx)
			if before != dr1Snapshot(t, ctx, p, r) {
				t.Fatal("coverage failure leaked effects")
			}
			stock := dr1Inventory(t, ctx, p)
			dr1Do(t, ctx, p, r, 2, "dr1-covered-accept", "accept", 1, nil)
			stock[0].Items[0].Existing -= 2
			stock[0].Items[0].Available -= 2
			stock[4].Items[0].Existing += 2
			stock[4].Items[0].Available += 2
			if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || original != r2Original(t, ctx, p) {
				t.Fatal("reconciliation changed allocations, reservations or original evidence")
			}
		})
	}
}

func TestDR1Notifications(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 7)
	listener, err := p.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Release()
	if _, err := listener.Exec(ctx, "LISTEN luson_realtime"); err != nil {
		t.Fatal(err)
	}
	dr1Do(t, ctx, p, r, 1, "dr1-notify-proposal", "propose", 0, 7)
	dr1Do(t, ctx, p, r, 2, "dr1-notify-reject", "reject", 1, nil)
	hints := map[string]int{}
	for i := 0; i < 4; i++ {
		wait, cancel := context.WithTimeout(ctx, time.Second)
		n, err := listener.Conn().WaitForNotification(wait)
		cancel()
		if err != nil {
			t.Fatal("missing committed participant hint")
		}
		hints[n.Payload]++
	}
	if hints["transfers:1"] != 2 || hints["transfers:2"] != 2 || len(hints) != 2 {
		t.Fatal("private participant hint audience", hints)
	}
	dr1Do(t, ctx, p, r, 2, "dr1-notify-reject", "reject", 1, nil)
	tx := a01Begin(t, ctx, p)
	a01Exec(t, ctx, tx, dr1Call, r.ID, 1, 1, "dr1-notify-rollback", "propose", 1, 7, "verified")
	_ = tx.Rollback(ctx)
	wait, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if n, err := listener.Conn().WaitForNotification(wait); err == nil || n != nil {
		t.Fatal("replay or rollback emitted mutation hint")
	}
}
