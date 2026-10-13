package transfers_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/transfers"
)

// Both PIDs come from connection-local tracer handshakes, not activity guesses.
// Match the two-int advisory tag and its database as well as the blocker graph.
func r3bWaitLock(t *testing.T, ctx context.Context, p *pgxpool.Pool, holder, waiter uint32) {
	t.Helper()
	if holder == waiter {
		t.Fatal("race reused holder backend")
	}
	observe, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		var blocked bool
		err := p.QueryRow(observe, `SELECT EXISTS (
   SELECT 1 FROM pg_locks w JOIN pg_locks h
   ON h.locktype=w.locktype AND h.database=w.database
   AND h.classid=w.classid AND h.objid=w.objid AND h.objsubid=w.objsubid
   JOIN pg_stat_activity a ON a.pid=w.pid
   WHERE w.locktype='advisory' AND w.classid=714025 AND w.objid=1 AND w.objsubid=2
   AND w.database=(SELECT oid FROM pg_database WHERE datname=current_database())
   AND w.pid=$1 AND NOT w.granted AND h.pid=$2 AND h.granted
   AND h.mode='ExclusiveLock' AND w.mode='ExclusiveLock'
   AND $2=ANY(pg_blocking_pids(w.pid)) AND a.wait_event_type='Lock'
   AND a.wait_event='advisory')`, int64(waiter), int64(holder)).Scan(&blocked)
		if err != nil {
			t.Fatal("advisory blocker observation failed")
		}
		if blocked {
			t.Log("observed exact advisory tag, granted holder, ungranted waiter and blocker edge")
			return
		}
		select {
		case <-tick.C:
		case <-observe.Done():
			t.Fatal("exact advisory blocker never observed")
		}
	}
}

type r3bReply struct {
	operation transfers.RestitutionOperation
	err       error
}
type r3bAction struct {
	propose, accept bool
	key             string
}

func r3bCall(ctx context.Context, s *transfers.Store, r transfers.Request, a r3bAction) r3bReply {
	if a.propose {
		op, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal(a.key, 1, 1))
		return r3bReply{op, err}
	}
	op, err := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision(a.key, 1, a.accept))
	return r3bReply{op, err}
}
func r3bStart(t *testing.T, ctx context.Context, call func(context.Context) r3bReply) <-chan r3bReply {
	t.Helper()
	work, cancel := context.WithCancel(ctx)
	done := make(chan r3bReply, 1)
	joined := make(chan struct{})
	t.Cleanup(func() { cancel(); <-joined })
	go func() { defer close(joined); done <- call(work) }()
	return done
}
func r3bReceive(t *testing.T, ctx context.Context, done <-chan r3bReply) r3bReply {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-ctx.Done():
		t.Fatal("restitution worker did not settle")
		return r3bReply{}
	}
}
func r3bHistory(t *testing.T, ctx context.Context, s *transfers.Store, r transfers.Request) transfers.Restitutions {
	t.Helper()
	h, err := s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal("origin history", err)
	}
	other, err := s.GetRestitutions(ctx, actor(r.Destination.ID), r.ID)
	if err != nil || !reflect.DeepEqual(h, other) {
		t.Fatal("participant histories differ", err)
	}
	if _, err := s.GetRestitutions(ctx, actor(3), r.ID); !errors.Is(err, transfers.ErrNotFound) {
		t.Fatal("history privacy", err)
	}
	for i, op := range h.Operations {
		if op.RequestID != r.ID || op.RecordedAt.IsZero() {
			t.Fatal("invalid immutable operation")
		}
		if i > 0 && op.RecordedAt.Before(h.Operations[i-1].RecordedAt) {
			t.Fatal("unordered operations")
		}
	}
	for i, prop := range h.Lines[0].Proposals {
		if prop.Revision != int64(i+1) || prop.BaseRevision != int64(i) || prop.InitiatorLocationID != r.Origin.ID || !prop.RetainedAtOrigin || prop.BaseRestitution != 0 {
			t.Fatal("proposal consent pins")
		}
	}
	return h
}
func r3bEvidence(t *testing.T, ctx context.Context, p *pgxpool.Pool, operations, proposals, decisions, applications int) {
	t.Helper()
	var o, pr, d, a int
	err := p.QueryRow(ctx, `SELECT (SELECT count(*) FROM transfer_restitution_operations),
 (SELECT count(*) FROM transfer_restitution_proposals), (SELECT count(*) FROM transfer_restitution_decisions),
 (SELECT count(*) FROM transfer_restitution_applications)`).Scan(&o, &pr, &d, &a)
	if err != nil || o != operations || pr != proposals || d != decisions || a != applications {
		t.Fatal("append-only evidence counts", o, pr, d, a, err)
	}
}

