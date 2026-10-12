package transfers_test

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

func w01Input(destination int) transfers.CreateInput {
	in := input()
	in.Kind, in.CounterpartyID = transfers.DirectShipment, destination
	return in
}

func TestW01DirectShipmentReplayBeforeStock(t *testing.T) {
	ctx, p, s := fixture(t)
	in := w01Input(2)
	initial := create(t, ctx, s, 1, in).Request
	// Independent holds exhaust availability without removing owned coverage.
	a01Exec(t, ctx, p, "UPDATE inventory_balances SET reserved=existing WHERE location_id=1 AND variant_id IN(1,2)")
	before := receiptSnapshot(t, ctx, p)
	replayStore, stockProbe, _ := a02Gated(t, ctx, p, "inventory_balances", false)
	replay, err := replayStore.Create(ctx, actor(1), in)
	if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Request, initial) || len(stockProbe.arrived) != 0 {
		t.Fatal("identical direct replay queried stock or changed original history")
	}
	invalid := in
	invalid.Items = nil
	if _, err := s.Create(ctx, actor(1), invalid); !errors.Is(err, transfers.ErrInvalid) {
		t.Fatal("existing key bypassed cart validation")
	}
	if _, err := s.Create(ctx, actor(2), in); !errors.Is(err, transfers.ErrForbidden) {
		t.Fatal("existing warehouse key granted branch authority")
	}
	in.RetryKey = "w01-fresh-exhausted-key"
	if _, err := s.Create(ctx, actor(1), in); !errors.Is(err, transfers.ErrInsufficientStock) {
		t.Fatal("fresh direct request bypassed exhausted stock")
	}
	if receiptSnapshot(t, ctx, p) != before {
		t.Fatal("replay or refused fresh request changed state")
	}
}

func TestW01DirectShipmentAtomicity(t *testing.T) {
	for _, mode := range []string{"later_shortage", "missing_balance", "unknown_variant", "midwrite", "deferred_commit"} {
		t.Run(mode, func(t *testing.T) {
			ctx, p, s := fixture(t)
			in := w01Input(2)
			want := transfers.ErrUnavailable
			switch mode {
			case "later_shortage":
				in.Items[0].Quantity = 26 // Variant 2 has 25; variant 1 is valid.
				want = transfers.ErrInsufficientStock
			case "missing_balance":
				a01Exec(t, ctx, p, "DELETE FROM inventory_balances WHERE location_id=1 AND variant_id=2")
				want = transfers.ErrInvalid
			case "unknown_variant":
				in.Items[0].VariantID = 1000
				want = transfers.ErrInvalid
			case "midwrite":
				a01Exec(t, ctx, p, `CREATE FUNCTION w01_fail_item() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.variant_id=2 THEN RAISE EXCEPTION 'injected second item failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER w01_fail_item BEFORE INSERT ON transfer_request_items FOR EACH ROW EXECUTE FUNCTION w01_fail_item()`)
			case "deferred_commit":
				a01Exec(t, ctx, p, `CREATE SEQUENCE w01_commit_seen;
 CREATE FUNCTION w01_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN PERFORM nextval('w01_commit_seen'); RAISE EXCEPTION 'injected commit failure'; END $$;
 CREATE CONSTRAINT TRIGGER w01_fail_commit AFTER INSERT ON transfer_requests DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION w01_fail_commit()`)
			}
			before := receiptSnapshot(t, ctx, p)
			got, err := s.Create(ctx, actor(1), in)
			if !errors.Is(err, want) || !reflect.DeepEqual(got, transfers.CreateResult{}) || receiptSnapshot(t, ctx, p) != before {
				t.Fatal("failed direct creation left partial history, reservations or revisions")
			}
			if mode == "deferred_commit" {
				var reached bool
				if p.QueryRow(ctx, "SELECT is_called FROM w01_commit_seen").Scan(&reached) != nil || !reached {
					t.Fatal("deferred failure did not reach commit")
				}
			}
		})
	}
}

