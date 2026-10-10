package transfers_test

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/transfers"
)

func receiptSnapshot(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var got string
	if p.QueryRow(ctx, `SELECT jsonb_build_array(
 (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM transfer_requests r),
 (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY request_id,variant_id),'[]') FROM transfer_request_items i),
 (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY request_id,variant_id),'[]') FROM transfer_request_allocations a),
 (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY request_id,variant_id),'[]') FROM transfer_receipt_lines l),
 (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY request_id,variant_id,kind),'[]') FROM transfer_receipt_exceptions e),
 (SELECT jsonb_agg(to_jsonb(b) ORDER BY location_id,variant_id) FROM inventory_balances b),
 (SELECT jsonb_agg(to_jsonb(v) ORDER BY scope) FROM realtime_revisions v))::text`).Scan(&got) != nil {
		t.Fatal("complete receipt snapshot failed")
	}
	return got
}
func receiptDispatch(t *testing.T, ctx context.Context, s *transfers.Store, in transfers.CreateInput) transfers.Request {
	t.Helper()
	r := create(t, ctx, s, 2, in).Request
	if _, err := s.Approve(ctx, actor(r.Approver.ID), r.ID); err != nil {
		t.Fatal("receipt approval setup", err)
	}
	got, err := s.Dispatch(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal("receipt dispatch setup", err)
	}
	return got
}
func receiptInput(r transfers.Request) transfers.ReceiptInput {
	in := transfers.ReceiptInput{Items: []transfers.Line{}}
	for _, item := range r.Items {
		in.Items = append(in.Items, transfers.Line{item.VariantID, item.Quantity})
	}
	return in
}

func TestR1ReceiptStore(t *testing.T) {
	for _, flow := range []struct {
		name         string
		kind         transfers.Kind
		counterparty int
	}{
		{"warehouse_request", transfers.RequestStock, 1}, {"branch_request", transfers.RequestStock, 3}, {"warehouse_proposal", transfers.SendToWarehouse, 1},
	} {
		t.Run(flow.name, func(t *testing.T) {
			ctx, p, s := fixture(t)
			in := input()
			in.Kind, in.CounterpartyID = flow.kind, flow.counterparty
			transit := receiptDispatch(t, ctx, s, in)
			a01Exec(t, ctx, p, "UPDATE inventory_balances SET reserved=1 WHERE location_id=$1 AND variant_id IN (1,2)", transit.Destination.ID)
			stock := stocks(t, ctx, p)
			payload := transfers.ReceiptInput{Items: []transfers.Line{{3, 7}, {2, 4}, {1, 1}}}
			before := receiptSnapshot(t, ctx, p)
			for _, tc := range []struct {
				id   int
				want error
			}{{transit.Origin.ID, transfers.ErrForbidden}, {6 - transit.Origin.ID - transit.Destination.ID, transfers.ErrNotFound}} {
				got, err := s.Receive(ctx, actor(tc.id), transit.ID, payload)
				a02Error(t, got, err, tc.want)
			}
			if before != receiptSnapshot(t, ctx, p) {
				t.Fatal("role refusals mutated receipt")
			}
			got, err := s.Receive(ctx, actor(transit.Destination.ID), transit.ID, payload)
			if err != nil {
				t.Fatal("destination receive", err)
			}
			wantReceipt := &transfers.Receipt{Items: []transfers.ReceiptLine{{1, 2, 1, 1}, {2, 1, 4, 1}, {3, 0, 7, 0}}, Exceptions: []transfers.ReceiptException{{1, "shortage", 1}, {2, "excess", 3}, {3, "unexpected", 7}}}
			if got.Status != "received" || got.ReceiptLocationID == nil || *got.ReceiptLocationID != transit.Destination.ID || got.ReceivedAt == nil || got.ReceivedAt.Before(*transit.DispatchedAt) || !reflect.DeepEqual(got.Receipt, wantReceipt) {
				t.Fatalf("receipt truth mismatch: %+v %v", got.Receipt, err)
			}
			want := transit
			want.Status, want.ReceiptLocationID, want.ReceivedAt, want.Receipt = "received", got.ReceiptLocationID, got.ReceivedAt, wantReceipt
			if !reflect.DeepEqual(got, want) {
				t.Fatal("receipt changed immutable items/approval/dispatch")
			}
			for i := range stock {
				if stock[i].Location == transit.Destination.ID && (stock[i].Variant == 1 || stock[i].Variant == 2) {
					stock[i].Existing++
					stock[i].Available++
				}
			}
			if !reflect.DeepEqual(stock, stocks(t, ctx, p)) {
				t.Fatal("expected credit, reserved or exception isolation incorrect")
			}
			settled := receiptSnapshot(t, ctx, p)
			reversed := transfers.ReceiptInput{Items: []transfers.Line{{1, 1}, {2, 4}, {3, 7}}}
			retry, err := s.Receive(ctx, actor(transit.Destination.ID), got.ID, reversed)
			if err != nil || !reflect.DeepEqual(got, retry) {
				t.Fatal("normalized retry differs", err)
			}
			reversed.Items[0].Quantity++
			retry, err = s.Receive(ctx, actor(transit.Destination.ID), got.ID, reversed)
			a02Error(t, retry, err, transfers.ErrRetryConflict)
			retry, err = s.Receive(ctx, actor(transit.Origin.ID), got.ID, reversed)
			a02Error(t, retry, err, transfers.ErrForbidden)
			for _, participant := range []int{transit.Origin.ID, transit.Destination.ID} {
				recovered, err := s.Get(ctx, actor(participant), got.ID)
				if err != nil || !reflect.DeepEqual(got, recovered) {
					t.Fatal("participant detail recovery", err)
				}
				page, err := s.List(ctx, actor(participant), transfers.Query{Status: "received"})
				if err != nil || page.Total != 1 || len(page.Records) != 1 || !reflect.DeepEqual(got, page.Records[0]) {
					t.Fatal("received page recovery", err)
				}
				counts, err := s.Counts(ctx, actor(participant))
				if err != nil || counts != (transfers.Totals{}) {
					t.Fatal("received header is not an action", err)
				}
			}
			replay, err := s.Create(ctx, actor(2), in)
			if err != nil || !replay.Replayed || !reflect.DeepEqual(got, replay.Request) {
				t.Fatal("original creation replay", err)
			}
			retry, err = s.Approve(ctx, actor(transit.Approver.ID), got.ID)
			if err != nil || !reflect.DeepEqual(got, retry) {
				t.Fatal("received approval retry", err)
			}
			retry, err = s.Dispatch(ctx, actor(transit.Origin.ID), got.ID)
			if err != nil || !reflect.DeepEqual(got, retry) {
				t.Fatal("received dispatch retry", err)
			}
			retry, err = s.Reject(ctx, actor(transit.Approver.ID), got.ID)
			a02Error(t, retry, err, transfers.ErrDecisionConflict)
			if settled != receiptSnapshot(t, ctx, p) {
				t.Fatal("retry/read changed receipt, stock or revisions")
			}
		})
	}
}

