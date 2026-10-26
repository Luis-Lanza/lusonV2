package transfers_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

func TestT4cCountDispatchEvidence(t *testing.T) {
	for _, next := range []int64{8, 6, 0} {
		t.Run(fmt.Sprint(next), func(t *testing.T) {
			ctx, p, s := fixture(t)
			in := input()
			in.Items = []transfers.Line{{VariantID: 1, Quantity: 5}}
			r := receiptDispatch(t, ctx, s, in)
			r, err := s.Receive(ctx, actor(r.Destination.ID), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 7}}})
			if err != nil {
				t.Fatal(err)
			}
			check := func(dispatch, revision, credit, applied int64) {
				t.Helper()
				for _, who := range []int{r.Origin.ID, r.Destination.ID} {
					counts, err := s.GetCountCorrections(ctx, actor(who), r.ID)
					if err != nil {
						t.Fatal(err)
					}
					raw, err := json.Marshal(counts.Lines[0])
					if err != nil {
						t.Fatal(err)
					}
					var line map[string]json.RawMessage
					if err := json.Unmarshal(raw, &line); err != nil {
						t.Fatal(err)
					}
					for key, want := range map[string]int64{"effective_dispatch": dispatch, "reconciliation_revision": revision,
						"effective_credit": credit, "applied_revision": applied, "expected_quantity": 5, "available_quantity": 5} {
						if string(line[key]) != fmt.Sprint(want) {
							t.Fatalf("%s=%s; want %d", key, line[key], want)
						}
					}
					rest, err := s.GetRestitutions(ctx, actor(who), r.ID)
					if err != nil || rest.Lines[0].EffectiveDispatch != dispatch || rest.Lines[0].ReconciliationRevision != revision || rest.Lines[0].EffectiveCredit != credit {
						t.Fatal("cross-workflow evidence", rest, err)
					}
				}
			}
			check(5, 0, 5, 0)
			dr1Do(t, ctx, p, r, r.Origin.ID, "t4c-dispatch-propose", "propose", 0, 7)
			dr1Do(t, ctx, p, r, r.Destination.ID, "t4c-dispatch-accept", "accept", 1, nil)
			check(7, 1, 7, 0)
			c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, next, "t4c-count-propose")
			c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 1, true, "t4c-count-accept")
			check(7, 1, min(7, next), 1)
			historical := c2StoreRead(t, ctx, s, r).Lines[0].Proposals
			dr1Do(t, ctx, p, r, r.Destination.ID, "t4c-next-propose", "propose", 1, next)
			dr1Do(t, ctx, p, r, r.Origin.ID, "t4c-next-accept", "accept", 2, nil)
			check(next, 2, next, 1)
			before := dr1Inventory(t, ctx, p)
			history := c2StoreRead(t, ctx, s, r)
			c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 1, true, "t4c-count-accept")
			if !reflect.DeepEqual(history, c2StoreRead(t, ctx, s, r)) || !reflect.DeepEqual(before, dr1Inventory(t, ctx, p)) || !reflect.DeepEqual(historical, history.Lines[0].Proposals) {
				t.Fatal("replay changed balances or immutable count history")
			}
			if original, err := s.Get(ctx, actor(r.Origin.ID), r.ID); err != nil || !reflect.DeepEqual(original, r) {
				t.Fatal("original detail changed", err)
			}
		})
	}
}
