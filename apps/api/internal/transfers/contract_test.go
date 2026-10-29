package transfers_test

import (
	"errors"
	"math"
	"reflect"
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/transfers"
)

func actor(id int) auth.Identity {
	return auth.Identity{AccountID: id, Location: auth.Location{ID: id}}
}
func input() transfers.CreateInput {
	return transfers.CreateInput{Kind: transfers.RequestStock, CounterpartyID: 1, RetryKey: "opaque-retry-key-0001", Items: []transfers.Line{{VariantID: 2, Quantity: 1}, {VariantID: 1, Quantity: 2}}}
}
func TestW01DirectShipmentContract(t *testing.T) {
	for _, destination := range []int{2, 3} {
		in := input()
		in.Kind, in.CounterpartyID = transfers.DirectShipment, destination
		original := append([]transfers.Line(nil), in.Items...)
		got, err := transfers.Validate(actor(1), in)
		if err != nil || got.CreatorID != 1 || got.OriginID != 1 || got.ApproverID != 1 || got.DestinationID != destination || got.Kind != in.Kind || !reflect.DeepEqual(in.Items, original) {
			t.Fatal("direct intent must derive exclusively from assigned warehouse identity")
		}
		in.Items[0], in.Items[1] = in.Items[1], in.Items[0]
		reordered, err := transfers.Validate(actor(1), in)
		if err != nil || !reflect.DeepEqual(got, reordered) {
			t.Fatal("direct intent must canonicalize without mutating caller cart")
		}
		in.Items[0].Quantity++
		changed, err := transfers.Validate(actor(1), in)
		if err != nil || changed.Fingerprint == got.Fingerprint {
			t.Fatal("direct fingerprint must bind the whole cart")
		}
	}
	for _, id := range []int{0, 2, 3, 4} {
		in := input()
		in.Kind, in.CounterpartyID = transfers.DirectShipment, 2
		if _, err := transfers.Validate(actor(id), in); !errors.Is(err, transfers.ErrForbidden) {
			t.Fatal("nonwarehouse direct creator admitted")
		}
	}
	for _, destination := range []int{0, 1, 32768} {
		in := input()
		in.Kind, in.CounterpartyID = transfers.DirectShipment, destination
		if _, err := transfers.Validate(actor(1), in); !errors.Is(err, transfers.ErrInvalid) {
			t.Fatal("nonbranch direct destination admitted")
		}
	}
	for _, change := range []func(*transfers.CreateInput){
		func(in *transfers.CreateInput) { in.RetryKey = "short" },
		func(in *transfers.CreateInput) { in.Items = nil },
		func(in *transfers.CreateInput) { in.Items[0].Quantity = 0 },
		func(in *transfers.CreateInput) { in.Items[0].VariantID = in.Items[1].VariantID },
	} {
		in := input()
		in.Kind, in.CounterpartyID = transfers.DirectShipment, 2
		change(&in)
		if _, err := transfers.Validate(actor(1), in); !errors.Is(err, transfers.ErrInvalid) {
			t.Fatal("direct creation bypassed payload validation")
		}
	}
	in := input()
	in.Kind, in.CounterpartyID = transfers.DirectShipment, 2
	if _, err := transfers.Validate(auth.Identity{AccountID: 1, Location: auth.Location{ID: 2}}, in); !errors.Is(err, transfers.ErrForbidden) {
		t.Fatal("mismatched warehouse account/location admitted")
	}
}

