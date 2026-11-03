package httpapi

import (
 "encoding/json"
 "fmt"
 "reflect"
 "testing"
)

func TestURHTTPActions(t *testing.T) {
 for _, proposer := range []int{1, 2} {
  t.Run(fmt.Sprint(proposer), func(t *testing.T) {
   f := transferFixture(t)
   received := countHTTPReceived(t, f)
   path := "/api/transfers/" + received.ID + "/unified-reconciliations"
   body := `{"variant_id":1,"operation_key":"ur-http-actions-propose","expected_revision":"0","dispatch_quantity":"4","arrival_quantity":"3","retained_quantity":"0","retained_at_origin":false,"reason":"verify"}`
   dr3Apply(t, f, f.newRequest(proposer, "POST", path+"/propose", body), 0, 0)
   for _, who := range []int{1, 2, 3} {
    want := "0"
    if who == 3-proposer { want = "1" }
    counts := transferObject(t, f.request(t, who, "GET", "/api/transfers/counts", ""), 200)
    var categories map[string]string
    if json.Unmarshal(counts["actions"], &categories) != nil { t.Fatal("counts") }
    expected := map[string]string{"approve":"0", "dispatch":"0", "receive":"0", "review_unified_reconciliation":want}
    if !reflect.DeepEqual(categories, expected) || string(counts["action_count"]) != `"`+want+`"` || string(counts["pending_total"]) != `"0"` { t.Errorf("actor %d counts=%s", who, counts) }
    page := transferObject(t, f.request(t, who, "GET", "/api/transfers?status=all&requires_action=true", ""), 200)
    var reasons map[string][]string
    var records []json.RawMessage
    if json.Unmarshal(page["required_actions"], &reasons) != nil || json.Unmarshal(page["records"], &records) != nil { t.Fatal("page") }
    if string(page["total_count"]) != `"`+want+`"` { t.Errorf("actor %d page=%s", who, page) }
    if want == "1" {
     if len(records) != 1 || !reflect.DeepEqual(reasons, map[string][]string{received.ID:{"review_unified_reconciliation"}}) { t.Error("counterparty reasons", reasons) }
    } else if len(records) != 0 || len(reasons) != 0 { t.Error("private or self proposal exposed", page) }
   }
  })
 }
}