func TestR3RestitutionConcurrencyDecisions(t *testing.T) {
	cases := []struct {
		name          string
		first, second r3bAction
		credit        int64
		state         string
		revision      int64
		conflict      bool
	}{
		{"same_key_accept_retry", r3bAction{accept: true, key: "r3b-accept-first"}, r3bAction{accept: true, key: "r3b-accept-first"}, 1, "applied", 1, false},
		{"different_key_duplicate_accept", r3bAction{accept: true, key: "r3b-accept-first"}, r3bAction{accept: true, key: "r3b-accept-second"}, 1, "applied", 1, true},
		{"replacement_before_accept", r3bAction{propose: true, key: "r3b-replacement-key"}, r3bAction{accept: true, key: "r3b-accept-second"}, 0, "superseded", 2, true},
		{"accept_before_replacement", r3bAction{accept: true, key: "r3b-accept-first"}, r3bAction{propose: true, key: "r3b-replacement-key"}, 1, "applied", 1, true},
		{"accept_before_reject", r3bAction{accept: true, key: "r3b-accept-first"}, r3bAction{key: "r3b-reject-second"}, 1, "applied", 1, true},
		{"reject_before_accept", r3bAction{key: "r3b-reject-first"}, r3bAction{accept: true, key: "r3b-accept-second"}, 0, "rejected", 1, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx, p, r := r2Receipt(t, 5, 4)
			s := transfers.New(p)
			original := r2Original(t, ctx, p)
			beforeStock := stocks(t, ctx, p)
			if _, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("r3b-initial-proposal", 0, 1)); err != nil {
				t.Fatal(err)
			}
			before := r2Snapshot(t, ctx, p)
			history := r3bHistory(t, ctx, s, r)
			inv := c2Revision(t, ctx, p, "inventory")
			origin := c2Revision(t, ctx, p, "transfers:1")
			dest := c2Revision(t, ctx, p, "transfers:2")
			other := c2Revision(t, ctx, p, "transfers:3")
			first, gate, release := a02Gated(t, ctx, p, "FROM transfer_restitute", true)
			second, waiting, _ := a02Gated(t, ctx, p, "FROM transfer_restitute", false)
			one := r3bStart(t, ctx, func(work context.Context) r3bReply { return r3bCall(work, first, r, tc.first) })
			holder := a02Arrived(t, ctx, gate)
			if before != r2Snapshot(t, ctx, p) || !reflect.DeepEqual(history, r3bHistory(t, ctx, s, r)) {
				t.Fatal("uncommitted effects visible")
			}
			two := r3bStart(t, ctx, func(work context.Context) r3bReply { return r3bCall(work, second, r, tc.second) })
			r3bWaitLock(t, ctx, p, holder, a02Arrived(t, ctx, waiting))
			release()
			a, b := r3bReceive(t, ctx, one), r3bReceive(t, ctx, two)
			if a.err != nil {
				t.Fatal("first transaction", a.err)
			}
			if tc.conflict {
				if !errors.Is(b.err, transfers.ErrDecisionConflict) || !reflect.DeepEqual(b.operation, transfers.RestitutionOperation{}) {
					t.Fatal("second must roll back", b.err)
				}
			} else if b.err != nil || !reflect.DeepEqual(a.operation, b.operation) {
				t.Fatal("retry changed persisted result", b.err)
			}
			h := r3bHistory(t, ctx, s, r)
			line := h.Lines[0]
			if line.WorkflowRevision != tc.revision || line.AppliedRetainedQuantity != tc.credit || line.AppliedRevision != tc.credit || line.EffectiveCredit != 4 || line.CountGeneration != 0 || line.CountAppliedRevision != 0 || line.Proposals[0].State != tc.state || len(h.Operations) != 2 {
				t.Fatal("serialized history outcome")
			}
			props, decisions := 1, 1
			if tc.first.propose {
				props, decisions = 2, 0
				if len(line.Proposals) != 2 || line.Proposals[1].State != "pending" || line.Proposals[1].BaseCredit != 4 {
					t.Fatal("replacement pins")
				}
			} else {
				prop := line.Proposals[0]
				if prop.Decision == nil || prop.Decision.Accepted != tc.first.accept || prop.Decision.ActorLocationID != r.Destination.ID {
					t.Fatal("decision evidence")
				}
			}
			r3bEvidence(t, ctx, p, 2, props, decisions, int(tc.credit))
			for i, row := range stocks(t, ctx, p) {
				want := beforeStock[i]
				if want.Location == r.Origin.ID && want.Variant == 1 {
					want.Existing += tc.credit
					want.Available += tc.credit
				}
				if row != want {
					t.Fatal("endpoint stock/reservation conservation")
				}
			}
			if tc.credit == 1 && (a.operation.SourceExistingBefore == nil || a.operation.SourceExistingAfter == nil || *a.operation.SourceExistingAfter-*a.operation.SourceExistingBefore != 1 || line.Proposals[0].Application == nil || line.Proposals[0].Application.Quantity != 1) {
				t.Fatal("persisted source credit")
			}
			if tc.credit == 0 && (a.operation.SourceExistingBefore != nil || a.operation.SourceExistingAfter != nil || line.Proposals[0].Application != nil) {
				t.Fatal("nonaccept credit")
			}
			if r2Original(t, ctx, p) != original || c2Revision(t, ctx, p, "inventory") != inv+tc.credit || c2Revision(t, ctx, p, "transfers:1") != origin+1 || c2Revision(t, ctx, p, "transfers:2") != dest+1 || c2Revision(t, ctx, p, "transfers:3") != other {
				t.Fatal("originals or invalidation effects")
			}
			// Replay the successful first operation after settlement. Full snapshots
			// include both workflows, stocks and invalidations: failure/retry add nothing.
			settled := r2Snapshot(t, ctx, p)
			again := r3bCall(ctx, s, r, tc.first)
			if again.err != nil || !reflect.DeepEqual(again.operation, a.operation) || settled != r2Snapshot(t, ctx, p) {
				t.Fatal("immutable first-operation replay")
			}
			if tc.conflict {
				again = r3bCall(ctx, s, r, tc.second)
				if !errors.Is(again.err, transfers.ErrDecisionConflict) || settled != r2Snapshot(t, ctx, p) {
					t.Fatal("failed operation rollback")
				}
			}
		})
	}
}

