package httpapi

import (
	"fmt"
	"testing"
	"time"

	"luson/api/internal/auth"
)

func TestDynamicIndependentOperatorsHTTP(t *testing.T) {
	env := eventFixture(t)
	f := env.f
	password := "Independent-test-password-42"
	hash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []int{20, 21} {
		username := fmt.Sprintf("personal_%d", id)
		if _, err = f.p.Exec(f.ctx, `INSERT INTO auth_accounts(id,location_id,username,password_hash,must_change_password,display_name) VALUES($1,2,$2,$3,false,'Operador')`, id, username, hash); err != nil {
			t.Fatal(err)
		}
		session, token, err := f.svc.Login(f.ctx, username, password, fmt.Sprintf("192.0.2.%d", id), "")
		if err != nil || session.Identity.AccountID != id || session.Identity.Location.ID != 2 {
			t.Fatal("independent identity", err)
		}
		f.tokens = append(f.tokens, token)
	}
	server := eventServer(t, env)
	clients := []*eventClient{
		openEvents(t, env, server, 1, ""),
		openEvents(t, env, server, 4, ""),
		openEvents(t, env, server, 5, ""),
		openEvents(t, env, server, 3, ""),
	}
	for _, client := range clients {
		expectHTTPEvent(t, client, "resync")
	}
	body := `{"kind":"request_stock","counterparty_location_id":1,"retry_key":"independent-http-key","items":[{"variant_id":1,"quantity":"1"}]}`
	created := transferWireRecord(t, f.request(t, 4, "POST", "/api/transfers", body), 201)
	replay := transferWireRecord(t, f.request(t, 5, "POST", "/api/transfers", body), 200)
	if replay.ID != created.ID || created.CreatorLocationID != 2 {
		t.Fatal("location retry identity changed")
	}
	eventBoundary(t, env, clients, [][]string{{"transfers"}, {"transfers"}, {"transfers"}, nil})
	path := "/api/transfers/" + created.ID
	if f.request(t, 5, "GET", path, "").Code != 200 {
		t.Fatal("same branch participant excluded")
	}
	expectTransferError(t, f.request(t, 3, "GET", path, ""), 404, "not_found")
	before := f.request(t, 4, "GET", "/api/transfers/counts", "").Body.String()
	expectTransferError(t, f.request(t, 4, "POST", path+"/approve", "{}"), 403, "forbidden")
	if after := f.request(t, 4, "GET", "/api/transfers/counts", "").Body.String(); after != before {
		t.Fatal("rejected approval changed counters")
	}
	if _, err = f.p.Exec(f.ctx, `UPDATE auth_accounts SET enabled=false WHERE id=20`); err != nil {
		t.Fatal(err)
	}
	expectStreamClosed(t, clients[1], 3*time.Second)
	expectTransferError(t, f.request(t, 4, "GET", path, ""), 401, "unauthenticated")
	if f.request(t, 5, "GET", path, "").Code != 200 {
		t.Fatal("disabled peer retired another operator")
	}
	if _, err = f.p.Exec(f.ctx, `UPDATE auth_accounts SET must_change_password=true WHERE id=21`); err != nil {
		t.Fatal(err)
	}
	expectTransferError(t, f.request(t, 5, "GET", path, ""), 403, "password_change_required")
	expectStreamClosed(t, clients[2], 3*time.Second)
	if _, err = f.p.Exec(f.ctx, `UPDATE auth_accounts SET must_change_password=false,authority_version=authority_version+1 WHERE id=21`); err != nil {
		t.Fatal(err)
	}
	expectTransferError(t, f.request(t, 5, "GET", path, ""), 401, "unauthenticated")
}
