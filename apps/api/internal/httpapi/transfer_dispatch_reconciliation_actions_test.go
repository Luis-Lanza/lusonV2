package httpapi

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

func TestDRDiscoveryHTTP(t *testing.T) {
	for _, proposer := range []int{1, 2} {
		t.Run(fmt.Sprintf("proposer_%d", proposer), func(t *testing.T) {
			f := transferFixture(t)
			detail := dr3Received(t, f) // Seed through the production mutation routes.
			path := detail + "/dispatch-reconciliations"
			dr3Apply(t, f, f.newRequest(proposer, "POST", path+"/propose", dr3Body("discovery-http-proposal", "0", "7")), 0, 0)
			unchanged := dr3NoChange(t, f, path)
			defer unchanged()
			original := dr3Get(t, f, detail)
			for _, who := range []int{1, 2, 3} {
				want := "0"
				if who == 3-proposer {
					want = "1"
				}
				counts := transferObject(t, f.request(t, who, "GET", "/api/transfers/counts", ""), 200)
				var categories map[string]string
				if err := json.Unmarshal(counts["actions"], &categories); err != nil {
					t.Fatal(err)
				}
				expected := map[string]string{"approve": "0", "dispatch": "0", "receive": "0", "review_count": "0", "review_restitution": "0", "review_dispatch_reconciliation": want}
				if !reflect.DeepEqual(categories, expected) || string(counts["action_count"]) != `"`+want+`"` || string(counts["pending_total"]) != `"0"` {
					t.Errorf("actor %d counts=%s want categories=%v union=%s", who, counts, expected, want)
				}
				page := transferObject(t, f.request(t, who, "GET", "/api/transfers?status=all&requires_action=true", ""), 200)
				var reasons map[string][]string
				var records []json.RawMessage
				if json.Unmarshal(page["required_actions"], &reasons) != nil || json.Unmarshal(page["records"], &records) != nil {
					t.Fatal("invalid discovery page")
				}
				if string(page["total_count"]) != `"`+want+`"` || string(page["requires_action"]) != "true" {
					t.Errorf("actor %d filtered page=%s", who, page)
				}
				if want == "1" {
					var record transferDTO
					if json.Unmarshal([]byte(original), &record) != nil {
						t.Fatal("original receipt")
					}
					if !reflect.DeepEqual(reasons, map[string][]string{record.ID: {"review_dispatch_reconciliation"}}) || len(records) != 1 {
						t.Errorf("counterpart page lost canonical header/reason: %s", page)
					} else {
						var listed transferDTO
						if json.Unmarshal(records[0], &listed) != nil || !reflect.DeepEqual(record, listed) {
							t.Error("list changed immutable receipt")
						}
					}
				} else if len(reasons) != 0 || len(records) != 0 {
					t.Errorf("actor %d sees private/counterpart-only work", who)
				}
			}
			for _, action := range []string{"propose", "accept", "reject"} {
				// Missing CSRF rejects before decoding or mutating the seeded proposal.
				// Keep the deferred discovery snapshot assertion genuinely read-only.
				r := f.newRequest(3-proposer, "POST", path+"/"+action, "")
				r.Header.Del("X-CSRF-Token")
				r.Body = dr3UnreadBody{t}
				expectTransferError(t, receiptHTTPMutation(f, r), 403, "forbidden")
			}
			expectTransferError(t, f.request(t, 3, "GET", path, ""), 404, "not_found")
			expectTransferError(t, f.request(t, 0, "GET", "/api/transfers?status=all&requires_action=true", ""), 401, "unauthenticated")
			if dr3Get(t, f, detail) != original {
				t.Error("discovery changed original receipt")
			}
		})
	}
}
