package transfers_test

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/inventory"
	"luson/api/internal/transfers"
)

// The SQL operation entrypoint is the workflow interface until the separate
// HTTP slice. Actor identity is still supplied only by the authenticated caller.
const dr1Call = `SELECT revision FROM transfer_dispatch_reconcile($1::bigint,$2::integer,$3::smallint,$4::text,$5::text,$6::bigint,$7::bigint,$8::text)`

func dr1Do(t *testing.T, ctx context.Context, p *pgxpool.Pool, r transfers.Request, who int, key, action string, revision int64, quantity any) int64 {
	t.Helper()
	var got int64
	if err := p.QueryRow(ctx, dr1Call, r.ID, 1, who, key, action, revision, quantity, "physical dispatch verified").Scan(&got); err != nil {
		t.Fatal("dispatch reconciliation operation failed", err)
	}
	return got
}

func dr1Inventory(t *testing.T, ctx context.Context, p *pgxpool.Pool) []inventory.Page {
	t.Helper()
	s := inventory.New(p)
	var pages []inventory.Page
	for location := 1; location <= 3; location++ {
		for page := 1; page <= 4; page++ {
			got, err := s.List(ctx, actor(location), inventory.Query{LocationID: location, Page: page, PageSize: 50})
			if err != nil {
				t.Fatal("public inventory read failed", err)
			}
			pages = append(pages, got)
		}
	}
	return pages
}

func dr1Balances(t *testing.T, ctx context.Context, p *pgxpool.Pool, origin, destination int64) {
	t.Helper()
	pages := dr1Inventory(t, ctx, p)
	for _, tc := range []struct {
		page int
		want int64
	}{{0, origin}, {4, destination}} {
		item := pages[tc.page].Items[0]
		if item.VariantID != 1 || item.Existing != tc.want || item.Reserved != 0 || item.Available != tc.want {
			t.Fatalf("public balance mismatch: got %+v; want existing/available %d, reserved 0", item, tc.want)
		}
	}
}

func TestDR1SuccessiveAgreement(t *testing.T) {
	for _, next := range []int64{8, 6} {
		t.Run(fmt.Sprintf("seven_to_%d", next), func(t *testing.T) {
			ctx, p, s := fixture(t)
			a01Exec(t, ctx, p, `UPDATE inventory_balances SET existing=CASE location_id WHEN 1 THEN 20 ELSE 10 END WHERE variant_id=1 AND location_id IN (1,2)`)
			in := input()
			in.Items = []transfers.Line{{VariantID: 1, Quantity: 5}}
			r := receiptDispatch(t, ctx, s, in)
			var err error
			r, err = s.Receive(ctx, actor(r.Destination.ID), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 7}}})
			if err != nil {
				t.Fatal(err)
			}
			original := r2Original(t, ctx, p)
			dr1Balances(t, ctx, p, 15, 15)
			before := dr1Inventory(t, ctx, p)
			if dr1Do(t, ctx, p, r, r.Origin.ID, "dr1-first-proposal", "propose", 0, 7) != 1 {
				t.Fatal("first proposal revision")
			}
			if !reflect.DeepEqual(before, dr1Inventory(t, ctx, p)) {
				t.Fatal("pending agreement changed public stock")
			}
			if dr1Do(t, ctx, p, r, r.Destination.ID, "dr1-first-accept", "accept", 1, nil) != 1 {
				t.Fatal("first decision revision")
			}
			dr1Balances(t, ctx, p, 13, 17)
			counts := c2StoreRead(t, ctx, s, r)
			if len(counts.Lines) != 1 || counts.Lines[0].EffectiveActual != 7 || counts.Lines[0].EffectiveCredit != 7 || counts.Lines[0].AppliedRevision != 0 || counts.Lines[0].ExpectedQuantity != 5 || counts.Lines[0].OriginalCredit != 5 {
				t.Fatal("shared count snapshot confused original and reconciled evidence", counts)
			}
			restitutions, err := s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID)
			if err != nil || len(restitutions.Lines) != 1 || restitutions.Lines[0].EffectiveCredit != 7 || restitutions.Lines[0].ExpectedQuantity != 5 || restitutions.Lines[0].OriginalCredit != 5 {
				t.Fatal("reconciled history without count application is unreadable", err)
			}
			// Fresh count agreement changes A, not D. Upward credit remains
			// capped at effective D=7; downward credit is debited exactly once.
			c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, next, "dr1-next-count-proposal")
			c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 1, true, "dr1-next-count-accept")
			credit, delta, destination := int64(7), int64(0), int64(17)
			if next == 6 {
				credit, delta, destination = 6, -1, 16
			}
			dr1Balances(t, ctx, p, 13, destination)
			counts = c2StoreRead(t, ctx, s, r)
			if counts.Lines[0].EffectiveActual != next || counts.Lines[0].EffectiveCredit != credit || counts.Lines[0].Proposals[0].Application.Delta != delta {
				t.Fatal("count ignored summed credit or effective dispatch", counts)
			}
			// Reverse the proposing endpoint for the fresh reconciliation.
			dr1Do(t, ctx, p, r, r.Destination.ID, "dr1-next-proposal", "propose", 1, next)
			dr1Do(t, ctx, p, r, r.Origin.ID, "dr1-next-accept", "accept", 2, nil)
			dr1Balances(t, ctx, p, 20-next, 10+next)
			counts = c2StoreRead(t, ctx, s, r)
			if counts.Lines[0].EffectiveCredit != next || counts.Lines[0].EffectiveActual != next || counts.Lines[0].ExpectedQuantity != 5 {
				t.Fatal("successive reconciliation snapshot", counts)
			}
			if _, err := s.GetRestitutions(ctx, actor(r.Destination.ID), r.ID); err != nil {
				t.Fatal("successive reconciliation restitution history", err)
			}
			if original != r2Original(t, ctx, p) {
				t.Fatal("reconciliation mutated sealed historical evidence")
			}
			if got, err := s.Get(ctx, actor(r.Origin.ID), r.ID); err != nil || !t10WorkflowDetailEqual(t, got, r) {
				t.Fatal("original public detail changed", err)
			}
			// Historical exact retries must not recompute stock from today's D/C.
			before = dr1Inventory(t, ctx, p)
			counters := r2Snapshot(t, ctx, p)
			dr1Do(t, ctx, p, r, r.Origin.ID, "dr1-first-proposal", "propose", 0, 7)
			dr1Do(t, ctx, p, r, r.Destination.ID, "dr1-first-accept", "accept", 1, nil)
			if !reflect.DeepEqual(before, dr1Inventory(t, ctx, p)) || counters != r2Snapshot(t, ctx, p) {
				t.Fatal("historical retry changed stock, existing workflow history or counters")
			}
		})
	}
}
