package httpapi

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

const receiptExactBody = `{"items":[{"variant_id":1,"actual_quantity":"1"},{"variant_id":2,"actual_quantity":"1"}]}`

// Mutation responses are audited by an exact stock proof before accepting a
// new fixture baseline; passive f.serve deliberately forbids balance changes.
func receiptHTTPMutation(f *transferHTTPFixture, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	return w
}

func receiptHTTPDispatch(t *testing.T, f *transferHTTPFixture, kind string, counterparty int) transferDTO {
	t.Helper()
	original := decisionCreate(t, f, kind, counterparty, "receipt-http-create-001")
	path := "/api/transfers/" + original.ID
	w := decisionServe(t, f, f.newRequest(original.ApproverLocationID, "POST", path+"/approve", "{}"), original)
	var approved transferDTO
	if json.Unmarshal(w.Body.Bytes(), &approved) != nil {
		t.Fatal("receipt approval decode")
	}
	proof := dispatchProof(t, f, approved)
	w = receiptHTTPMutation(f, f.newRequest(original.OriginLocationID, "POST", path+"/dispatch", "{}"))
	proof(w)
	var transit transferDTO
	if json.Unmarshal(w.Body.Bytes(), &transit) != nil {
		t.Fatal("receipt transit decode")
	}
	return transit
}

func receiptHTTPProof(t *testing.T, f *transferHTTPFixture, transit transferDTO, credit1, credit2 int64) func(*httptest.ResponseRecorder) {
	t.Helper()
	original, allocations := decisionRows(t, f, transit.ID)
	var expected string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object(
 'existing',b.existing+CASE WHEN location_id=$1 AND variant_id=1 THEN $2::bigint WHEN location_id=$1 AND variant_id=2 THEN $3::bigint ELSE 0 END,
 'available',b.available+CASE WHEN location_id=$1 AND variant_id=1 THEN $2::bigint WHEN location_id=$1 AND variant_id=2 THEN $3::bigint ELSE 0 END) ORDER BY location_id,variant_id)::text FROM inventory_balances b`, transit.DestinationLocationID, credit1, credit2).Scan(&expected) != nil {
		t.Fatal("receipt expected stock construction")
	}
	return func(w *httptest.ResponseRecorder) {
		got := transferObject(t, w, 200)
		if transferBusinessFieldCount(t, got) != 21 || string(got["status"]) != `"received"` {
			t.Fatal("incomplete received wire record")
		}
		var result transferDTO
		if json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Receipt == nil || result.ReceiptLocationID == nil || *result.ReceiptLocationID != transit.DestinationLocationID || result.ReceivedAt == nil {
			t.Fatal("receipt metadata missing")
		}
		stamp, err := time.Parse(time.RFC3339Nano, *result.ReceivedAt)
		dispatch, dispatchErr := time.Parse(time.RFC3339Nano, *transit.DispatchedAt)
		if err != nil || dispatchErr != nil || stamp.Before(dispatch) {
			t.Fatal("receipt time not server ordered")
		}
		want := transit
		want.Status, want.ReceiptLocationID, want.ReceivedAt, want.Receipt = "received", result.ReceiptLocationID, result.ReceivedAt, result.Receipt
		assertTransferActivityAppend(t, transit, result, "receive", transit.DestinationLocationID)
		if !reflect.DeepEqual(transferBusinessDTO(want), transferBusinessDTO(result)) {
			t.Fatal("receipt changed original items/decision/dispatch")
		}
		gotOriginal, gotAllocations := decisionRows(t, f, transit.ID)
		if gotOriginal != original || gotAllocations != allocations || f.stock(t) != expected {
			t.Fatal("receipt credited exceptions, changed reserved or original ownership")
		}
		f.baseline = expected
	}
}

func receiptHTTPState(t *testing.T, f *transferHTTPFixture) string {
	t.Helper()
	var got string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_build_array(
 (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY request_id,variant_id),'[]') FROM transfer_receipt_lines l),
 (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY request_id,variant_id,kind),'[]') FROM transfer_receipt_exceptions e))::text`).Scan(&got) != nil {
		t.Fatal("receipt HTTP state snapshot")
	}
	return fenceSnapshot(t, f) + got
}

