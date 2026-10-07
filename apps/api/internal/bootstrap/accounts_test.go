package bootstrap_test

import (
	"context"
	"luson/api/internal/auth"
	"luson/api/internal/auth/testpg"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"testing"
)

func TestAccountsAtomic(t *testing.T) {
	p := testpg.Open(t)
	ctx := context.Background()
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	count := func(query string) int {
		t.Helper()
		var n int
		if err := p.QueryRow(ctx, query).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if err := bootstrap.Provision(ctx, p, credentials[:2]); err == nil {
		t.Fatal("partial input accepted")
	}
	duplicate := append([]bootstrap.Credentials(nil), credentials...)
	duplicate[1].Username = duplicate[0].Username
	if err := bootstrap.Provision(ctx, p, duplicate); err == nil {
		t.Fatal("duplicate username accepted")
	}
	duplicate[1] = credentials[1]
	duplicate[1].Password = duplicate[0].Password
	if err := bootstrap.Provision(ctx, p, duplicate); err == nil {
		t.Fatal("duplicate password accepted")
	}
	if _, err := p.Exec(ctx, `CREATE FUNCTION fail_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.location_id=2 THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_account BEFORE INSERT ON auth_accounts FOR EACH ROW EXECUTE FUNCTION fail_account()`); err != nil {
		t.Fatal(err)
	}
	if err := bootstrap.Provision(ctx, p, credentials); err == nil {
		t.Fatal("injected account failure ignored")
	}
	if count("SELECT count(*) FROM auth_accounts") != 0 {
		t.Fatal("partial accounts committed")
	}
	// Disable only this test-injected trigger, never a foundation protection.
	if _, err := p.Exec(ctx, "ALTER TABLE auth_accounts DISABLE TRIGGER fail_account"); err != nil {
		t.Fatal(err)
	}
	if err := bootstrap.Provision(ctx, p, credentials); err != nil {
		t.Fatal("provision failed")
	}
	for i, c := range credentials {
		var user, hash string
		if err := p.QueryRow(ctx, "SELECT username,password_hash FROM auth_accounts WHERE location_id=$1", i+1).Scan(&user, &hash); err != nil {
			t.Fatal(err)
		}
		if user != c.Username || !auth.VerifyPassword(hash, c.Password) {
			t.Fatal("assigned credentials mismatch")
		}
	}
	if err := bootstrap.Provision(ctx, p, credentials); err == nil {
		t.Fatal("replay accepted")
	}
	if count("SELECT count(*) FROM inventory_balances WHERE existing<>(variant_id*7+location_id*11)%31 OR reserved<>0") != 0 {
		t.Fatal("account bootstrap altered stock")
	}
	if count("SELECT count(*) FROM auth_accounts") != 3 {
		t.Fatal("replay changed accounts")
	}
	if _, err := p.Exec(ctx, "UPDATE auth_accounts SET username=$1 WHERE location_id=1", "u"+testpg.Random(t)[:20]); err == nil {
		t.Fatal("fixed identity overwritten")
	}
	var unchanged string
	if err := p.QueryRow(ctx, "SELECT password_hash FROM auth_accounts WHERE location_id=1").Scan(&unchanged); err != nil || !auth.VerifyPassword(unchanged, credentials[0].Password) {
		t.Fatal("replay overwrote password")
	}
}

func TestAccountsPartialRefusal(t *testing.T) {
	p := testpg.Open(t)
	ctx := context.Background()
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	hash, err := auth.HashPassword(testpg.Random(t))
	if err != nil {
		t.Fatal("hash failed")
	}
	if _, err := p.Exec(ctx, "INSERT INTO auth_accounts(location_id,username,password_hash) VALUES(1,$1,$2)", "u"+testpg.Random(t)[:20], hash); err != nil {
		t.Fatal(err)
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if err := bootstrap.Provision(ctx, p, credentials); err == nil {
		t.Fatal("partial existing accounts accepted")
	}
	var n int
	if err := p.QueryRow(ctx, "SELECT count(*) FROM auth_accounts").Scan(&n); err != nil || n != 1 {
		t.Fatal("partial existing account changed")
	}
}
