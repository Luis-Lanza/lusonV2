package httpapi_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"luson/api/internal/inventory"
)

func TestRetiredBranchOperationalVisibility(t *testing.T) {
	f := t5Setup(t)
	original := f.request(f.tokens[0], "GET", "/api/inventory/metadata", "")
	if original.Code != 200 {
		t.Fatal("metadata unavailable")
	}
	// Preserve the existing unknown-location and malformed-query 400 contract.
	for _, route := range []string{"/api/inventory?location_id=32767", "/api/inventory?location_id=1&page=0"} {
		t5Error(t, f.request(f.tokens[0], "GET", route, ""), 400, "invalid_request")
	}
	directory, stock := branchRetirementDirectory(t, f), f.oldInventory()
	branchRetirementCreate(t, f)
	active := f.request(f.tokens[0], "GET", "/api/inventory/metadata", "")
	var meta inventory.Metadata
	decoder := json.NewDecoder(strings.NewReader(active.Body.String()))
	decoder.DisallowUnknownFields()
	if active.Code != 200 || decoder.Decode(&meta) != nil || len(meta.Locations) != 4 || meta.Locations[3] != (inventory.Location{ID: 4, Name: "Sucursal Retiro"}) {
		t.Fatal("new branch not selectable with strict metadata DTO")
	}
	t8Stock(t, f, 4, 0, 0)
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/branches/4", ""), 204, "")
	// Keep these independent: both missing behaviors should be visible in RED.
	t.Run("metadata", func(t *testing.T) {
		for _, token := range []string{f.tokens[0], f.tokens[2]} {
			t5Exact(t, f.request(token, "GET", "/api/inventory/metadata", ""), 200, original.Body.String())
		}
	})
	t.Run("direct_inventory", func(t *testing.T) {
		t5Error(t, f.request(f.tokens[0], "GET", "/api/inventory?location_id=4", ""), 404, "not_found")
	})
	if branchRetirementDirectory(t, f) != directory || f.oldInventory() != stock {
		t.Fatal("retirement changed surviving directory or inventory")
	}
}

func TestRetiredBranchFreshCreation(t *testing.T) {
	f := t5Setup(t)
	branchRetirementCreate(t, f)
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/branches/4", ""), 204, "")
	before, stock := f.snapshot(), f.oldInventory()
	history := f.request(f.tokens[0], "GET", "/api/transfers", "")
	if history.Code != 200 {
		t.Fatal("history unavailable")
	}
	t8Stock(t, f, 1, 18, 0)
	// Normal warehouse actor, stocked variant, fresh valid key: only the
	// counterparty's retirement is invalid. SQL017 already rejects the insert;
	// the missing behavior is its canonical public conflict translation.
	w := f.request(f.tokens[0], "POST", "/api/transfers", t8Body("direct_shipment", 4, "retired-fresh-create-01"))
	t.Run("conflict", func(t *testing.T) { t5Error(t, w, 409, "decision_conflict") })
	if f.snapshot() != before || f.oldInventory() != stock {
		t.Fatal("rejected creation changed public state")
	}
	t5Exact(t, f.request(f.tokens[0], "GET", "/api/transfers", ""), 200, history.Body.String())
}

