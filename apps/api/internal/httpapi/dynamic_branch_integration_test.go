package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strconv"
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/inventory"
	"luson/api/internal/transfers"
)

// T8 uses the admitted random-owned database and actual composed HTTP router.
// SQL is confined to initial fixture stock; every assertion uses public HTTP.
func t8Setup(t *testing.T) (*t5Fixture, string, t5Account) {
	t.Helper()
	f := t5Setup(t)
	if _, err := f.p.Exec(f.ctx, `UPDATE inventory_balances SET existing=20 WHERE location_id IN (1,2,3) AND variant_id=1`); err != nil {
		t.Fatal("owned stock setup failed")
	}
	t5Exact(t, f.request(f.tokens[0], "POST", "/api/admin/branches", `{"name":"Sucursal T8"}`), 201, "{\"id\":4,\"name\":\"Sucursal T8\"}\n")
	a := f.create("t8_person", 4, "temporary-t8-password")
	if a.LocationID != 4 || !a.MustChange {
		t.Fatal("new assigned temporary operator")
	}
	// Independent identity keys may coincide numerically.
	_, token, err := f.svc.Login(f.ctx, "t8_person", "temporary-t8-password", "192.0.2.80", "")
	if err != nil {
		t.Fatal("temporary login failed")
	}
	t5Error(t, f.request(token, "GET", "/api/inventory?location_id=4", ""), 403, "password_change_required")
	w := f.request(token, "POST", "/api/auth/password", `{"current_password":"temporary-t8-password","new_password":"completed-t8-password"}`)
	if w.Code != 204 || w.Body.Len() != 0 || len(w.Result().Cookies()) != 1 || w.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("HTTP password completion contract")
	}
	t5Error(t, f.request(token, "GET", "/api/inventory?location_id=4", ""), 401, "unauthenticated")
	_, token, err = f.svc.Login(f.ctx, "t8_person", "completed-t8-password", "192.0.2.81", "")
	if err != nil {
		t.Fatal("completed login failed")
	}
	seen := map[int]bool{}
	for page := 1; page <= 4; page++ {
		w := f.request(token, "GET", fmt.Sprintf("/api/inventory?location_id=4&page_size=50&page=%d", page), "")
		var p inventory.Page
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &p) != nil || p.TotalVariants != 190 || p.Location.ID != 4 {
			t.Fatal("new branch public inventory")
		}
		for _, row := range p.Items {
			if seen[row.VariantID] || row.Existing != 0 || row.Reserved != 0 || row.Available != 0 {
				t.Fatal("new branch must start at zero")
			}
			seen[row.VariantID] = true
		}
	}
	if len(seen) != 190 {
		t.Fatal("incomplete zero catalog")
	}
	w = f.request(token, "GET", "/api/inventory/metadata", "")
	var meta inventory.Metadata
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &meta) != nil || len(meta.Locations) != 4 || meta.Locations[3].ID != 4 {
		t.Fatal("branch not selectable")
	}
	t5Error(t, f.request(token, "GET", "/api/admin/accounts", ""), 403, "forbidden")
	return f, token, a
}

type t8Record struct {
	ID                   string               `json:"id"`
	Status               string               `json:"status"`
	Origin               int                  `json:"origin_location_id"`
	Destination          int                  `json:"destination_location_id"`
	Activity             []transfers.Activity `json:"activity"`
	DecisionLocation     *int                 `json:"decision_location_id"`
	DecidedAt            *string              `json:"decided_at"`
	CancellationLocation *int                 `json:"cancellation_location_id"`
	CancelledAt          *string              `json:"cancelled_at"`
}