func TestR3RestitutionConcurrencyCount(t *testing.T) {
	for _, countFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "count_first", false: "restitution_first"}[countFirst], func(t *testing.T) {
			ctx, p, r := r2Receipt(t, 5, 4)
			s := transfers.New(p)
			original := r2Original(t, ctx, p)
			beforeStock := stocks(t, ctx, p)
			if _, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("r3b-count-rest-proposal", 0, 1)); err != nil {
				t.Fatal(err)
			}
			var countResult c2Reply
			var restResult r3bReply
			var countProposal transfers.CountOperation
			if countFirst {
				countProposal = c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, 3, "r3b-count-proposal")
			}
			before := r2Snapshot(t, ctx, p)
			inv := c2Revision(t, ctx, p, "inventory")
			origin := c2Revision(t, ctx, p, "transfers:1")
			dest := c2Revision(t, ctx, p, "transfers:2")
			other := c2Revision(t, ctx, p, "transfers:3")
			if countFirst {
				first, gate, release := a02Gated(t, ctx, p, "FROM transfer_count_correct", true)
				second, waiting, _ := a02Gated(t, ctx, p, "FROM transfer_restitute", false)
				one := c2Start(t, ctx, first, r, c2Action{accept: true, who: r.Origin.ID, revision: 1, key: "r3b-count-accept"})
				holder := a02Arrived(t, ctx, gate)
				if r2Snapshot(t, ctx, p) != before {
					t.Fatal("uncommitted count visible")
				}
				two := r3bStart(t, ctx, func(work context.Context) r3bReply {
					return r3bCall(work, second, r, r3bAction{accept: true, key: "r3b-count-rest-accept"})
				})
				r3bWaitLock(t, ctx, p, holder, a02Arrived(t, ctx, waiting))
				release()
				countResult, restResult = c2Receive(t, ctx, one), r3bReceive(t, ctx, two)
				if countResult.err != nil || !errors.Is(restResult.err, transfers.ErrDecisionConflict) || !reflect.DeepEqual(restResult.operation, transfers.RestitutionOperation{}) {
					t.Fatal("count-first predecessor conflict", countResult.err, restResult.err)
				}
			} else {
				// No pending count exists: it must queue its proposal behind restitution.
				first, gate, release := a02Gated(t, ctx, p, "FROM transfer_restitute", true)
				second, waiting, _ := a02Gated(t, ctx, p, "FROM transfer_count_correct", false)
				one := r3bStart(t, ctx, func(work context.Context) r3bReply {
					return r3bCall(work, first, r, r3bAction{accept: true, key: "r3b-count-rest-accept"})
				})
				holder := a02Arrived(t, ctx, gate)
				if r2Snapshot(t, ctx, p) != before {
					t.Fatal("uncommitted restitution visible")
				}
				// The chain reports errors through its channel; no testing calls occur
				// inside the worker. The snapshot brackets only the rejecting acceptance.
				type chainReply struct {
					proposal transfers.CountOperation
					err      error
				}
				work, cancel := context.WithCancel(ctx)
				defer cancel()
				done := make(chan chainReply, 1)
				joined := make(chan struct{})
				t.Cleanup(func() { cancel(); <-joined })
				go func() {
					defer close(joined)
					proposal, err := second.ProposeCount(work, actor(r.Destination.ID), r.ID, transfers.CountProposalInput{VariantID: 1, OperationKey: "r3b-count-proposal", ExpectedRevision: 0, Actual: 5, Reason: "count verified"})
					if err != nil {
						done <- chainReply{err: err}
						return
					}
					// Hold the attempted acceptance on the main thread so its complete
					// rollback snapshot can be asserted with existing fixture helpers.
					done <- chainReply{proposal: proposal}
				}()
				r3bWaitLock(t, ctx, p, holder, a02Arrived(t, ctx, waiting))
				release()
				restResult = r3bReceive(t, ctx, one)
				var chain chainReply
				select {
				case chain = <-done:
				case <-ctx.Done():
					t.Fatal("queued count proposal did not settle")
				}
				if restResult.err != nil || chain.err != nil {
					t.Fatal("restitution-first proposal chain", restResult.err, chain.err)
				}
				countProposal = chain.proposal
				settled := r2Snapshot(t, ctx, p)
				countResult.operation, countResult.err = s.DecideCount(ctx, actor(r.Origin.ID), r.ID, transfers.CountDecisionInput{VariantID: 1, OperationKey: "r3b-count-accept", ExpectedRevision: 1, Accept: true, Reason: "count confirmed"})
				if !errors.Is(countResult.err, transfers.ErrDecisionConflict) || !reflect.DeepEqual(countResult.operation, transfers.CountOperation{}) || settled != r2Snapshot(t, ctx, p) {
					t.Fatal("C4 conservation acceptance rollback", countResult.err)
				}
			}
			credit, sourceDelta, destDelta, countGeneration, countApplied := int64(4), int64(1), int64(0), int64(1), int64(0)
			state := "applied"
			if countFirst {
				credit, sourceDelta, destDelta, countGeneration, countApplied = 3, 0, -1, 2, 1
				state = "pending"
			}
			h := r3bHistory(t, ctx, s, r)
			line := h.Lines[0]
			if line.WorkflowRevision != 1 || line.AppliedRevision != sourceDelta || line.AppliedRetainedQuantity != sourceDelta || line.EffectiveCredit != credit || line.CountGeneration != countGeneration || line.CountAppliedRevision != countApplied || line.Proposals[0].State != state || line.Proposals[0].CountGeneration != 0 || line.Proposals[0].CountAppliedRevision != 0 || line.Proposals[0].BaseCredit != 4 || len(h.Operations) != int(1+sourceDelta) {
				t.Fatal("cross-workflow consent pins")
			}
			counts := c2StoreRead(t, ctx, s, r)
			cl := counts.Lines[0]
			if cl.WorkflowRevision != 1 || cl.AppliedRevision != countApplied || cl.EffectiveCredit != credit || len(counts.Operations) != int(countGeneration) || countProposal.Revision != 1 {
				t.Fatal("count history")
			}
			if countFirst {
				if cl.Proposals[0].State != "applied" || line.Proposals[0].Decision != nil || line.Proposals[0].Application != nil {
					t.Fatal("count-first evidence")
				}
			} else if cl.Proposals[0].State != "pending" || line.Proposals[0].Decision == nil || line.Proposals[0].Application == nil || line.Proposals[0].Application.Quantity != 1 {
				t.Fatal("restitution-first evidence")
			}
			// Count proposals pin their own predecessor. The additive SQL guard
			// revalidates committed restitution at acceptance rather than storing R
			// in historical count evidence.
			if cl.Proposals[0].BaseCredit != 4 {
				t.Fatal("count predecessor credit")
			}
			r3bEvidence(t, ctx, p, int(1+sourceDelta), 1, int(sourceDelta), int(sourceDelta))
			for i, row := range stocks(t, ctx, p) {
				want := beforeStock[i]
				if want.Variant == 1 {
					if want.Location == r.Origin.ID {
						want.Existing += sourceDelta
						want.Available += sourceDelta
					}
					if want.Location == r.Destination.ID {
						want.Existing += destDelta
						want.Available += destDelta
					}
				}
				if row != want {
					t.Fatal("cross-workflow stock/reservation conservation")
				}
			}
			if r2Original(t, ctx, p) != original || c2Revision(t, ctx, p, "inventory") != inv+1 || c2Revision(t, ctx, p, "transfers:1") != origin+2-countApplied || c2Revision(t, ctx, p, "transfers:2") != dest+2-countApplied || c2Revision(t, ctx, p, "transfers:3") != other {
				t.Fatal("cross-workflow originals/invalidation")
			}
		})
	}
}