func TestRetiredBranchReceivedFreshWork(t *testing.T) {
	f := t5Setup(t)
	branchRetirementCreate(t, f)
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"location_id":4}`), 204, "")
	operator := retirementLogin(t, f, 1)
	body := `{"kind":"direct_shipment","counterparty_location_id":4,"retry_key":"retired-zero-credit-01","items":[{"variant_id":1,"quantity":"1"}]}`
	created := t8Decode(t, f.request(f.tokens[0], "POST", "/api/transfers", body), 201)
	path := "/api/transfers/" + created.ID
	if created.Status != "approved" || created.Origin != 1 || created.Destination != 4 {
		t.Fatal("direct fixture direction/status")
	}
	t8Stock(t, f, 1, 18, 1)
	transit := t8Decode(t, f.request(f.tokens[0], "POST", path+"/dispatch", "{}"), 200)
	if transit.Status != "in_transit" {
		t.Fatal("dispatch fixture")
	}
	t8Stock(t, f, 1, 17, 0)
	// Positive unexpected actual satisfies receipt admission but credits zero:
	// expected variant1 actual0, unexpected variant2 expected0 actual1.
	receivedResponse := f.request(operator, "POST", path+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"0"},{"variant_id":2,"actual_quantity":"1"}]}`)
	received := t8Decode(t, receivedResponse, 200)
	if received.Status != "received" || len(received.Activity) != 3 {
		t.Fatal("received fixture")
	}
	actor := received.Activity[2]
	if actor.Actor.AccountID != "2" || actor.Actor.Username != f.creds[1].Username || actor.Actor.DisplayName != "Persona" || actor.LocationID != 4 || actor.LocationName != "Sucursal Retiro" || actor.Action != "receive" {
		t.Fatal("received personal snapshot")
	}
	var receipt struct {
		Receipt struct {
			Lines []struct {
				Variant  int    `json:"variant_id"`
				Expected string `json:"expected_quantity"`
				Actual   string `json:"actual_quantity"`
				Credit   string `json:"available_quantity"`
			} `json:"items"`
		} `json:"receipt"`
	}
	if json.Unmarshal(receivedResponse.Body.Bytes(), &receipt) != nil || len(receipt.Receipt.Lines) != 2 {
		t.Fatal("receipt lines unavailable")
	}
	for i, line := range receipt.Receipt.Lines {
		if line.Variant != i+1 || line.Credit != "0" || (i == 0 && (line.Expected != "1" || line.Actual != "0")) || (i == 1 && (line.Expected != "0" || line.Actual != "1")) {
			t.Fatal("zero-credit receipt arithmetic")
		}
	}
	// All pages, not just variant1: destination has no credited stock.
	for page := 1; page <= 4; page++ {
		query := []string{"1", "2", "3", "4"}[page-1]
		w := f.request(f.tokens[0], "GET", "/api/inventory?location_id=4&page_size=50&page="+query, "")
		var p inventory.Page
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &p) != nil || p.TotalVariants != 190 {
			t.Fatal("destination inventory fixture")
		}
		for _, row := range p.Items {
			if row.Existing != 0 || row.Reserved != 0 || row.Available != 0 {
				t.Fatal("destination must remain empty")
			}
		}
	}
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/accounts/2", ""), 204, "")
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/branches/4", ""), 204, "")
	// Full historical detail includes retired location and personal actor names.
	t5Exact(t, f.request(f.tokens[0], "GET", path, ""), 200, receivedResponse.Body.String())
	get := func(route string) string {
		t.Helper()
		w := f.request(f.tokens[0], "GET", route, "")
		if w.Code != 200 || len(w.Result().Cookies()) != 0 {
			t.Fatalf("history %s: %d %s", route, w.Code, w.Body.String())
		}
		return w.Body.String()
	}
	routes := []string{path, path + "/count-corrections", path + "/restitutions", path + "/dispatch-reconciliations", "/api/transfers?status=received"}
	observe := func() []string {
		state := []string{f.snapshot(), f.oldInventory()}
		for _, route := range routes {
			state = append(state, get(route))
		}
		return state
	}
	before := observe()
	// Each workflow has independent revision0; no pending proposal, applied
	// restitution or reconciliation. Origin may propose all three, including
	// count1, retained1, dispatch0 (= effective actual0, different from debit1).
	for _, tc := range []struct{ name, route, body string }{
		{"count", "/count-corrections/propose", `{"variant_id":1,"operation_key":"retired-fresh-count-01","expected_revision":"0","actual_quantity":"1","reason":"recount"}`},
		{"restitution", "/restitutions/propose", `{"variant_id":1,"operation_key":"retired-fresh-restitution-01","expected_revision":"0","retained_quantity":"1","retained_at_origin":true,"reason":"retained at origin"}`},
		{"reconciliation", "/dispatch-reconciliations/propose", `{"variant_id":1,"operation_key":"retired-fresh-dispatch-01","expected_revision":"0","dispatch_quantity":"0","reason":"dispatch correction"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := f.request(f.tokens[0], "POST", path+tc.route, tc.body)
			// Check observations even on the expected baseline wrong error status.
			if !reflect.DeepEqual(observe(), before) {
				t.Fatal("rejected fresh work changed public detail/activity/workflows/inventory/counters")
			}
			t5Error(t, w, 409, "decision_conflict")
		})
	}
}