func TestR1ReceiveHTTPAdmission(t *testing.T) {
	f := transferFixture(t)
	original := decisionCreate(t, f, "request_stock", 1, "receipt-route-red-001")
	path := "/api/transfers/" + original.ID + "/receive"
	expectTransferError(t, f.request(t, 2, "GET", path, ""), 405, "method_not_allowed")
	expectTransferError(t, f.request(t, 0, "POST", path, `{"items":[{"variant_id":1,"actual_quantity":"1"}]}`), 401, "unauthenticated")
}

func TestR1ReceiptDecoder(t *testing.T) {
	decode := func(body string) (transfers.ReceiptInput, error) {
		r := httptest.NewRequest("POST", "/api/transfers/1/receive", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		return decodeTransferReceipt(r)
	}
	valid := `{"items":[{"actual_quantity":"9223372036854775807","variant_id":3},{"variant_id":1,"actual_quantity":"0"},{"variant_id":2,"actual_quantity":"9223372036854775807"}]}`
	got, err := decode(valid)
	if err != nil || !reflect.DeepEqual(got.Items, []transfers.Line{{VariantID: 1, Quantity: 0}, {VariantID: 2, Quantity: math.MaxInt64}, {VariantID: 3, Quantity: math.MaxInt64}}) {
		t.Fatal("canonical receipt decoder", err)
	}
	for name, body := range map[string]string{
		"null": "null", "array": "[]", "empty": "{}", "empty_items": `{"items":[]}`, "all_zero": `{"items":[{"variant_id":1,"actual_quantity":"0"}]}`,
		"unknown_top": strings.Replace(receiptExactBody, "{", `{"actor":2,`, 1), "time": strings.Replace(receiptExactBody, "{", `{"received_at":"2026-01-01T00:00:00Z",`, 1),
		"duplicate_top":     strings.TrimSuffix(receiptExactBody, "}") + `,"items":[]}`,
		"escaped_duplicate": strings.Replace(receiptExactBody, `"variant_id":1`, `"variant_id":1,"variant_\u0069d":1`, 1),
		"duplicate_variant": strings.Replace(receiptExactBody, `"variant_id":2`, `"variant_id":1`, 1),
		"quantity_alias":    strings.Replace(receiptExactBody, "actual_quantity", "quantity", 1), "missing_actual": `{"items":[{"variant_id":1}]}`,
		"trailing": receiptExactBody + "{}", "invalid_utf8": receiptExactBody + string([]byte{255}), "over_limit": strings.Repeat(" ", 64<<10) + receiptExactBody,
		"unexpected_field": strings.Replace(receiptExactBody, `"variant_id":1`, `"variant_id":1,"actor":2`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decode(body); err != transfers.ErrInvalid {
				t.Fatal("malformed framing admitted", err)
			}
		})
	}
	for _, quantity := range []string{`"00"`, `"01"`, `"-0"`, `"-1"`, `"+1"`, `"1.0"`, `"1e0"`, `" 1"`, `"1 "`, `"9223372036854775808"`, `1`, `0`, `1.0`, `1e0`, `null`, `true`} {
		body := strings.Replace(receiptExactBody, `"actual_quantity":"1"`, `"actual_quantity":`+quantity, 1)
		if _, err := decode(body); err != transfers.ErrInvalid {
			t.Fatal("noncanonical actual admitted", quantity, err)
		}
	}
	for _, variant := range []string{`"1"`, `0`, `-1`, `01`, `1.0`, `1e0`, `2147483648`, `true`, `null`} {
		body := strings.Replace(receiptExactBody, `"variant_id":1`, `"variant_id":`+variant, 1)
		if _, err := decode(body); err != transfers.ErrInvalid {
			t.Fatal("variant parser diverged", variant, err)
		}
	}
	for _, contentType := range []string{"", "text/plain", "application/json;", "application/json; charset=utf-8; charset=utf-8", "application/json; charset=latin1", "application/json; other=x"} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(receiptExactBody))
		r.Header.Set("Content-Type", contentType)
		if _, err := decodeTransferReceipt(r); err != transfers.ErrInvalid {
			t.Fatal("ambiguous media admitted", contentType, err)
		}
	}
	r := httptest.NewRequest("POST", "/", strings.NewReader(receiptExactBody))
	r.Header.Add("Content-Type", "application/json")
	r.Header.Add("Content-Type", "application/json")
	if _, err := decodeTransferReceipt(r); err != transfers.ErrInvalid {
		t.Fatal("duplicate content type admitted")
	}
	r.Header = http.Header{"Content-Type": []string{"application/json; charset=UTF-8"}}
	if _, err := decodeTransferReceipt(r); err != nil {
		t.Fatal("admitted UTF-8 charset refused")
	}
	parts := make([]string, 190)
	for i := range parts {
		parts[i] = fmt.Sprintf(`{"variant_id":%d,"actual_quantity":"1"}`, i+1)
	}
	if got, err := decode(`{"items":[` + strings.Join(parts, ",") + `]}`); err != nil || len(got.Items) != 190 {
		t.Fatal("full catalog receipt framing refused", err)
	}
}

