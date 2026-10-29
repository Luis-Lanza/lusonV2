package transfers_test

import (
	"errors"
	"fmt"
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/transfers"
)

func TestDynamicAssignedIdentity(t *testing.T) {
	for _, location := range []int{2, 4, 32767} {
		t.Run(fmt.Sprint(location), func(t *testing.T) {
			a := auth.Identity{AccountID: 900, Location: auth.Location{ID: location}}
			in := input()
			in.CounterpartyID = 1
			got, err := transfers.Validate(a, in)
			if err != nil || got.CreatorID != location || got.DestinationID != location {
				t.Fatalf("assigned location: %+v %v", got, err)
			}
			a.AccountID = 901
			other, err := transfers.Validate(a, in)
			if err != nil || other.Fingerprint != got.Fingerprint {
				t.Fatal("retry fingerprint is not location owned", err)
			}
		})
	}
	in := input()
	in.Kind, in.CounterpartyID = transfers.DirectShipment, 4
	if _, err := transfers.Validate(actor(1), in); err != nil {
		t.Fatal("dynamic direct:", err)
	}
	for _, a := range []auth.Identity{
		{AccountID: 1, Location: auth.Location{ID: 4}},
		{AccountID: 20, Location: auth.Location{ID: 1}},
		{AccountID: 20, MustChangePassword: true, Location: auth.Location{ID: 4}},
	} {
		if _, err := transfers.Validate(a, in); !errors.Is(err, transfers.ErrForbidden) {
			t.Fatal("invalid authority", err)
		}
	}
}
