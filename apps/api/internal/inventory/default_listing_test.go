package inventory

import (
	"context"
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/auth/testpg"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
)

// S3: an absent kind is the battery-only listing every caller had before the
// second kind existed, and it stays that way whoever else holds a balance in the
// location. The closing count sheet reads this endpoint for branch stock and must
// keep counting no product, so the default is pinned by its own probe: a product
// with a positive balance in location 1 whose name matches the search never
// answers on this endpoint unless the kind is asked for.
func TestInventoryDefaultListingStaysBatteryOnly(t *testing.T) {
	p := testpg.Open(t)
	ctx := context.Background()
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal("initialize fixture failed")
	}
	s := New(p)
	actor := auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
	// The product holds stock in the warehouse, so a filter that only dropped
	// empty balances could not explain the answer.
	_, variant := otherProduct(t, ctx, p, "Agua acidulada", "volumen en L", "L", "5")
	if _, err := p.Exec(ctx, `UPDATE inventory_balances SET existing=12,reserved=0
 WHERE location_id=1 AND variant_id=$1`, variant); err != nil {
		t.Fatal("product balance fixture failed")
	}

	// The default query is the battery-only listing: 190 batteries, never 191.
	page, err := s.List(ctx, actor, Query{LocationID: 1, Page: 1, PageSize: 50})
	if err != nil || page.TotalVariants != 190 || len(page.Items) != 50 {
		t.Fatalf("the default listing must stay battery-only: %d %v", page.TotalVariants, err)
	}
	for _, item := range page.Items {
		if item.Kind != catalog.BatteryKind || item.Battery == nil || item.Fields != nil {
			t.Fatalf("a default row must be a battery identity without typed fields: %+v", item)
		}
	}
	// A term that names the product answers nothing at all: neither the product
	// nor a battery.
	if matches, err := s.List(ctx, actor, Query{LocationID: 1, Search: "Agua acidulada", Page: 1, PageSize: 50}); err != nil ||
		matches.TotalVariants != 0 || len(matches.Items) != 0 {
		t.Fatalf("the default listing must not answer a product by name: %+v %v", matches, err)
	}
	// The product really is there: asking for both kinds answers it, so the probe
	// above never passes for an empty catalogue.
	asked, err := s.List(ctx, actor, Query{LocationID: 1, Kind: catalog.AllKinds, Search: "Agua acidulada", Page: 1, PageSize: 50})
	if err != nil || asked.TotalVariants != 1 || len(asked.Items) != 1 || asked.Items[0].VariantID != variant ||
		asked.Items[0].Kind != catalog.OtherKind || asked.Items[0].Existing != 12 {
		t.Fatalf("the stocked product must be listed when the kind is asked for: %+v %v", asked, err)
	}
}
