package transfers_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

type c2Reply struct {
	operation transfers.CountOperation
	err       error
}
type c2Action struct {
	propose, accept  bool
	who              int
	revision, actual int64
	key              string
}

func c2Start(t *testing.T, ctx context.Context, s *transfers.Store, r transfers.Request, a c2Action) <-chan c2Reply {
	t.Helper()
	work, cancel := context.WithCancel(ctx)
	done := make(chan c2Reply, 1)
	joined := make(chan struct{})
	t.Cleanup(func() { cancel(); <-joined })
	go func() {
		defer close(joined)
		var op transfers.CountOperation
		var err error
		if a.propose {
			op, err = s.ProposeCount(work, actor(a.who), r.ID, transfers.CountProposalInput{VariantID: 1, OperationKey: a.key, ExpectedRevision: a.revision, Actual: a.actual, Reason: "count verified"})
		} else {
			op, err = s.DecideCount(work, actor(a.who), r.ID, transfers.CountDecisionInput{VariantID: 1, OperationKey: a.key, ExpectedRevision: a.revision, Accept: a.accept, Reason: "count confirmed"})
		}
		done <- c2Reply{op, err}
	}()
	return done
}
func c2Receive(t *testing.T, ctx context.Context, done <-chan c2Reply) c2Reply {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-ctx.Done():
		t.Fatal("correction worker did not settle")
		return c2Reply{}
	}
}

func TestC2CorrectionConcurrencyWorkflow(t *testing.T) {
	for _, name := range []string{"duplicate_proposal", "competing_proposals", "duplicate_accept", "accept_before_reject", "reject_before_accept", "replacement_before_accept", "accept_before_replacement", "replacement_before_stale_replacement"} {
		t.Run(name, func(t *testing.T) {
			ctx, p, r := c2BranchReceipt(t)
			s := transfers.New(p)
			first := c2Action{propose: true, who: r.Origin.ID, actual: 2, key: "concurrent-proposal-01"}
			second := first
			wantSecond := error(nil)
			operations := 1
			if name == "competing_proposals" {
				second.key = "concurrent-proposal-02"
				wantSecond = transfers.ErrDecisionConflict
			}
			if name != "duplicate_proposal" && name != "competing_proposals" {
				c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 0, 2, "concurrent-initial-01")
				first = c2Action{accept: true, who: r.Destination.ID, revision: 1, key: "concurrent-decision-01"}
				second = first
				operations = 2
				switch name {
				case "accept_before_reject":
					second.accept = false
					second.key = "concurrent-decision-02"
					wantSecond = transfers.ErrDecisionConflict
				case "reject_before_accept":
					first.accept = false
					second.key = "concurrent-decision-02"
					wantSecond = transfers.ErrDecisionConflict
				case "replacement_before_accept":
					first = c2Action{propose: true, who: r.Origin.ID, revision: 1, actual: 0, key: "concurrent-replace-01"}
					wantSecond = transfers.ErrDecisionConflict
				case "accept_before_replacement":
					second = c2Action{propose: true, who: r.Origin.ID, revision: 1, actual: 0, key: "concurrent-replace-01"}
					operations = 3
				case "replacement_before_stale_replacement":
					first = c2Action{propose: true, who: r.Origin.ID, revision: 1, actual: 0, key: "concurrent-replace-01"}
					second = first
					second.key = "concurrent-replace-02"
					wantSecond = transfers.ErrDecisionConflict
				}
			}
			before := c2StoreRead(t, ctx, s, r)
			winner, gate, release := a02Gated(t, ctx, p, "FROM transfer_count_correct", true)
			loser, waiting, _ := a02Gated(t, ctx, p, "FROM transfer_count_correct", false)
			one := c2Start(t, ctx, winner, r, first)
			a02Arrived(t, ctx, gate)
			// Readers see only the fully committed old generation, even while
			// the writer has completed effects and holds locks before commit.
			if got := c2StoreRead(t, ctx, s, r); !reflect.DeepEqual(got, before) {
				t.Fatal("uncommitted/mixed snapshot")
			}
			two := c2Start(t, ctx, loser, r, second)
			a01Wait(t, ctx, p, a02Arrived(t, ctx, waiting), "advisory")
			release()
			a, b := c2Receive(t, ctx, one), c2Receive(t, ctx, two)
			if a.err != nil || !errors.Is(b.err, wantSecond) {
				t.Fatal("serialized outcome", a.err, b.err, wantSecond)
			}
			if name == "duplicate_proposal" || name == "duplicate_accept" {
				if !reflect.DeepEqual(a.operation, b.operation) {
					t.Fatal("duplicate identity changed")
				}
			}
			out := c2StoreRead(t, ctx, s, r)
			if len(out.Operations) != operations {
				t.Fatal("duplicate or missing operations", out)
			}
			line := out.Lines[0]
			switch name {
			case "duplicate_accept", "accept_before_reject":
				if line.EffectiveCredit != 2 || line.Proposals[0].State != "applied" {
					t.Fatal("accept lost")
				}
			case "reject_before_accept":
				if line.EffectiveCredit != 1 || line.Proposals[0].State != "rejected" {
					t.Fatal("reject applied")
				}
			case "replacement_before_accept", "replacement_before_stale_replacement":
				if line.WorkflowRevision != 2 || line.AppliedRevision != 0 || line.Proposals[0].State != "superseded" {
					t.Fatal("replacement carried consent")
				}
			case "accept_before_replacement":
				if line.WorkflowRevision != 2 || line.AppliedRevision != 1 || line.EffectiveCredit != 2 || line.Proposals[1].BaseCredit != 2 || line.Proposals[1].State != "pending" {
					t.Fatal("independent applied predecessor")
				}
			}
		})
	}
}

