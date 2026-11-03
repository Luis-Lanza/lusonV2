package httpapi

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// TestDRDiscoveryHTTP proves that historical dispatch audit evidence creates no
// pending list or count work. The legacy HTTP routes are retired, so the proposal
// is seeded through the retained SQL writer the retired handler called.
func TestDRDiscoveryHTTP(t *testing.T) {
	for _, proposer := range []int{1, 2} {
		t.Run(fmt.Sprintf("proposer_%d", proposer), func(t *testing.T) {
			f := transferFixture(t)
			detail := dr3Received(t, f) // Seed through the production mutation routes.
			id := strings.TrimPrefix(detail, "/api/transfers/")
			original := dr3Get(t, f, detail)
			var revision int
			if err := f.p.QueryRow(f.ctx, `SELECT revision FROM transfer_dispatch_reconcile($1::bigint,1::integer,$2::smallint,'discovery-http-proposal','propose',0::bigint,7::bigint,'discovery evidence')`, id, proposer).Scan(&revision); err != nil || revision != 1 {
				t.Fatal("historical dispatch proposal", err)
			}
			// S7 retires the dispatch audit flow: the proposal stays as history,
			// yet no participant discovers list or count work from it.
			for _, who := range []int{1, 2, 3} {
				counts := transferObject(t, f.request(t, who, "GET", "/api/transfers/counts", ""), 200)
				var categories map[string]string
				if err := json.Unmarshal(counts["actions"], &categories); err != nil {
					t.Fatal(err)
				}
				expected := map[string]string{"approve": "0", "dispatch": "0", "receive": "0", "review_unified_reconciliation": "0"}
				if !reflect.DeepEqual(categories, expected) || string(counts["action_count"]) != `"0"` || string(counts["pending_total"]) != `"0"` {
					t.Errorf("actor %d counts=%s want categories=%v union=0", who, counts, expected)
				}
				page := transferObject(t, f.request(t, who, "GET", "/api/transfers?status=all&requires_action=true", ""), 200)
				if string(page["total_count"]) != `"0"` || string(page["requires_action"]) != "true" || string(page["records"]) != `[]` || string(page["required_actions"]) != `{}` {
					t.Errorf("actor %d filtered page=%s", who, page)
				}
			}
			expectTransferError(t, f.request(t, 0, "GET", "/api/transfers?status=all&requires_action=true", ""), 401, "unauthenticated")
			if dr3Get(t, f, detail) != original {
				t.Error("discovery changed original receipt")
			}
		})
	}
}
