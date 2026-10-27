package httpapi

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestRequiredActionListHTTP(t *testing.T) {
	f := transferFixture(t)
	created := transferWireRecord(t, f.request(t, 2, "POST", "/api/transfers", validTransferJSON), 201)
	for _, query := range []string{"requires_action=true", "requires_action=false", "status=all&requires_action=true"} {
		w := f.request(t, 1, "GET", "/api/transfers?"+query, "")
		obj := transferObject(t, w, 200)
		if string(obj["total_count"]) != `"1"` {
			t.Fatal("action filter lost approver")
		}
		if string(obj["requires_action"]) != strings.Split(query, "requires_action=")[1] {
			t.Fatal("action filter echo differs")
		}
		var reasons map[string][]string
		if json.Unmarshal(obj["required_actions"], &reasons) != nil || len(reasons) != 1 || len(reasons[created.ID]) != 1 || reasons[created.ID][0] != "approve" {
			t.Fatal("missing ordered list reasons")
		}
	}
	for _, who := range []int{2, 3} {
		obj := transferObject(t, f.request(t, who, "GET", "/api/transfers?status=all&requires_action=true", ""), 200)
		if string(obj["total_count"]) != `"0"` || string(obj["records"]) != `[]` || string(obj["required_actions"]) != `{}` || string(obj["requires_action"]) != `true` {
			t.Fatal("private action-only empty page differs")
		}
	}
	for _, raw := range []string{"requires_action=", "requires_action=True", "requires_action=1", "requires_action=0", "requires_action=yes", "requires_action=%74rue", "%72equires_action=true", "requires_action=true&requires_action=true", "Requires_action=true"} {
		expectTransferError(t, f.request(t, 1, "GET", "/api/transfers?"+raw, ""), 400, "invalid_request")
	}
	for _, raw := range []string{"true", "false"} {
		expectTransferError(t, f.request(t, 1, "GET", "/api/transfers/counts?requires_action="+raw, ""), 400, "invalid_request")
	}
	// Rejected selectors and reads preserve immutable detail and counters.
	detail := transferWireRecord(t, f.request(t, 1, "GET", "/api/transfers/"+created.ID, ""), 200)
	if !reflect.DeepEqual(detail, created) {
		t.Fatal("read changed detail")
	}
	counts := transferObject(t, f.request(t, 1, "GET", "/api/transfers/counts", ""), 200)
	if string(counts["pending_total"]) != `"1"` || string(counts["action_count"]) != `"1"` {
		t.Fatal("read changed counters")
	}
	if string(counts["actions"]) != `{"approve":"1","dispatch":"0","receive":"0","review_count":"0","review_dispatch_reconciliation":"0","review_restitution":"0"}` {
		t.Fatal("exact category counts differ")
	}
}
