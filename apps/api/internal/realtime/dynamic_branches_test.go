package realtime

import (
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/transfers"
)

func TestDynamicRealtimePayload(t *testing.T) {
	for _, payload := range []string{"transfers:4", "transfers:32767"} {
		if e, _, ok := parsePayload(payload); !ok || e != Transfers {
			t.Fatal("dynamic payload rejected", payload)
		}
	}
	for _, payload := range []string{"transfers:0", "transfers:04", "transfers:32768", "transfers:+4", "transfers:4\n"} {
		if _, _, ok := parsePayload(payload); ok {
			t.Fatal("invalid payload", payload)
		}
	}
}

func TestDynamicRealtimeDelivery(t *testing.T) {
	f := brokerFixtureDB(t)
	b, all := f.start(t, nil)
	if _, err := f.p.Exec(f.ctx, `SELECT create_branch('Sucursal C'); INSERT INTO auth_accounts(id,location_id,username,password_hash,must_change_password) VALUES(20,4,'operator_c','opaque',false)`); err != nil {
		t.Fatal(err)
	}
	// Stock initialization invalidates readers and refreshes audiences.
	f.boundary(t, all, [][]Event{{Inventory}, {Inventory}, {Inventory}})
	fourth, err := b.Subscribe(4)
	if err != nil {
		t.Fatal(err)
	}
	defer fourth.Close()
	expectEvent(t, fourth, Resync)
	if _, err := b.Subscribe(99); err != ErrInvalid {
		t.Fatal("unknown audience", err)
	}
	a := auth.Identity{AccountID: 20, Location: auth.Location{ID: 4}}
	in := f.input(transfers.RequestStock, 1)
	if _, err := f.store.Create(f.ctx, a, in); err != nil {
		t.Fatal(err)
	}
	f.boundary(t, append(all, fourth), [][]Event{{Transfers}, nil, nil, {Transfers}})
}
