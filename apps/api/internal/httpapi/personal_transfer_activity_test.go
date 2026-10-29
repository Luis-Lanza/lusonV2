package httpapi

import (
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Preserve exact legacy whitelists while admitting exactly one optional field.
// This validates evidence without deleting it from the response map.
func transferBusinessFieldCount(t *testing.T, obj map[string]json.RawMessage) int {
	t.Helper()
	raw, exists := obj["activity"]
	if !exists {
		return len(obj)
	}
	var entries []map[string]json.RawMessage
	if json.Unmarshal(raw, &entries) != nil || len(entries) == 0 {
		t.Fatal("invalid personal activity")
	}
	var origin, destination int
	if json.Unmarshal(obj["origin_location_id"], &origin) != nil || json.Unmarshal(obj["destination_location_id"], &destination) != nil {
		t.Fatal("activity without physical endpoints")
	}
	for _, entry := range entries {
		expected := 6
		if entry["variant_id"] != nil {
			expected++
		}
		if len(entry) != expected {
			t.Fatal("personal activity whitelist changed")
		}
		for _, key := range []string{"category", "action", "actor", "location_id", "location_name", "recorded_at"} {
			if entry[key] == nil {
				t.Fatal("incomplete personal activity", key)
			}
		}
		// Six required fields; optional variant belongs only to workflow operations.
		if entry["variant_id"] == nil && len(entry) != 6 {
			t.Fatal("lifecycle activity fields")
		}
		var category, action, locationName, stamp string
		var location int
		if json.Unmarshal(entry["category"], &category) != nil || json.Unmarshal(entry["action"], &action) != nil || json.Unmarshal(entry["location_id"], &location) != nil || json.Unmarshal(entry["location_name"], &locationName) != nil || locationName == "" || (location != origin && location != destination) || json.Unmarshal(entry["recorded_at"], &stamp) != nil {
			t.Fatal("invalid activity metadata")
		}
		allowed := map[string]bool{"propose": true, "accept": true, "reject": true}
		if category == "transfer" {
			allowed = map[string]bool{"create": true, "approve": true, "reject": true, "dispatch": true, "receive": true, "cancel": true}
		} else if category != "count" && category != "restitution" && category != "reconciliation" {
			t.Fatal("unknown activity category")
		}
		if !allowed[action] || (category == "transfer") != (entry["variant_id"] == nil) {
			t.Fatal("invalid recorded action")
		}
		parsed, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil || parsed.UTC().Format(time.RFC3339Nano) != stamp {
			t.Fatal("noncanonical activity time")
		}
		var person map[string]json.RawMessage
		if json.Unmarshal(entry["actor"], &person) != nil || len(person) != 3 {
			t.Fatal("actor whitelist changed")
		}
		var account, username, display string
		if json.Unmarshal(person["account_id"], &account) != nil || json.Unmarshal(person["username"], &username) != nil || username == "" || json.Unmarshal(person["display_name"], &display) != nil {
			t.Fatal("incomplete actor snapshot")
		}
		id, err := strconv.ParseInt(account, 10, 64)
		if err != nil || id <= 0 || strconv.FormatInt(id, 10) != account {
			t.Fatal("noncanonical personal account")
		}
	}
	return len(obj) - 1
}

// Explicit detail/list business projections. Replays still compare full DTOs.
func transferBusinessDTO(r transferDTO) transferDTO { r.Activity = nil; return r }
func transferListDTOsEqual(t *testing.T, listed, details []transferDTO) bool {
	t.Helper()
	if len(listed) != len(details) {
		return false
	}
	for i := range listed {
		if listed[i].Activity != nil {
			t.Fatal("list loaded personal operation history")
		}
		if !reflect.DeepEqual(listed[i], transferBusinessDTO(details[i])) {
			return false
		}
	}
	return true
}
func transferListedObjectEqual(t *testing.T, listed, detail map[string]json.RawMessage) bool {
	t.Helper()
	if _, exists := listed["activity"]; exists {
		t.Fatal("list exposed activity history")
	}
	transferBusinessFieldCount(t, detail)
	business := make(map[string]json.RawMessage, len(detail))
	for key, value := range detail {
		if key != "activity" {
			business[key] = value
		}
	}
	return reflect.DeepEqual(listed, business)
}
func assertTransferActivityAppend(t *testing.T, before, after transferDTO, action string, physical int) {
	t.Helper()
	if len(after.Activity) != len(before.Activity)+1 || (len(before.Activity) > 0 && !reflect.DeepEqual(after.Activity[:len(before.Activity)], before.Activity)) {
		t.Fatal("operation replaced prior personal evidence")
	}
	e := after.Activity[len(before.Activity)]
	if e.Category != "transfer" || e.Action != action || e.LocationID != physical || e.Actor.AccountID != strconv.Itoa(physical) || e.Actor.Username == "" || e.RecordedAt.IsZero() {
		t.Fatal("incorrect appended fixture actor", e)
	}
}

func TestT10PersonalTransferHTTP(t *testing.T) {
	f := transferFixture(t)
	if _, err := f.p.Exec(f.ctx, `UPDATE auth_accounts SET display_name='Ana' WHERE id=2`); err != nil {
		t.Fatal(err)
	}
	created := f.request(t, 2, "POST", "/api/transfers", validTransferJSON)
	original := transferWireRecord(t, created, 201)
	if len(original.Activity) != 1 || original.Activity[0].Actor.AccountID != "2" || original.Activity[0].Actor.DisplayName != "Ana" {
		t.Fatal("authenticated actor missing", original.Activity)
	}
	path := "/api/transfers/" + original.ID
	before := fenceSnapshot(t, f)
	for _, body := range []string{strings.Replace(validTransferJSON, `"kind":`, `"actor":{"account_id":"1"},"kind":`, 1), strings.Replace(validTransferJSON, `"kind":`, `"activity":[],"kind":`, 1)} {
		expectTransferError(t, f.request(t, 2, "POST", "/api/transfers", body), 400, "invalid_request")
	}
	expectTransferError(t, f.request(t, 3, "GET", path, ""), 404, "not_found")
	for _, suffix := range []string{"/count-corrections", "/restitutions", "/dispatch-reconciliations"} {
		expectTransferError(t, f.request(t, 3, "GET", path+suffix, ""), 404, "not_found")
	}
	if fenceSnapshot(t, f) != before {
		t.Fatal("spoof/privacy rejection changed public business state")
	}
	recovered := transferWireRecord(t, f.request(t, 1, "GET", path, ""), 200)
	if !reflect.DeepEqual(original, recovered) {
		t.Fatal("rejected input changed evidence")
	}
	replay := transferWireRecord(t, f.request(t, 2, "POST", "/api/transfers", validTransferJSON), 200)
	if !reflect.DeepEqual(original, replay) {
		t.Fatal("HTTP replay reassigned evidence")
	}
	_, listed := transferWirePage(t, f.request(t, 2, "GET", "/api/transfers", ""))
	if !transferListDTOsEqual(t, listed, []transferDTO{original}) {
		t.Fatal("list business projection changed")
	}
	cancelled := transferObject(t, f.request(t, 2, "POST", path+"/cancel", "{}"), 200)
	transferBusinessFieldCount(t, cancelled)
	var cancellation transferDTO
	raw, _ := json.Marshal(cancelled)
	if json.Unmarshal(raw, &cancellation) != nil {
		t.Fatal("cancellation decoding")
	}
	assertTransferActivityAppend(t, original, cancellation, "cancel", 2)
}

func TestT10LifecycleCompatibilityHTTP(t *testing.T) {
	f := transferFixture(t)
	transit := receiptHTTPDispatch(t, f, "request_stock", 1)
	proof := receiptHTTPProof(t, f, transit, 1, 1)
	response := receiptHTTPMutation(f, f.newRequest(2, "POST", "/api/transfers/"+transit.ID+"/receive", receiptExactBody))
	proof(response)
	var detail transferDTO
	if json.Unmarshal(response.Body.Bytes(), &detail) != nil {
		t.Fatal("received detail")
	}
	page := transferObject(t, f.request(t, 2, "GET", "/api/transfers?status=received", ""), 200)
	var records []transferDTO
	if json.Unmarshal(page["records"], &records) != nil || !transferListDTOsEqual(t, records, []transferDTO{detail}) {
		t.Fatal("received list projection changed")
	}
	recovered := f.request(t, 2, "GET", "/api/transfers/"+detail.ID, "")
	replay := f.request(t, 2, "POST", "/api/transfers/"+detail.ID+"/receive", receiptExactBody)
	if recovered.Body.String() != response.Body.String() || replay.Body.String() != response.Body.String() {
		t.Fatal("receipt replay lost exact activity")
	}
	rejected := decisionCreate(t, f, "request_stock", 1, "t10-reject-compatibility")
	decisionServe(t, f, f.newRequest(1, "POST", "/api/transfers/"+rejected.ID+"/reject", "{}"), rejected)
}
func TestT10DirectCompatibilityHTTP(t *testing.T) {
	f := transferFixture(t)
	proof := w01HTTPProof(t, f, 2)
	response := receiptHTTPMutation(f, f.newRequest(1, "POST", "/api/transfers", w01HTTPBody(2)))
	created := proof(response)
	dispatch := dispatchProof(t, f, created)
	response = receiptHTTPMutation(f, f.newRequest(1, "POST", "/api/transfers/"+created.ID+"/dispatch", "{}"))
	dispatch(response)
	var transit transferDTO
	if json.Unmarshal(response.Body.Bytes(), &transit) != nil {
		t.Fatal("direct dispatch")
	}
	receive := receiptHTTPProof(t, f, transit, 2, 1)
	response = receiptHTTPMutation(f, f.newRequest(2, "POST", "/api/transfers/"+created.ID+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"2"},{"variant_id":2,"actual_quantity":"1"}]}`))
	receive(response)
}

func TestT10PersonalRollbackHTTP(t *testing.T) {
	f := transferFixture(t)
	before := fenceSnapshot(t, f)
	publicStock := dr3Inventory(t, f)
	counts := f.request(t, 2, "GET", "/api/transfers/counts", "").Body.String()
	// A deferred error happens after personal evidence has been inserted.
	decisionExec(t, f, `CREATE FUNCTION t10_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; END $$;
 CREATE CONSTRAINT TRIGGER t10_fail_commit AFTER INSERT ON transfer_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION t10_fail_commit()`)
	expectTransferError(t, f.request(t, 2, "POST", "/api/transfers", validTransferJSON), 503, "service_unavailable")
	if fenceSnapshot(t, f) != before || !reflect.DeepEqual(publicStock, dr3Inventory(t, f)) || f.request(t, 2, "GET", "/api/transfers/counts", "").Body.String() != counts {
		t.Fatal("rollback changed history, stock or counters")
	}
	total, listed := transferWirePage(t, f.request(t, 2, "GET", "/api/transfers", ""))
	if total != 0 || len(listed) != 0 {
		t.Fatal("rolled-back operation exposed a request")
	}
	var events int
	if f.p.QueryRow(f.ctx, `SELECT count(*) FROM transfer_personal_activity`).Scan(&events) != nil || events != 0 {
		t.Fatal("rolled-back personal evidence survived")
	}
}
