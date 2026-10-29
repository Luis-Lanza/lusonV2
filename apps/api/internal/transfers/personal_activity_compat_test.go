package transfers_test

import (
	"reflect"
	"strconv"
	"testing"

	"luson/api/internal/transfers"
)

func t10BusinessRequest(r transfers.Request) transfers.Request { r.Activity = nil; return r }
func t10ListEqual(t *testing.T, listed, details []transfers.Request) bool {
	t.Helper()
	if len(listed) != len(details) {
		return false
	}
	projected := make([]transfers.Request, len(details))
	if details == nil {
		projected = nil
	}
	for i := range details {
		if listed[i].Activity != nil {
			t.Fatal("list unexpectedly loaded personal history")
		}
		projected[i] = t10BusinessRequest(details[i])
	}
	return reflect.DeepEqual(listed, projected)
}
func t10ActivityPrefix(t *testing.T, before, after transfers.Request) {
	t.Helper()
	if len(after.Activity) < len(before.Activity) || (len(before.Activity) > 0 && !reflect.DeepEqual(before.Activity, after.Activity[:len(before.Activity)])) {
		t.Fatal("operation rewrote historical personal authorship")
	}
}
func t10ActionAppend(t *testing.T, before, after transfers.Request, action string, physical int) {
	t.Helper()
	t10ActivityPrefix(t, before, after)
	if len(after.Activity) != len(before.Activity)+1 {
		t.Fatal("action did not append exactly one personal author")
	}
	e := after.Activity[len(before.Activity)]
	if e.Category != "transfer" || e.Action != action || e.LocationID != physical || e.Actor.AccountID != strconv.Itoa(physical) || e.Actor.Username == "" || e.RecordedAt.IsZero() {
		t.Fatal("incorrect action actor", e)
	}
}
func t10WorkflowDetailEqual(t *testing.T, after, before transfers.Request) bool {
	t.Helper()
	t10ActivityPrefix(t, before, after)
	return reflect.DeepEqual(t10BusinessRequest(after), t10BusinessRequest(before))
}