func t8Decode(t *testing.T, w *httptest.ResponseRecorder, status int) t8Record {
	t.Helper()
	var r t8Record
	if w.Code != status || len(w.Result().Cookies()) != 0 || json.Unmarshal(w.Body.Bytes(), &r) != nil || r.ID == "" {
		t.Fatalf("transfer HTTP got %d %s; want %d", w.Code, w.Body.String(), status)
	}
	return r
}
func t8Body(kind string, peer int, key string) string {
	return fmt.Sprintf(`{"kind":%q,"counterparty_location_id":%d,"retry_key":%q,"items":[{"variant_id":1,"quantity":"2"}]}`, kind, peer, key)
}
func t8ReadStock(t *testing.T, f *t5Fixture, location int) (int64, int64, int64) {
	t.Helper()
	w := f.request(f.tokens[0], "GET", fmt.Sprintf("/api/inventory?location_id=%d&page_size=50", location), "")
	var p inventory.Page
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &p) != nil {
		t.Fatal("stock HTTP unavailable")
	}
	for _, row := range p.Items {
		if row.VariantID == 1 {
			return int64(row.Existing), int64(row.Reserved), int64(row.Available)
		}
	}
	t.Fatal("variant absent")
	return 0, 0, 0
}
func t8Stock(t *testing.T, f *t5Fixture, location int, existing, reserved int64) {
	t.Helper()
	e, r, a := t8ReadStock(t, f, location)
	if e != existing || r != reserved || a != existing-reserved {
		t.Fatalf("location %d stock got %d/%d/%d want %d/%d/%d", location, e, r, a, existing, reserved, existing-reserved)
	}
}
func t8Identity(t *testing.T, f *t5Fixture, token string) auth.Identity {
	t.Helper()
	w := f.request(token, "GET", "/api/auth/session", "")
	var session struct {
		Authenticated bool          `json:"authenticated"`
		Identity      auth.Identity `json:"identity"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &session) != nil || !session.Authenticated || session.Identity.MustChangePassword {
		t.Fatal("operating identity unavailable")
	}
	return session.Identity
}
func t8Lifecycle(t *testing.T, f *t5Fixture, creator, origin, destination string, kind string, peer, from, to int, key string) t8Record {
	t.Helper()
	creatorIdentity := t8Identity(t, f, creator)
	originIdentity := t8Identity(t, f, origin)
	destinationIdentity := t8Identity(t, f, destination)
	beforeOrigin, reserved, _ := t8ReadStock(t, f, from)
	beforeDestination, destinationReserved, _ := t8ReadStock(t, f, to)
	if reserved != 0 || destinationReserved != 0 {
		t.Fatal("unexpected fixture reservations")
	}
	check := func(existing, reservation, destinationStock int64) {
		t8Stock(t, f, from, existing, reservation)
		t8Stock(t, f, to, destinationStock, 0)
	}
	body := t8Body(kind, peer, key)
	r := t8Decode(t, f.request(creator, "POST", "/api/transfers", body), 201)
	if r.Origin != from || r.Destination != to {
		t.Fatal("physical direction")
	}
	initialReservation := int64(0)
	if kind == "direct_shipment" {
		initialReservation = 2
	}
	check(beforeOrigin, initialReservation, beforeDestination)
	path := "/api/transfers/" + r.ID
	replay := f.request(creator, "POST", "/api/transfers", body)
	if got := t8Decode(t, replay, 200); !reflect.DeepEqual(got, r) {
		t.Fatal("creation replay")
	}
	check(beforeOrigin, initialReservation, beforeDestination)
	if kind != "direct_shipment" {
		if r.Status != "pending" {
			t.Fatal("request must remain pending")
		}
		approver := origin
		if kind == "send_to_warehouse" {
			approver = destination
		}
		r = t8Decode(t, f.request(approver, "POST", path+"/approve", "{}"), 200)
	}
	if r.Status != "approved" {
		t.Fatal("approval missing")
	}
	check(beforeOrigin, 2, beforeDestination)
	r = t8Decode(t, f.request(origin, "POST", path+"/dispatch", "{}"), 200)
	if r.Status != "in_transit" {
		t.Fatal("dispatch missing")
	}
	check(beforeOrigin-2, 0, beforeDestination)
	r = t8Decode(t, f.request(destination, "POST", path+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"2"}]}`), 200)
	if r.Status != "received" {
		t.Fatal("receipt missing")
	}
	check(beforeOrigin-2, 0, beforeDestination+2)
	got := t8Decode(t, f.request(creator, "POST", "/api/transfers", body), 200)
	if !reflect.DeepEqual(got, r) {
		t.Fatal("terminal replay")
	}
	check(beforeOrigin-2, 0, beforeDestination+2)
	detail := t8Decode(t, f.request(destination, "GET", path, ""), 200)
	if !reflect.DeepEqual(detail, r) {
		t.Fatal("persisted detail changed terminal evidence")
	}
	actions := []string{"create", "dispatch", "receive"}
	actors := []auth.Identity{creatorIdentity, originIdentity, destinationIdentity}
	if kind != "direct_shipment" {
		approverIdentity := originIdentity
		if kind == "send_to_warehouse" {
			approverIdentity = destinationIdentity
		}
		actions = []string{"create", "approve", "dispatch", "receive"}
		actors = []auth.Identity{creatorIdentity, approverIdentity, originIdentity, destinationIdentity}
	}
	if len(detail.Activity) != len(actions) {
		t.Fatal("personal activity cardinality")
	}
	for i, e := range detail.Activity {
		actor := actors[i]
		if e.Category != "transfer" || e.Action != actions[i] || e.Actor.AccountID != strconv.Itoa(actor.AccountID) || e.Actor.Username != actor.Username || e.Actor.DisplayName != actor.DisplayName || e.LocationID != actor.Location.ID || e.LocationName != actor.Location.Name || e.RecordedAt.IsZero() {
			t.Fatalf("personal action %s lost public actor/location evidence", actions[i])
		}
	}
	return detail
}
func TestT8NewBranchWarehouseRequest(t *testing.T) {
	f, token, a := t8Setup(t)
	r := t8Lifecycle(t, f, token, f.tokens[0], token, "request_stock", 1, 1, 4, "t8-inbound-request-01")
	t8Stock(t, f, 1, 18, 0)
	t8Stock(t, f, 4, 2, 0)
	if len(r.Activity) != 4 {
		t.Fatal("personal workflow activity missing")
	}
	for _, i := range []int{0, 3} {
		if r.Activity[i].Actor.AccountID != a.ID || r.Activity[i].Actor.Username != "t8_person" || r.Activity[i].LocationID != 4 {
			t.Fatal("new branch personal actor attribution")
		}
	}
}
func TestT8NewBranchDirectShipment(t *testing.T) {
	f, token, _ := t8Setup(t)
	t8Lifecycle(t, f, f.tokens[0], f.tokens[0], token, "direct_shipment", 4, 1, 4, "t8-direct-newbranch-01")
	t8Stock(t, f, 1, 18, 0)
	t8Stock(t, f, 4, 2, 0)
}
func TestT8NewBranchOutbound(t *testing.T) {
	f, token, _ := t8Setup(t)
	t8Lifecycle(t, f, token, f.tokens[0], token, "request_stock", 1, 1, 4, "t8-outbound-funding-01")
	t8Lifecycle(t, f, token, token, f.tokens[0], "send_to_warehouse", 1, 4, 1, "t8-outbound-return-01")
	t8Stock(t, f, 1, 20, 0)
	t8Stock(t, f, 4, 0, 0)
}
func TestT8NewBranchCounterparty(t *testing.T) {
	f, token, _ := t8Setup(t)
	t8Lifecycle(t, f, token, f.tokens[0], token, "request_stock", 1, 1, 4, "t8-peer-funding-0001")
	t8Lifecycle(t, f, f.tokens[1], token, f.tokens[1], "request_stock", 4, 4, 2, "t8-peer-request-0001")
	t8Stock(t, f, 4, 0, 0)
	t8Stock(t, f, 2, 22, 0)
}