func TestR1ReceiptUnexpectedOnly(t *testing.T) {
	ctx, p, s := fixture(t)
	r := receiptDispatch(t, ctx, s, input())
	stock := stocks(t, ctx, p)
	got, err := s.Receive(ctx, actor(2), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{1, 0}, {2, 0}, {3, math.MaxInt64}, {4, math.MaxInt64}}})
	if err != nil {
		t.Fatal("unexpected-only with aggregate beyond int64 refused", err)
	}
	want := &transfers.Receipt{Items: []transfers.ReceiptLine{{1, 2, 0, 0}, {2, 1, 0, 0}, {3, 0, math.MaxInt64, 0}, {4, 0, math.MaxInt64, 0}}, Exceptions: []transfers.ReceiptException{{1, "shortage", 2}, {2, "shortage", 1}, {3, "unexpected", math.MaxInt64}, {4, "unexpected", math.MaxInt64}}}
	if !reflect.DeepEqual(got.Receipt, want) || !reflect.DeepEqual(stock, stocks(t, ctx, p)) {
		t.Fatal("unexpected-only fabricated inventory or lost missing expected units")
	}
}

func TestR1ReceiptValidation(t *testing.T) {
	ctx, p, s := fixture(t)
	r := receiptDispatch(t, ctx, s, input())
	before := receiptSnapshot(t, ctx, p)
	for name, items := range map[string][]transfers.Line{
		"all_zero": {{1, 0}, {2, 0}}, "missing_expected": {{1, 1}}, "unexpected_only_missing_expected": {{3, 1}},
		"noncatalog": {{1, 1}, {2, 1}, {191, 1}}, "unexpected_zero": {{1, 1}, {2, 1}, {3, 0}},
		"duplicate": {{1, 1}, {2, 1}, {1, 0}}, "negative": {{1, -1}, {2, 1}}, "empty": {},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := s.Receive(ctx, actor(2), r.ID, transfers.ReceiptInput{Items: items})
			a02Error(t, got, err, transfers.ErrInvalid)
			if receiptSnapshot(t, ctx, p) != before {
				t.Fatal("invalid receipt wrote a partial outcome")
			}
		})
	}
	// Later line overflow must be prevalidated, before even the first INSERT.
	a01Exec(t, ctx, p, "UPDATE inventory_balances SET existing=9223372036854775807 WHERE location_id=2 AND variant_id=2")
	before = receiptSnapshot(t, ctx, p)
	a01Exec(t, ctx, p, `CREATE FUNCTION r1_no_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'prevalidation must precede receipt writes'; END $$; CREATE TRIGGER r1_no_insert BEFORE INSERT ON transfer_receipt_lines FOR EACH ROW EXECUTE FUNCTION r1_no_insert()`)
	got, err := s.Receive(ctx, actor(2), r.ID, receiptInput(r))
	a02Error(t, got, err, transfers.ErrInvalid)
	if receiptSnapshot(t, ctx, p) != before {
		t.Fatal("overflow wrote stock/header/lines")
	}
	a01Exec(t, ctx, p, "DROP TRIGGER r1_no_insert ON transfer_receipt_lines")
	// Exact maximum addition is safe, independent of reserved holds.
	a01Exec(t, ctx, p, "UPDATE inventory_balances SET existing=9223372036854775806 WHERE location_id=2 AND variant_id=2")
	if _, err = s.Receive(ctx, actor(2), r.ID, receiptInput(r)); err != nil {
		t.Fatal("exact int64 destination maximum refused", err)
	}
}

