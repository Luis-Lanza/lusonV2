package httpapi

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestR1WorkflowCountsHTTP(t *testing.T) {
	for _, flow := range []struct {
		name, kind   string
		counterparty int
	}{{"warehouse_request", "request_stock", 1}, {"branch_request", "request_stock", 3}, {"warehouse_proposal", "send_to_warehouse", 1}} {
		t.Run(flow.name, func(t *testing.T) {
			f := transferFixture(t)
			original := decisionCreate(t, f, flow.kind, flow.counterparty, "receipt-count-create-001")
			path := "/api/transfers/" + original.ID
			check := func(status string) {
				t.Helper()
				before := receiptHTTPState(t, f)
				for actor := 1; actor <= 3; actor++ {
					pending, action := `"0"`, `"0"`
					if status == "pending" && (actor == original.OriginLocationID || actor == original.DestinationLocationID) {
						pending = `"1"`
					}
					if (status == "pending" && actor == original.ApproverLocationID) || (status == "approved" && actor == original.OriginLocationID) || (status == "in_transit" && actor == original.DestinationLocationID) {
						action = `"1"`
					}
					got := transferObject(t, f.request(t, actor, "GET", "/api/transfers/counts", ""), 200)
					if len(got) != 3 || string(got["pending_total"]) != pending || string(got["action_count"]) != action {
						t.Fatalf("%s actor %d: %v", status, actor, got)
					}
				}
				if receiptHTTPState(t, f) != before {
					t.Fatal("workflow counts wrote state")
				}
			}
			check("pending")
			w := decisionServe(t, f, f.newRequest(original.ApproverLocationID, "POST", path+"/approve", "{}"), original)
			var approved transferDTO
			if json.Unmarshal(w.Body.Bytes(), &approved) != nil {
				t.Fatal("count approval decode")
			}
			check("approved")
			dispatchAudit := dispatchProof(t, f, approved)
			w = receiptHTTPMutation(f, f.newRequest(original.OriginLocationID, "POST", path+"/dispatch", "{}"))
			dispatchAudit(w)
			var transit transferDTO
			if json.Unmarshal(w.Body.Bytes(), &transit) != nil {
				t.Fatal("count transit decode")
			}
			check("in_transit")
			proof := receiptHTTPProof(t, f, transit, 1, 1)
			w = receiptHTTPMutation(f, f.newRequest(original.DestinationLocationID, "POST", path+"/receive", receiptExactBody))
			proof(w)
			want := transferObject(t, w, 200)
			check("received")
			got := f.request(t, original.DestinationLocationID, "POST", path+"/receive", receiptExactBody)
			if !reflect.DeepEqual(transferObject(t, got, 200), want) {
				t.Fatal("count retry result changed")
			}
			check("received")
		})
	}
}