func TestT8NewBranchRejectedLocations(t *testing.T) {
	f, token, _ := t8Setup(t)
	snapshot := func() string {
		result := f.oldInventory()
		for _, session := range []string{f.tokens[0], token} {
			for _, path := range []string{"/api/inventory?location_id=4&page_size=50", "/api/transfers?status=all", "/api/transfers/counts"} {
				w := f.request(session, "GET", path, "")
				if w.Code != 200 {
					t.Fatal("public rejection snapshot unavailable")
				}
				result += w.Body.String()
			}
		}
		return result
	}
	for _, tc := range []struct {
		kind   string
		peer   int
		token  string
		status int
		code   string
	}{
		{"request_stock", 4, token, 400, "invalid_request"},
		{"request_stock", 32767, token, 400, "invalid_request"},
		{"direct_shipment", 2, token, 403, "forbidden"},
		{"direct_shipment", 4, "", 401, "unauthenticated"},
	} {
		before := snapshot()
		t5Error(t, f.request(tc.token, "POST", "/api/transfers", t8Body(tc.kind, tc.peer, "t8-rejected-location-01")), tc.status, tc.code)
		if snapshot() != before {
			t.Fatal("rejection changed public stock/list/counts")
		}
	}
}
func TestT8ExistingBranchCommandsPreserved(t *testing.T) {
	f, _, _ := t8Setup(t)
	t8Lifecycle(t, f, f.tokens[1], f.tokens[0], f.tokens[1], "request_stock", 1, 1, 2, "t8-existing-request-01")
	t8Lifecycle(t, f, f.tokens[1], f.tokens[1], f.tokens[0], "send_to_warehouse", 1, 2, 1, "t8-existing-outbound-01")
	t8Stock(t, f, 1, 20, 0)
	t8Stock(t, f, 2, 20, 0)
}