func TestR01PendingContract(t *testing.T) {
	for _, tc := range []struct {
		name                          string
		creator, counterparty         int
		kind                          transfers.Kind
		origin, destination, approver int
	}{
		{"request_warehouse", 2, 1, transfers.RequestStock, 1, 2, 1},
		{"request_other_branch", 2, 3, transfers.RequestStock, 3, 2, 3},
		{"send_warehouse", 2, 1, transfers.SendToWarehouse, 2, 1, 1},
		{"branch_b_request", 3, 2, transfers.RequestStock, 2, 3, 2},
		{"branch_b_send", 3, 1, transfers.SendToWarehouse, 3, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := input()
			in.Kind = tc.kind
			in.CounterpartyID = tc.counterparty
			n, err := transfers.Validate(actor(tc.creator), in)
			if err != nil || n.CreatorID != tc.creator || n.OriginID != tc.origin || n.DestinationID != tc.destination || n.ApproverID != tc.approver {
				t.Fatal("physical direction not derived from authenticated branch")
			}
		})
	}
	for _, tc := range []struct {
		name     string
		identity auth.Identity
		change   func(*transfers.CreateInput)
		want     error
	}{
		{"warehouse", actor(1), func(*transfers.CreateInput) {}, transfers.ErrForbidden},
		{"unassigned", actor(0), func(*transfers.CreateInput) {}, transfers.ErrForbidden},
		{"unknown_actor", actor(32768), func(*transfers.CreateInput) {}, transfers.ErrForbidden},
		{"mismatched_account", auth.Identity{AccountID: 1, Location: auth.Location{ID: 2}}, func(*transfers.CreateInput) {}, transfers.ErrForbidden},
		{"kind", actor(2), func(in *transfers.CreateInput) { in.Kind = "approval" }, transfers.ErrInvalid},
		{"self", actor(2), func(in *transfers.CreateInput) { in.CounterpartyID = 2 }, transfers.ErrInvalid},
		{"unknown_counterparty", actor(2), func(in *transfers.CreateInput) { in.CounterpartyID = 32768 }, transfers.ErrInvalid},
		{"send_other_branch", actor(2), func(in *transfers.CreateInput) { in.Kind = transfers.SendToWarehouse; in.CounterpartyID = 3 }, transfers.ErrInvalid},
		{"empty_items", actor(2), func(in *transfers.CreateInput) { in.Items = nil }, transfers.ErrInvalid},
		{"too_many_items", actor(2), func(in *transfers.CreateInput) { in.Items = make([]transfers.Line, 191) }, transfers.ErrInvalid},
		{"duplicates", actor(2), func(in *transfers.CreateInput) { in.Items[1].VariantID = in.Items[0].VariantID }, transfers.ErrInvalid},
		{"zero_quantity", actor(2), func(in *transfers.CreateInput) { in.Items[0].Quantity = 0 }, transfers.ErrInvalid},
		{"negative_quantity", actor(2), func(in *transfers.CreateInput) { in.Items[0].Quantity = -1 }, transfers.ErrInvalid},
		{"zero_variant", actor(2), func(in *transfers.CreateInput) { in.Items[0].VariantID = 0 }, transfers.ErrInvalid},
		{"variant_overflow", actor(2), func(in *transfers.CreateInput) { in.Items[0].VariantID = math.MaxInt32 + 1 }, transfers.ErrInvalid},
		{"missing_key", actor(2), func(in *transfers.CreateInput) { in.RetryKey = "" }, transfers.ErrInvalid},
		{"short_key", actor(2), func(in *transfers.CreateInput) { in.RetryKey = "short" }, transfers.ErrInvalid},
		{"long_key", actor(2), func(in *transfers.CreateInput) { in.RetryKey = string(make([]byte, 129)) }, transfers.ErrInvalid},
		{"whitespace_key", actor(2), func(in *transfers.CreateInput) { in.RetryKey = " opaque-retry-key-0001" }, transfers.ErrInvalid},
		{"unicode_key", actor(2), func(in *transfers.CreateInput) { in.RetryKey = "opaque-retry-key-ñ" }, transfers.ErrInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := input()
			tc.change(&in)
			if _, err := transfers.Validate(tc.identity, in); !errors.Is(err, tc.want) {
				t.Fatal("invalid contract input admitted")
			}
		})
	}
	t.Run("full_cart_without_aggregate_overflow", func(t *testing.T) {
		in := input()
		in.Items = make([]transfers.Line, 190)
		for i := range in.Items {
			in.Items[i] = transfers.Line{VariantID: int64(i + 1), Quantity: math.MaxInt64}
		}
		if n, err := transfers.Validate(actor(2), in); err != nil || len(n.Items) != 190 {
			t.Fatal("bounded full cart was aggregated or rejected")
		}
	})
	t.Run("canonical_exact_payload", func(t *testing.T) {
		in := input()
		before := append([]transfers.Line(nil), in.Items...)
		a, err := transfers.Validate(actor(2), in)
		if err != nil || !reflect.DeepEqual(in.Items, before) || len(a.Items) != 2 || a.Items[0].VariantID != 1 {
			t.Fatal("canonical sorting or caller ownership failed")
		}
		in.Items[0], in.Items[1] = in.Items[1], in.Items[0]
		in.RetryKey = "different-retry-key-001"
		b, err := transfers.Validate(actor(2), in)
		if err != nil || a.Fingerprint != b.Fingerprint {
			t.Fatal("permutation/key changed canonical payload")
		}
		in.Items[0].Quantity = math.MaxInt64
		c, err := transfers.Validate(actor(2), in)
		if err != nil || c.Fingerprint == a.Fingerprint {
			t.Fatal("exact int64 payload not preserved")
		}
		in.Items[1].Quantity = math.MaxInt64
		if _, err := transfers.Validate(actor(2), in); err != nil {
			t.Fatal("line quantities were incorrectly aggregated")
		}
	})
}
