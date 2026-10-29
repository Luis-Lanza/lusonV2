package auth_test

import (
	"context"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
	"reflect"
	"strings"
	"testing"
	"time"
)

// S2/S4: public credential boundaries and rejected-recovery noninterference.
func TestT7IndependentRecoveryBoundaries(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("initialize failed")
	}
	creds := []bootstrap.Credentials{{Username: "warehouse", Password: "original warehouse password"}, {Username: "operator_a", Password: "original operator password"}, {Username: "operator_b", Password: "another operator password"}}
	if bootstrap.Provision(ctx, p, creds) != nil {
		t.Fatal("provision failed")
	}
	s, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("service failed")
	}
	_, token, err := s.Login(ctx, "warehouse", creds[0].Password, "127.0.0.1", "")
	if err != nil {
		t.Fatal("login failed")
	}
	if s.ChangePassword(ctx, token, creds[0].Password, "completed warehouse password") != nil {
		t.Fatal("complete password failed")
	}
	_, token, err = s.Login(ctx, "warehouse", "completed warehouse password", "127.0.0.2", "")
	if err != nil {
		t.Fatal("completed login failed")
	}
	before, err := s.ListAccounts(ctx, token)
	if err != nil {
		t.Fatal("directory failed")
	}
	for _, bad := range []string{"", strings.Repeat("x", 11), strings.Repeat("é", 65), "valid length\x00invalid"} {
		if s.RecoverWarehouseCredential(ctx, bad) != auth.ErrPassword {
			t.Fatal("invalid boundary accepted")
		}
		after, err := s.ListAccounts(ctx, token)
		if err != nil || !reflect.DeepEqual(before, after) {
			t.Fatal("rejection changed directory or session")
		}
	}
	if _, _, err = s.Login(ctx, "warehouse", "completed warehouse password", "127.0.0.3", ""); err != nil {
		t.Fatal("rejection changed credential")
	}
	for _, password := range []string{strings.Repeat("x", 12), strings.Repeat("é", 64)} {
		if s.RecoverWarehouseCredential(ctx, password) != nil {
			t.Fatal("valid byte boundary refused")
		}
		session, _, err := s.Login(ctx, "warehouse", password, "127.0.0.4", "")
		if err != nil || !session.Identity.MustChangePassword || session.Identity.AccountID != 1 || session.Identity.Location.ID != 1 {
			t.Fatal("boundary recovery identity or gate failed")
		}
	}
	if _, _, err = s.Login(ctx, "operator_a", creds[1].Password, "127.0.0.5", ""); err != nil {
		t.Fatal("operator credential changed")
	}
}