// Terminal reads and replays must retain exact personal history without applying
// the business effect again. Lists omit activity by their existing contract.
func t8TerminalRecovery(t *testing.T, f *t5Fixture, creator, counterparty, body, operation string, r t8Record) {
	t.Helper()
	path := "/api/transfers/" + r.ID
	operator := creator
	if operation == "reject" {
		operator = counterparty
	}
	for _, call := range []struct{ token, verb, path, body string }{
		{operator, "POST", path + "/" + operation, "{}"},
		{creator, "POST", "/api/transfers", body},
		{creator, "GET", path, ""},
		{counterparty, "GET", path, ""},
	} {
		if got := t8Decode(t, f.request(call.token, call.verb, call.path, call.body), 200); !reflect.DeepEqual(got, r) {
			t.Fatal("terminal replay/detail changed persisted evidence")
		}
	}
	for _, token := range []string{creator, counterparty} {
		w := f.request(token, "GET", "/api/transfers?status="+r.Status, "")
		var page struct {
			Records []t8Record `json:"records"`
			Total   string     `json:"total_count"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil || page.Total != "1" || len(page.Records) != 1 || len(page.Records[0].Activity) != 0 {
			t.Fatal("terminal participant list")
		}
		page.Records[0].Activity = r.Activity
		if !reflect.DeepEqual(page.Records[0], r) {
			t.Fatal("terminal list changed business evidence")
		}
		w = f.request(token, "GET", "/api/transfers/counts", "")
		var counts struct {
			Pending string `json:"pending_total"`
			Actions string `json:"action_count"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &counts) != nil || counts.Pending != "0" || counts.Actions != "0" {
			t.Fatal("terminal action counters not cleared")
		}
	}
}
func t8TerminalActor(t *testing.T, f *t5Fixture, token, action string, before, after t8Record) {
	t.Helper()
	if len(after.Activity) != len(before.Activity)+1 || !reflect.DeepEqual(after.Activity[:len(before.Activity)], before.Activity) {
		t.Fatal("terminal mutation changed prior personal history")
	}
	a := t8Identity(t, f, token)
	e := after.Activity[len(before.Activity)]
	if e.Category != "transfer" || e.Action != action || e.Actor.AccountID != strconv.Itoa(a.AccountID) || e.Actor.Username != a.Username || e.Actor.DisplayName != a.DisplayName || e.LocationID != a.Location.ID || e.LocationName != a.Location.Name || e.RecordedAt.IsZero() {
		t.Fatal("terminal personal actor snapshot")
	}
}
func TestT8NewBranchCancellation(t *testing.T) {
	for _, approved := range []bool{false, true} {
		t.Run(fmt.Sprintf("approved_%t", approved), func(t *testing.T) {
			f, token, _ := t8Setup(t)
			creator, other, origin, destination := token, f.tokens[0], 1, 4
			originStock, destinationStock := int64(20), int64(0)
			if approved {
				t8Lifecycle(t, f, token, f.tokens[0], token, "request_stock", 1, 1, 4, "t8-cancel-funding-01")
				creator, other, origin, destination = f.tokens[1], token, 4, 2
				originStock, destinationStock = 2, 20
			}
			body := t8Body("request_stock", origin, "t8-cancel-dynamic-01")
			r := t8Decode(t, f.request(creator, "POST", "/api/transfers", body), 201)
			if r.Status != "pending" {
				t.Fatal("cancellation request setup")
			}
			t8Stock(t, f, origin, originStock, 0)
			t8Stock(t, f, destination, destinationStock, 0)
			path := "/api/transfers/" + r.ID
			if approved {
				r = t8Decode(t, f.request(other, "POST", path+"/approve", "{}"), 200)
				if r.Status != "approved" || r.DecisionLocation == nil || *r.DecisionLocation != 4 {
					t.Fatal("new branch approval evidence")
				}
				t8Stock(t, f, origin, originStock, 2)
			}
			// Only the creator may cancel; no new warehouse/counterparty authority.
			t5Error(t, f.request(other, "POST", path+"/cancel", "{}"), 403, "forbidden")
			cancelled := t8Decode(t, f.request(creator, "POST", path+"/cancel", "{}"), 200)
			creatorIdentity := t8Identity(t, f, creator)
			if cancelled.Status != "cancelled" || cancelled.CancellationLocation == nil || *cancelled.CancellationLocation != creatorIdentity.Location.ID || cancelled.CancelledAt == nil {
				t.Fatal("cancellation location/time")
			}
			if !reflect.DeepEqual(cancelled.DecisionLocation, r.DecisionLocation) || !reflect.DeepEqual(cancelled.DecidedAt, r.DecidedAt) {
				t.Fatal("cancellation rewrote approval history")
			}
			t8TerminalActor(t, f, creator, "cancel", r, cancelled)
			t8Stock(t, f, origin, originStock, 0)
			t8Stock(t, f, destination, destinationStock, 0)
			t8TerminalRecovery(t, f, creator, other, body, "cancel", cancelled)
			t8Stock(t, f, origin, originStock, 0)
			t8Stock(t, f, destination, destinationStock, 0)
		})
	}
}
func TestT8NewBranchRejection(t *testing.T) {
	f, token, _ := t8Setup(t)
	t8Lifecycle(t, f, token, f.tokens[0], token, "request_stock", 1, 1, 4, "t8-reject-funding-01")
	body := t8Body("request_stock", 4, "t8-reject-dynamic-01")
	r := t8Decode(t, f.request(f.tokens[1], "POST", "/api/transfers", body), 201)
	if r.Status != "pending" {
		t.Fatal("rejection request setup")
	}
	t8Stock(t, f, 4, 2, 0)
	t8Stock(t, f, 2, 20, 0)
	rejected := t8Decode(t, f.request(token, "POST", "/api/transfers/"+r.ID+"/reject", "{}"), 200)
	if rejected.Status != "rejected" || rejected.DecisionLocation == nil || *rejected.DecisionLocation != 4 || rejected.DecidedAt == nil {
		t.Fatal("new branch rejection evidence")
	}
	t8TerminalActor(t, f, token, "reject", r, rejected)
	t8TerminalRecovery(t, f, f.tokens[1], token, body, "reject", rejected)
	t8Stock(t, f, 4, 2, 0)
	t8Stock(t, f, 2, 20, 0)
}

// Existing destination remains valid through the same collection decoder/DTO.
func TestT8ExistingDirectShipmentPreserved(t *testing.T) {
	f, _, _ := t8Setup(t)
	t8Lifecycle(t, f, f.tokens[0], f.tokens[0], f.tokens[1], "direct_shipment", 2, 1, 2, "t8-existing-direct-01")
	t8Stock(t, f, 1, 18, 0)
	t8Stock(t, f, 2, 22, 0)
}
