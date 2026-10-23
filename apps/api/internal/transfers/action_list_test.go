package transfers_test

import (
	"fmt"
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

func TestRequiredActionListLifecyclePagination(t *testing.T) {
	ctx, _, s := fixture(t)
	var ids []int64
	for i := 0; i < 3; i++ {
		in := input()
		in.RetryKey = fmt.Sprintf("action-list-lifecycle-%d", i)
		r := create(t, ctx, s, 2, in).Request
		ids = append(ids, r.ID)
		if i > 0 {
			if _, err := s.Approve(ctx, actor(1), r.ID); err != nil {
				t.Fatal(err)
			}
		}
		if i > 1 {
			if _, err := s.Dispatch(ctx, actor(1), r.ID); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Newer visible non-actionable rows fill an entire page for location 2.
	for i := 0; i < 11; i++ {
		in := input()
		in.RetryKey = fmt.Sprintf("action-list-newer-pending-%d", i)
		create(t, ctx, s, 2, in)
	}
	before, err := s.List(ctx, actor(2), transfers.Query{Status: "all"})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		who    int
		status string
		want   map[int64][]string
	}{
		{1, "approved", map[int64][]string{ids[1]: {"dispatch"}}},
		{2, "all", map[int64][]string{ids[2]: {"receive"}}},
		{2, "pending", map[int64][]string{}},
		{3, "all", map[int64][]string{}},
	} {
		page, err := s.List(ctx, actor(tc.who), transfers.Query{Status: tc.status, RequiresAction: true, PageSize: 10})
		if err != nil || !page.RequiresAction || page.Total != int64(len(tc.want)) || len(page.Records) != len(tc.want) || !reflect.DeepEqual(page.RequiredActions, tc.want) {
			t.Fatalf("private filtered page: %+v error=%v", page, err)
		}
		far, err := s.List(ctx, actor(tc.who), transfers.Query{Status: tc.status, RequiresAction: true, PageSize: 10, Page: 2})
		if err != nil || far.Total != page.Total || len(far.Records) != 0 || len(far.RequiredActions) != 0 {
			t.Fatal("far page changed private total")
		}
	}
	pending, err := s.List(ctx, actor(1), transfers.Query{RequiresAction: true})
	if err != nil || pending.Status != "pending" || pending.Total != 12 {
		t.Fatal("default pending approval filter changed")
	}
	for _, reasons := range pending.RequiredActions {
		if !reflect.DeepEqual(reasons, []string{"approve"}) {
			t.Fatal("approval reason differs")
		}
	}
	after, err := s.List(ctx, actor(2), transfers.Query{Status: "all"})
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("filtered reads changed public records")
	}
	for _, r := range after.Records {
		want := []string{}
		if r.ID == ids[2] {
			want = []string{"receive"}
		}
		if !reflect.DeepEqual(after.RequiredActions[r.ID], want) {
			t.Fatal("unfiltered page omitted explicit empty reasons")
		}
	}
}

func TestRequiredActionListReceivedReviews(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 2)
	s := transfers.New(p)
	check := func(want []string) {
		t.Helper()
		for who := 1; who <= 3; who++ {
			page, err := s.List(ctx, actor(who), transfers.Query{Status: "all", RequiresAction: true})
			total := int64(0)
			if who == r.Destination.ID && len(want) > 0 {
				total = 1
			}
			if err != nil || page.Total != total || int64(len(page.Records)) != total || int64(len(page.RequiredActions)) != total {
				t.Fatalf("review privacy/count: %+v %v", page, err)
			}
			if total == 1 && !reflect.DeepEqual(page.RequiredActions[r.ID], want) {
				t.Fatal("ordered reviews differ")
			}
			counts, err := s.Counts(ctx, actor(who))
			if err != nil || counts.ActionCount != total {
				t.Fatal("counts and list disagree")
			}
		}
	}
	check(nil)
	if _, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("action-list-restitution-one", 0, 1)); err != nil {
		t.Fatal(err)
	}
	check([]string{"review_restitution"})
	c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 0, 3, "action-list-count-first")
	check([]string{"review_count", "review_restitution"})
	c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 1, 3, "action-list-count-replace")
	check([]string{"review_count", "review_restitution"})
	c2StoreDecide(t, ctx, s, r, r.Destination.ID, 1, 2, true, "action-list-count-accept")
	check([]string{"review_restitution"}) // stale count pin still permits rejection
	if _, err := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("action-list-restitution-reject", 1, false)); err != nil {
		t.Fatal(err)
	}
	check(nil) // superseded undecided count proposal cannot resurface
}