func TestW01DirectShipmentLifecycle(t *testing.T) {
	for _, destination := range []int{2, 3} {
		for _, terminal := range []string{"cancelled", "received"} {
			t.Run(fmt.Sprintf("destination_%d_%s", destination, terminal), func(t *testing.T) {
				ctx, p, s := fixture(t)
				// Independent holds are not owned by this shipment and must survive.
				a01Exec(t, ctx, p, "UPDATE inventory_balances SET reserved=3 WHERE location_id=1 AND variant_id IN(1,2)")
				before := stocks(t, ctx, p)
				in := w01Input(destination)
				initial := create(t, ctx, s, 1, in).Request
				wantStock := append([]stockRow(nil), before...)
				for i := range wantStock {
					for _, line := range in.Items {
						if wantStock[i].Location == 1 && int64(wantStock[i].Variant) == line.VariantID {
							wantStock[i].Reserved += line.Quantity
							wantStock[i].Available -= line.Quantity
						}
					}
				}
				if !reflect.DeepEqual(stocks(t, ctx, p), wantStock) {
					t.Fatal("direct reservation replaced independent holds")
				}
				counts, err := s.Counts(ctx, actor(1))
				if err != nil || counts != (transfers.Totals{ActionCount: 1}) {
					t.Fatal("direct creation must count as warehouse dispatch, never Pending approval")
				}
				for _, id := range []int{destination, 5 - destination} {
					counts, err := s.Counts(ctx, actor(id))
					if err != nil || counts != (transfers.Totals{}) {
						t.Fatal("direct creation invented a branch approval action")
					}
				}
				settled := receiptSnapshot(t, ctx, p)
				for _, id := range []int{1, destination, 5 - destination} {
					want := transfers.ErrDecisionConflict
					if id == destination {
						want = transfers.ErrForbidden
					}
					if id == 5-destination {
						want = transfers.ErrNotFound
					}
					got, err := s.Approve(ctx, actor(id), initial.ID)
					a02Error(t, got, err, want)
					got, err = s.Reject(ctx, actor(id), initial.ID)
					a02Error(t, got, err, want)
				}
				got, err := s.Cancel(ctx, actor(destination), initial.ID)
				a02Error(t, got, err, transfers.ErrForbidden)
				got, err = s.Dispatch(ctx, actor(destination), initial.ID)
				a02Error(t, got, err, transfers.ErrForbidden)
				if receiptSnapshot(t, ctx, p) != settled {
					t.Fatal("decision or role refusals changed direct history")
				}
				current := initial
				if terminal == "cancelled" {
					current, err = s.Cancel(ctx, actor(1), initial.ID)
					if err != nil || current.Status != terminal {
						t.Fatal("warehouse cancellation failed")
					}
					wantStock = before
					if scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations WHERE released_at IS NOT NULL AND consumed_at IS NULL") != 2 {
						t.Fatal("cancellation did not release only its owned allocation history")
					}
				} else {
					current, err = s.Dispatch(ctx, actor(1), initial.ID)
					if err != nil || current.Status != "in_transit" {
						t.Fatal("warehouse dispatch failed")
					}
					for i := range wantStock {
						for _, line := range in.Items {
							if wantStock[i].Location == 1 && int64(wantStock[i].Variant) == line.VariantID {
								wantStock[i].Existing -= line.Quantity
								wantStock[i].Reserved -= line.Quantity
							}
						}
					}
					if !reflect.DeepEqual(stocks(t, ctx, p), wantStock) {
						t.Fatal("dispatch changed destination or independent holds")
					}
					inTransit := create(t, ctx, s, 1, in)
					if !inTransit.Replayed || !reflect.DeepEqual(inTransit.Request, current) {
						t.Fatal("creation replay lost dispatch truth")
					}
					counts, err = s.Counts(ctx, actor(destination))
					if err != nil || counts != (transfers.Totals{ActionCount: 1}) {
						t.Fatal("receipt action not assigned to destination")
					}
					got, err = s.Cancel(ctx, actor(1), initial.ID)
					a02Error(t, got, err, transfers.ErrDecisionConflict)
					got, err = s.Receive(ctx, actor(1), initial.ID, receiptInput(current))
					a02Error(t, got, err, transfers.ErrForbidden)
					current, err = s.Receive(ctx, actor(destination), initial.ID, receiptInput(current))
					if err != nil || current.Status != terminal {
						t.Fatal("destination receipt failed")
					}
					for i := range wantStock {
						for _, line := range in.Items {
							if wantStock[i].Location == destination && int64(wantStock[i].Variant) == line.VariantID {
								wantStock[i].Existing += line.Quantity
								wantStock[i].Available += line.Quantity
							}
						}
					}
					if scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations WHERE consumed_at IS NOT NULL AND released_at IS NULL") != 2 {
						t.Fatal("receipt lost consumed allocation history")
					}
				}
				if !reflect.DeepEqual(stocks(t, ctx, p), wantStock) {
					t.Fatal("terminal stock changed unrelated holds or physical quantities")
				}
				if current.Kind != initial.Kind || current.Creator != initial.Creator || current.Origin != initial.Origin || current.Destination != initial.Destination || !current.CreatedAt.Equal(initial.CreatedAt) || !reflect.DeepEqual(current.Items, initial.Items) || !reflect.DeepEqual(current.DecidedAt, initial.DecidedAt) || !reflect.DeepEqual(current.DecisionLocationID, initial.DecisionLocationID) {
					t.Fatal("lifecycle changed immutable shipment or creation-time authorization")
				}
				settled = receiptSnapshot(t, ctx, p)
				in.Items[0], in.Items[1] = in.Items[1], in.Items[0]
				replay := create(t, ctx, s, 1, in)
				if !replay.Replayed || !reflect.DeepEqual(replay.Request, current) {
					t.Fatal("terminal creation replay is not current truth")
				}
				in.Items[0].Quantity++
				if _, err := s.Create(ctx, actor(1), in); !errors.Is(err, transfers.ErrRetryConflict) {
					t.Fatal("changed terminal cart accepted")
				}
				for _, id := range []int{1, destination} {
					got, err := s.Get(ctx, actor(id), current.ID)
					if err != nil || !reflect.DeepEqual(got, current) {
						t.Fatal("terminal detail recovery changed history")
					}
					page, err := s.List(ctx, actor(id), transfers.Query{Status: terminal})
					if err != nil || page.Total != 1 || len(page.Records) != 1 || !reflect.DeepEqual(page.Records[0], current) {
						t.Fatal("terminal list lost warehouse intent")
					}
					counts, err := s.Counts(ctx, actor(id))
					if err != nil || counts != (transfers.Totals{}) {
						t.Fatal("terminal shipment contributes an action")
					}
				}
				got, err = s.Get(ctx, actor(5-destination), current.ID)
				a02Error(t, got, err, transfers.ErrNotFound)
				if receiptSnapshot(t, ctx, p) != settled {
					t.Fatal("terminal replay/read/refusal mutated history or revisions")
				}
			})
		}
	}
}