func TestR1ReceiveHTTP(t *testing.T) {
	for _, flow := range []struct {
		name, kind   string
		counterparty int
	}{{"warehouse_request", "request_stock", 1}, {"branch_request", "request_stock", 3}, {"warehouse_proposal", "send_to_warehouse", 1}} {
		t.Run(flow.name, func(t *testing.T) {
			f := transferFixture(t)
			transit := receiptHTTPDispatch(t, f, flow.kind, flow.counterparty)
			path := "/api/transfers/" + transit.ID
			before := receiptHTTPState(t, f)
			for _, tc := range []struct {
				actor                int
				method, suffix, body string
				status               int
				code                 string
			}{
				{0, "POST", "/receive", receiptExactBody, 401, "unauthenticated"},
				{transit.OriginLocationID, "POST", "/receive", receiptExactBody, 403, "forbidden"},
				{6 - transit.OriginLocationID - transit.DestinationLocationID, "POST", "/receive", receiptExactBody, 404, "not_found"},
				{transit.DestinationLocationID, "GET", "/receive", "", 405, "method_not_allowed"},
				{transit.DestinationLocationID, "POST", "/receive?", receiptExactBody, 400, "invalid_request"},
				{transit.DestinationLocationID, "POST", "/receive", `{"items":[{"variant_id":1,"actual_quantity":"1"}]}`, 400, "invalid_request"},
				{transit.DestinationLocationID, "POST", "/receive", `{"items":[{"variant_id":1,"actual_quantity":"1"},{"variant_id":2,"actual_quantity":"1"},{"variant_id":191,"actual_quantity":"1"}]}`, 400, "invalid_request"},
			} {
				expectTransferError(t, f.request(t, tc.actor, tc.method, path+tc.suffix, tc.body), tc.status, tc.code)
			}
			for _, header := range []string{"Origin", "X-CSRF-Token", "Sec-Fetch-Site"} {
				r := f.newRequest(transit.DestinationLocationID, "POST", path+"/receive", receiptExactBody)
				r.Header.Set(header, "wrong")
				expectTransferError(t, f.serve(t, r), 403, "forbidden")
			}
			if before != receiptHTTPState(t, f) {
				t.Fatal("receipt admission leaked writes")
			}
			body := `{"items":[{"variant_id":3,"actual_quantity":"7"},{"variant_id":1,"actual_quantity":"0"},{"variant_id":2,"actual_quantity":"3"}]}`
			proof := receiptHTTPProof(t, f, transit, 0, 1)
			w := receiptHTTPMutation(f, f.newRequest(transit.DestinationLocationID, "POST", path+"/receive", body))
			proof(w)
			want := transferObject(t, w, 200)
			var dto transferDTO
			if json.Unmarshal(w.Body.Bytes(), &dto) != nil || !reflect.DeepEqual(dto.Receipt, &receiptDTO{Items: []receiptLineDTO{{1, "1", "0", "0"}, {2, "1", "3", "1"}, {3, "0", "7", "0"}}, Exceptions: []receiptExceptionDTO{{1, "shortage", "1"}, {2, "excess", "2"}, {3, "unexpected", "7"}}}) {
				t.Fatal("wire receipt line/exception truth mismatch")
			}
			settled := receiptHTTPState(t, f)
			retryBody := `{"items":[{"variant_id":2,"actual_quantity":"3"},{"variant_id":3,"actual_quantity":"7"},{"variant_id":1,"actual_quantity":"0"}]}`
			for _, call := range []struct {
				actor                int
				method, suffix, body string
			}{
				{transit.DestinationLocationID, "POST", "/receive", retryBody}, {transit.OriginLocationID, "POST", "/dispatch", "{}"}, {transit.ApproverLocationID, "POST", "/approve", "{}"},
				{transit.DestinationLocationID, "GET", "", ""}, {transit.OriginLocationID, "GET", "", ""},
			} {
				if !reflect.DeepEqual(transferObject(t, f.request(t, call.actor, call.method, path+call.suffix, call.body), 200), want) {
					t.Fatal("received retry/detail recovery changed DTO")
				}
			}
			for _, actor := range []int{transit.DestinationLocationID, transit.OriginLocationID} {
				page := transferObject(t, f.request(t, actor, "GET", "/api/transfers?status=received", ""), 200)
				var records []map[string]json.RawMessage
				if json.Unmarshal(page["records"], &records) != nil || string(page["total_count"]) != `"1"` || len(records) != 1 || !transferListedObjectEqual(t, records[0], want) {
					t.Fatal("received list differs from detail")
				}
			}
			replay := fmt.Sprintf(`{"kind":%q,"counterparty_location_id":%d,"retry_key":"receipt-http-create-001","items":[{"variant_id":1,"quantity":"1"},{"variant_id":2,"quantity":"1"}]}`, flow.kind, flow.counterparty)
			if !reflect.DeepEqual(transferObject(t, f.request(t, 2, "POST", "/api/transfers", replay), 200), want) {
				t.Fatal("received creation replay differs")
			}
			expectTransferError(t, f.request(t, transit.DestinationLocationID, "POST", path+"/receive", strings.Replace(retryBody, `"3"`, `"4"`, 1)), 409, "retry_conflict")
			expectTransferError(t, f.request(t, transit.OriginLocationID, "POST", path+"/receive", retryBody), 403, "forbidden")
			expectTransferError(t, f.request(t, transit.ApproverLocationID, "POST", path+"/reject", "{}"), 409, "decision_conflict")
			if receiptHTTPState(t, f) != settled {
				t.Fatal("received read/retry/conflict mutated persistence")
			}
		})
	}
}