func TestR1ReceiptDependenciesAndStates(t *testing.T) {
	for _, s := range []*transfers.Store{nil, transfers.New(nil)} {
		for _, ctx := range []context.Context{nil, context.Background()} {
			got, err := s.Receive(ctx, actor(2), 1, transfers.ReceiptInput{})
			a02Error(t, got, err, transfers.ErrUnavailable)
		}
	}
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	payload := receiptInput(r)
	before := receiptSnapshot(t, ctx, p)
	for _, identity := range []auth.Identity{actor(0), actor(4), {AccountID: 2, Location: auth.Location{ID: 1}}} {
		got, err := s.Receive(ctx, identity, r.ID, payload)
		a02Error(t, got, err, transfers.ErrForbidden)
	}
	for _, id := range []int64{0, -1, math.MaxInt64} {
		got, err := s.Receive(ctx, actor(2), id, payload)
		a02Error(t, got, err, transfers.ErrNotFound)
	}
	for _, id := range []int{1, 3} {
		want := transfers.ErrForbidden
		if id == 3 {
			want = transfers.ErrNotFound
		}
		got, err := s.Receive(ctx, actor(id), r.ID, payload)
		a02Error(t, got, err, want)
	}
	got, err := s.Receive(ctx, actor(2), r.ID, payload)
	a02Error(t, got, err, transfers.ErrDecisionConflict)
	if before != receiptSnapshot(t, ctx, p) {
		t.Fatal("state/identity errors mutated pending")
	}
	if _, err = s.Approve(ctx, actor(1), r.ID); err != nil {
		t.Fatal(err)
	}
	got, err = s.Receive(ctx, actor(2), r.ID, payload)
	a02Error(t, got, err, transfers.ErrDecisionConflict)
	other := input()
	other.RetryKey = "receipt-rejected-key-001"
	rejected := create(t, ctx, s, 2, other).Request
	if _, err = s.Reject(ctx, actor(1), rejected.ID); err != nil {
		t.Fatal(err)
	}
	got, err = s.Receive(ctx, actor(2), rejected.ID, payload)
	a02Error(t, got, err, transfers.ErrDecisionConflict)
	for _, mode := range []string{"cancel", "expired"} {
		canceled, cancel := context.WithCancel(ctx)
		if mode == "expired" {
			cancel()
			canceled, cancel = context.WithDeadline(ctx, time.Now().Add(-time.Second))
		} else {
			cancel()
		}
		_, err = s.Receive(canceled, actor(2), r.ID, payload)
		cancel()
		want := context.Canceled
		if mode == "expired" {
			want = context.DeadlineExceeded
		}
		if !errors.Is(err, want) {
			t.Fatal("context semantics lost", err)
		}
	}
}

func TestR1ReceiptFullCatalogue(t *testing.T) {
	ctx, _, s := fixture(t)
	r := receiptDispatch(t, ctx, s, input())
	payload := transfers.ReceiptInput{Items: make([]transfers.Line, 190)}
	for i := range payload.Items {
		payload.Items[i] = transfers.Line{int64(i + 1), 1}
	}
	got, err := s.Receive(ctx, actor(2), r.ID, payload)
	if err != nil || len(got.Receipt.Items) != 190 || len(got.Receipt.Exceptions) != 189 {
		t.Fatal("full catalogue receipt refused", err)
	}
}