func TestW01DirectShipmentStore(t *testing.T) {
	for _, destination := range []int{2, 3} {
		t.Run(fmt.Sprintf("destination_%d", destination), func(t *testing.T) {
			ctx, p, s := fixture(t)
			before := stocks(t, ctx, p)
			in := input()
			in.Kind = transfers.Kind("direct_shipment")
			in.CounterpartyID = destination
			in.RetryKey = fmt.Sprintf("w01-direct-store-%d", destination)
			created, err := s.Create(ctx, actor(1), in)
			// Intended RED: this existing creation method must accept warehouse creation.
			if err != nil {
				t.Fatal("warehouse direct shipment creation must succeed")
			}
			r := created.Request
			if created.Replayed || r.ID <= 0 || r.Kind != in.Kind || r.Status != "approved" || r.Creator.ID != 1 || r.Origin.ID != 1 || r.Destination.ID != destination || r.Approver.ID != 1 || len(r.Items) != 2 {
				t.Fatal("direct creation did not persist the trusted approved direction")
			}
			if r.CreatedAt.IsZero() || r.DecisionLocationID == nil || *r.DecisionLocationID != 1 || r.DecidedAt == nil || !r.DecidedAt.Equal(r.CreatedAt) || r.DispatchedAt != nil || r.ReceivedAt != nil || r.CancelledAt != nil {
				t.Fatal("creation must persist its initial warehouse decision, not a later approval")
			}
			var kind, status string
			var creator, origin, target, approver, decision int
			var createdAt, decidedAt time.Time
			if p.QueryRow(ctx, `SELECT kind,status,creator_location_id,origin_location_id,destination_location_id,
 approver_location_id,decision_location_id,created_at,decided_at FROM transfer_requests WHERE id=$1`, r.ID).
				Scan(&kind, &status, &creator, &origin, &target, &approver, &decision, &createdAt, &decidedAt) != nil ||
				kind != "direct_shipment" || status != "approved" || creator != 1 || origin != 1 || target != destination || approver != 1 || decision != 1 || !createdAt.Equal(decidedAt) || !createdAt.Equal(r.CreatedAt) {
				t.Fatal("initial decision or immutable direction was not persisted")
			}
			wantStock := append([]stockRow(nil), before...)
			for i := range wantStock {
				for _, line := range in.Items {
					if wantStock[i].Location == 1 && int64(wantStock[i].Variant) == line.VariantID {
						wantStock[i].Reserved += line.Quantity
						wantStock[i].Available -= line.Quantity
					}
				}
			}
			if !reflect.DeepEqual(stocks(t, ctx, p), wantStock) {
				t.Fatal("creation must only reserve the warehouse cart, preserving all existing stock")
			}
			if r.Items[0].VariantID != 1 || r.Items[0].Quantity != 2 || r.Items[1].VariantID != 2 || r.Items[1].Quantity != 1 {
				t.Fatal("complete canonical cart changed")
			}
			var exact bool
			if p.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM transfer_request_items WHERE request_id=$1)=2
 AND (SELECT count(*) FROM transfer_request_allocations)=2
 AND NOT EXISTS(SELECT 1 FROM transfer_request_items i
 LEFT JOIN transfer_request_allocations a USING(request_id,variant_id)
 WHERE i.request_id=$1 AND (a.request_id IS NULL OR a.quantity<>i.quantity OR a.consumed_at IS NOT NULL OR a.released_at IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM transfer_request_allocations a
 LEFT JOIN transfer_request_items i USING(request_id,variant_id)
 WHERE a.request_id<>$1 OR i.request_id IS NULL)`, r.ID).Scan(&exact) != nil || !exact {
				t.Fatal("creation must own exactly the complete active cart allocation")
			}
			persisted := outcomeSnapshot(t, ctx, p)
			in.Items[0], in.Items[1] = in.Items[1], in.Items[0]
			replay, err := s.Create(ctx, actor(1), in)
			if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Request, r) {
				t.Fatal("creation retry changed immutable direct shipment")
			}
			for _, participant := range []int{1, destination} {
				got, err := s.Get(ctx, actor(participant), r.ID)
				if err != nil || !reflect.DeepEqual(got, r) {
					t.Fatal("participant recovery changed the initial approved record")
				}
			}
			if outcomeSnapshot(t, ctx, p) != persisted {
				t.Fatal("replay or recovery changed headers, items, allocations or stock")
			}
		})
	}
}
