package transfers_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

type w01CreateReply struct {
	result transfers.CreateResult
	err    error
}

func w01Start(ctx context.Context, s *transfers.Store, in transfers.CreateInput) <-chan w01CreateReply {
	done := make(chan w01CreateReply, 1)
	go func() { r, err := s.Create(ctx, actor(1), in); done <- w01CreateReply{r, err} }()
	return done
}

func w01Receive(t *testing.T, ctx context.Context, done <-chan w01CreateReply) w01CreateReply {
	t.Helper()
	select {
	case reply := <-done:
		return reply
	case <-ctx.Done():
		t.Fatal("direct creation worker did not settle")
		return w01CreateReply{}
	}
}

func TestW01DirectShipmentConcurrency(t *testing.T) {
	for _, mode := range []string{"duplicate_key", "changed_key_payload", "direct_competitors", "direct_before_approval", "approval_before_direct"} {
		t.Run(mode, func(t *testing.T) {
			ctx, p, s := fixture(t)
			in := w01Input(2)
			in.Items = []transfers.Line{{VariantID: 2, Quantity: 13}, {VariantID: 1, Quantity: 10}}
			other := in
			other.Items = []transfers.Line{{VariantID: 1, Quantity: 10}, {VariantID: 2, Quantity: 13}}
			var pending transfers.Request
			if mode == "direct_before_approval" || mode == "approval_before_direct" {
				branch := in
				branch.Kind, branch.CounterpartyID = transfers.RequestStock, 1
				pending = create(t, ctx, s, 2, branch).Request
			}
			before := stocks(t, ctx, p)
			winner, gate, release := a02Gated(t, ctx, p, "ORDER BY b.variant_id FOR UPDATE OF b", true)
			loser, waiting, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
			if mode == "direct_competitors" {
				other.RetryKey = "w01-competing-direct-02"
				other.CounterpartyID = 3
			}
			if mode == "changed_key_payload" {
				other.Items[0].Quantity++
			}
			var firstApproval, secondApproval <-chan a02Reply
			var firstDirect, secondDirect <-chan w01CreateReply
			if mode == "approval_before_direct" {
				firstApproval = a02Start(ctx, winner, pending.ID)
			} else {
				firstDirect = w01Start(ctx, winner, in)
			}
			a02Arrived(t, ctx, gate)
			if mode == "direct_before_approval" {
				secondApproval = a02Start(ctx, loser, pending.ID)
			} else {
				secondDirect = w01Start(ctx, loser, other)
			}
			a01Wait(t, ctx, p, a02Arrived(t, ctx, waiting), "advisory")
			release()
			var won transfers.Request
			if firstApproval != nil {
				r := a02Receive(t, ctx, firstApproval)
				if r.err != nil {
					t.Fatal("winning approval failed")
				}
				won = r.request
			} else {
				r := w01Receive(t, ctx, firstDirect)
				if r.err != nil || r.result.Replayed {
					t.Fatal("winning direct creation failed")
				}
				won = r.result.Request
			}
			if secondApproval != nil {
				r := a02Receive(t, ctx, secondApproval)
				a02Error(t, r.request, r.err, transfers.ErrInsufficientStock)
			} else {
				r := w01Receive(t, ctx, secondDirect)
				if mode == "duplicate_key" {
					if r.err != nil || !r.result.Replayed || !reflect.DeepEqual(r.result.Request, won) {
						t.Fatal("same-key creation did not replay the winner")
					}
				} else {
					want := transfers.ErrInsufficientStock
					if mode == "changed_key_payload" {
						want = transfers.ErrRetryConflict
					}
					if !errors.Is(r.err, want) || !reflect.DeepEqual(r.result, transfers.CreateResult{}) {
						t.Fatal("competing creation returned wrong failure or partial record")
					}
				}
			}
			for i := range before {
				for _, item := range won.Items {
					if before[i].Location == 1 && int64(before[i].Variant) == item.VariantID {
						before[i].Reserved += item.Quantity
						before[i].Available -= item.Quantity
					}
				}
			}
			if !reflect.DeepEqual(before, stocks(t, ctx, p)) || scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations") != 2 || scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests WHERE status='approved'") != 1 {
				t.Fatal("serialized consumers oversubscribed stock or duplicated owned reservations")
			}
			if mode == "direct_before_approval" {
				got, err := s.Get(ctx, actor(2), pending.ID)
				if err != nil || !reflect.DeepEqual(got, pending) {
					t.Fatal("losing approval changed Pending branch history")
				}
			}
		})
	}
}

func TestW01DirectShipmentContextWait(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		name := "cancelled"
		if deadline {
			name = "deadline"
		}
		t.Run(name, func(t *testing.T) {
			ctx, p, _ := fixture(t)
			before := receiptSnapshot(t, ctx, p)
			block := a01Begin(t, ctx, p)
			a01Exec(t, ctx, block, "SELECT pg_advisory_xact_lock(714025,1)")
			store, gate, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
			var operation context.Context
			var cancel context.CancelFunc
			if deadline {
				operation, cancel = context.WithTimeout(ctx, 7*time.Second)
			} else {
				operation, cancel = context.WithCancel(ctx)
			}
			done := w01Start(operation, store, w01Input(2))
			read := false
			t.Cleanup(func() {
				cancel()
				cleanup, finish := context.WithTimeout(context.Background(), 5*time.Second)
				defer finish()
				_ = block.Rollback(cleanup)
				if !read {
					<-done
				}
			})
			a01Wait(t, ctx, p, a02Arrived(t, ctx, gate), "advisory")
			if operation.Err() != nil {
				t.Fatal("operation expired before actual lock wait")
			}
			want := context.DeadlineExceeded
			if !deadline {
				cancel()
				want = context.Canceled
			}
			r := w01Receive(t, ctx, done)
			read = true
			if !errors.Is(r.err, want) || !reflect.DeepEqual(r.result, transfers.CreateResult{}) || receiptSnapshot(t, ctx, p) != before {
				t.Fatal("blocked creation lost context error or left writes")
			}
			if block.Rollback(ctx) != nil {
				t.Fatal("direct wait blocker rollback failed")
			}
		})
	}
}