func TestC2CorrectionConcurrencyCancellation(t *testing.T) {
	for _, stage := range []string{"waiting", "after_effect"} {
		t.Run(stage, func(t *testing.T) {
			ctx, p, r := c2Receipt(t, false)
			s := transfers.New(p)
			c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 0, 2, "cancel-initial-01")
			before := c2Snapshot(t, ctx, p)
			work, cancel := context.WithCancel(ctx)
			defer cancel()
			gated, gate, release := a02Gated(t, ctx, p, "FROM transfer_count_correct", stage == "after_effect")
			var unblock func()
			if stage == "waiting" {
				block := a01Begin(t, ctx, p)
				a01Exec(t, ctx, block, "SELECT pg_advisory_xact_lock(714025,1)")
				unblock = func() {
					cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
					defer done()
					_ = block.Rollback(cleanup)
				}
				defer unblock()
			}
			action := c2Action{accept: true, who: r.Destination.ID, revision: 1, key: "cancel-decision-01"}
			done := c2Start(t, work, gated, r, action)
			pid := a02Arrived(t, ctx, gate)
			if stage == "waiting" {
				a01Wait(t, ctx, p, pid, "advisory")
			}
			cancel()
			result := c2Receive(t, ctx, done)
			if !errors.Is(result.err, context.Canceled) || !reflect.DeepEqual(result.operation, transfers.CountOperation{}) {
				t.Fatal("cancellation result", result.err)
			}
			release()
			if unblock != nil {
				unblock()
			}
			if c2Snapshot(t, ctx, p) != before {
				t.Fatal("cancellation left partial effects")
			}
			// Success on exactly the same identity proves both transaction/lock
			// release and absence of a partially persisted retry operation.
			c2StoreDecide(t, ctx, s, r, r.Destination.ID, 1, 1, true, action.key)
			c2Credit(t, ctx, p, 1, 1, 2, 1)
		})
	}
}

func TestC2CorrectionConcurrencyReservation(t *testing.T) {
	for _, reservationFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "reservation_first", false: "correction_first"}[reservationFirst], func(t *testing.T) {
			ctx, p, r := c2Receipt(t, false)
			s := transfers.New(p)
			var stock int64
			if err := p.QueryRow(ctx, `SELECT existing FROM inventory_balances WHERE location_id=$1 AND variant_id=1`, r.Destination.ID).Scan(&stock); err != nil {
				t.Fatal(err)
			}
			in := input()
			in.Kind = transfers.SendToWarehouse
			in.RetryKey = "reservation-race-01"
			in.Items = []transfers.Line{{VariantID: 1, Quantity: stock}}
			outgoing := create(t, ctx, s, r.Destination.ID, in).Request
			c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 0, 0, "reservation-count-01")
			approve, ag, ar := a02Gated(t, ctx, p, "INSERT INTO transfer_request_allocations", reservationFirst)
			correct, cg, cr := a02Gated(t, ctx, p, "FROM transfer_count_correct", !reservationFirst)
			approvalCtx, cancel := context.WithCancel(ctx)
			defer cancel()
			approvalDone := make(chan error, 1)
			joined := make(chan struct{})
			started := false
			t.Cleanup(func() {
				cancel()
				if started {
					<-joined
				}
			})
			startApproval := func() {
				started = true
				go func() {
					defer close(joined)
					_, err := approve.Approve(approvalCtx, actor(outgoing.Approver.ID), outgoing.ID)
					approvalDone <- err
				}()
			}
			action := c2Action{accept: true, who: r.Destination.ID, revision: 1, key: "reservation-decision-01"}
			var done <-chan c2Reply
			if reservationFirst {
				startApproval()
				a02Arrived(t, ctx, ag)
				done = c2Start(t, ctx, correct, r, action)
				a01Wait(t, ctx, p, a02Arrived(t, ctx, cg), "advisory")
				ar()
			} else {
				done = c2Start(t, ctx, correct, r, action)
				a02Arrived(t, ctx, cg)
				// Approval must be observed at its shared advisory lock, not the
				// later allocation insert it cannot reach until correction commits.
				approve, ag, _ = a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
				startApproval()
				a01Wait(t, ctx, p, a02Arrived(t, ctx, ag), "advisory")
				cr()
			}
			correction := c2Receive(t, ctx, done)
			var approvalErr error
			select {
			case approvalErr = <-approvalDone:
			case <-ctx.Done():
				t.Fatal("reservation worker did not settle")
			}
			if reservationFirst {
				if approvalErr != nil || !errors.Is(correction.err, transfers.ErrInsufficientStock) {
					t.Fatal("reservation coverage race", approvalErr, correction.err)
				}
			} else if correction.err != nil || !errors.Is(approvalErr, transfers.ErrInsufficientStock) {
				t.Fatal("correction stock race", approvalErr, correction.err)
			}
			line := c2StoreRead(t, ctx, s, r).Lines[0]
			if reservationFirst && (line.AppliedRevision != 0 || line.EffectiveCredit != 1) || !reservationFirst && (line.AppliedRevision != 1 || line.EffectiveCredit != 0) {
				t.Fatal("reservation race partial effect")
			}
		})
	}
}