func TestR1ReceiptWireFence(t *testing.T) {
	q, err := transferQuery("status=received")
	if err != nil || q.Status != "received" {
		t.Fatal("received filter refused", err)
	}
	now := time.Now().UTC()
	origin, destination := 1, 2
	r := transfers.Request{
		Status: "received", CreatedAt: now.Add(-time.Hour),
		Origin: transfers.Location{ID: origin}, Destination: transfers.Location{ID: destination},
		Approver:           transfers.Location{ID: origin},
		DecisionLocationID: &origin, DecidedAt: &now,
		DispatchLocationID: &origin, DispatchedAt: &now,
		ReceiptLocationID: &destination, ReceivedAt: &now,
		Items: []transfers.Item{{VariantID: 1, Quantity: 1}},
		Receipt: &transfers.Receipt{
			Items:      []transfers.ReceiptLine{{VariantID: 1, ExpectedQuantity: 1, ActualQuantity: 1, AvailableQuantity: 1}},
			Exceptions: []transfers.ReceiptException{},
		},
	}
	if _, err := transferRecord(r); err != nil {
		t.Fatal("complete receipt wire refused", err)
	}
	for _, mutate := range []func(*transfers.Request){
		func(r *transfers.Request) { r.Receipt = nil }, func(r *transfers.Request) { r.ReceiptLocationID = &origin }, func(r *transfers.Request) { r.ReceivedAt = nil },
		func(r *transfers.Request) { earlier := now.Add(-time.Second); r.ReceivedAt = &earlier }, func(r *transfers.Request) { r.DispatchedAt = nil },
		func(r *transfers.Request) { r.Status = "in_transit" }, func(r *transfers.Request) { r.DecidedAt = nil },
	} {
		bad := r
		mutate(&bad)
		if _, err := transferRecord(bad); err == nil {
			t.Fatal("incomplete receipt leaked wire outcome")
		}
	}
}
