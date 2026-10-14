package transfers_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

func TestR1ReceiptConcurrency(t *testing.T) {
	for _, competing := range []string{"identical", "changed", "approve", "dispatch", "reject", "overlapping_receipt"} {
		t.Run(competing, func(t *testing.T) {
			ctx, p, s := fixture(t)
			first := receiptDispatch(t, ctx, s, input())
			second := first
			if competing == "overlapping_receipt" {
				in := input()
				in.RetryKey = "receipt-overlap-key-002"
				second = receiptDispatch(t, ctx, s, in)
			}
			stock := stocks(t, ctx, p)
			winner, gate, release := a02Gated(t, ctx, p, "UPDATE transfer_requests SET status='received'", true)
			loser, waiting, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
			one, two := make(chan a02Reply, 1), make(chan a02Reply, 1)
			go func() {
				r, err := winner.Receive(ctx, actor(2), first.ID, receiptInput(first))
				one <- a02Reply{r, err}
			}()
			a02Arrived(t, ctx, gate)
			go func() {
				var r transfers.Request
				var err error
				switch competing {
				case "approve":
					r, err = loser.Approve(ctx, actor(1), first.ID)
				case "dispatch":
					r, err = loser.Dispatch(ctx, actor(1), first.ID)
				case "reject":
					r, err = loser.Reject(ctx, actor(1), first.ID)
				default:
					payload := receiptInput(second)
					if competing == "changed" {
						payload.Items[0].Quantity++
					}
					r, err = loser.Receive(ctx, actor(2), second.ID, payload)
				}
				two <- a02Reply{r, err}
			}()
			pid := a02Arrived(t, ctx, waiting)
			a01Wait(t, ctx, p, pid, "advisory")
			release()
			a, b := a02Receive(t, ctx, one), a02Receive(t, ctx, two)
			if a.err != nil || a.request.Status != "received" {
				t.Fatal("first receipt failed", a.err)
			}
			switch competing {
			case "changed":
				a02Error(t, b.request, b.err, transfers.ErrRetryConflict)
			case "reject":
				a02Error(t, b.request, b.err, transfers.ErrDecisionConflict)
			case "overlapping_receipt":
				if b.err != nil || b.request.Status != "received" {
					t.Fatal("overlapping receipt failed", b.err)
				}
			default:
				if b.err != nil || !reflect.DeepEqual(a.request, b.request) {
					t.Fatal("concurrent same-result recovery changed persisted outcome", b.err)
				}
			}
			for i := range stock {
				for _, item := range first.Items {
					if stock[i].Location == 2 && int64(stock[i].Variant) == item.VariantID {
						credit := item.Quantity
						if competing == "overlapping_receipt" {
							credit *= 2
						}
						stock[i].Existing += credit
						stock[i].Available += credit
					}
				}
			}
			if !reflect.DeepEqual(stock, stocks(t, ctx, p)) {
				t.Fatal("concurrent receipt credited twice or lost an overlapping credit")
			}
		})
	}
}

func TestR1ReceiptCancellation(t *testing.T) {
	for _, mode := range []string{"waiting_advisory", "waiting_balance", "after_transition"} {
		t.Run(mode, func(t *testing.T) {
			ctx, p, s := fixture(t)
			r := receiptDispatch(t, ctx, s, input())
			before := receiptSnapshot(t, ctx, p)
			match, end, event := "pg_advisory_xact_lock(714025,1)", false, "advisory"
			if mode == "waiting_balance" {
				match, event = "ORDER BY variant_id FOR UPDATE", "transactionid"
			}
			if mode == "after_transition" {
				match, end = "UPDATE transfer_requests SET status='received'", true
			}
			traced, arrived, release := a02Gated(t, ctx, p, match, end)
			tx := a01Begin(t, ctx, p)
			defer tx.Rollback(context.Background())
			if mode == "waiting_advisory" {
				a01Exec(t, ctx, tx, "SELECT pg_advisory_xact_lock(714025,1)")
			}
			if mode == "waiting_balance" {
				a01Exec(t, ctx, tx, "SELECT variant_id FROM inventory_balances WHERE location_id=2 AND variant_id=2 FOR UPDATE")
			}
			canceled, cancel := context.WithCancel(ctx)
			defer cancel()
			done := make(chan a02Reply, 1)
			go func() {
				got, err := traced.Receive(canceled, actor(2), r.ID, receiptInput(r))
				done <- a02Reply{got, err}
			}()
			pid := a02Arrived(t, ctx, arrived)
			if mode != "after_transition" {
				a01Wait(t, ctx, p, pid, event)
			}
			cancel()
			release()
			reply := a02Receive(t, ctx, done)
			if !errors.Is(reply.err, context.Canceled) || !reflect.DeepEqual(reply.request, transfers.Request{}) {
				t.Fatal("active cancellation returned a successful/partial result", reply.err)
			}
			_ = tx.Rollback(ctx)
			if receiptSnapshot(t, ctx, p) != before {
				t.Fatal("active cancellation leaked receipt effects")
			}
		})
	}
}
