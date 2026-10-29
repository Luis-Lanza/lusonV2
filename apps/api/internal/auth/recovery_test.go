package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
)

func TestT7RecoveryLifecycle(t *testing.T) {
	ctx := context.Background()
	p := testpg.Open(t)
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal("initialize failed")
	}
	creds := []bootstrap.Credentials{{Username: "warehouse", Password: "old warehouse password"}, {Username: "operator_a", Password: "operator a password"}, {Username: "operator_b", Password: "operator b password"}}
	if err := bootstrap.Provision(ctx, p, creds); err != nil {
		t.Fatal("provision failed")
	}
	s, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("service failed")
	}
	_, old, err := s.Login(ctx, creds[0].Username, creds[0].Password, "127.0.0.1", "")
	if err != nil {
		t.Fatal("login failed")
	}
	_, other, err := s.Login(ctx, creds[1].Username, creds[1].Password, "127.0.0.2", "")
	if err != nil {
		t.Fatal("operator login failed")
	}
	temporary := " private temporary password "
	if err := s.RecoverWarehouseCredential(ctx, temporary); err != nil {
		t.Fatal("recovery refused")
	}
	if _, _, err := s.Peek(ctx, old); err != auth.ErrSession {
		t.Fatal("old session survived")
	}
	if _, _, err := s.Login(ctx, creds[0].Username, creds[0].Password, "127.0.0.3", ""); err != auth.ErrCredentials {
		t.Fatal("old credential survived")
	}
	if _, _, err := s.Peek(ctx, other); err != nil {
		t.Fatal("operator session changed")
	}
	session, token, err := s.Login(ctx, creds[0].Username, temporary, "127.0.0.4", "")
	if err != nil || !session.Identity.MustChangePassword || session.Identity.AccountID != 1 || session.Identity.Location.ID != 1 {
		t.Fatal("temporary login contract")
	}
	if err := s.Administrator(ctx, token); err != auth.ErrAdminForbidden {
		t.Fatal("temporary administrator authority")
	}
	operational := func(token string, status int, body string) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/private-operation", nil)
		r.AddCookie(&http.Cookie{Name: "luson_session", Value: token})
		w := httptest.NewRecorder()
		s.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })).ServeHTTP(w, r)
		if w.Code != status || w.Body.String() != body {
			t.Fatal("operational gate contract")
		}
	}
	operational(token, http.StatusForbidden, "password change required\n")
	if err := s.ChangePassword(ctx, token, temporary, "completed warehouse password"); err != nil {
		t.Fatal("own change failed")
	}
	if _, _, err := s.Peek(ctx, token); err != auth.ErrSession {
		t.Fatal("temporary session survived own change")
	}
	_, complete, err := s.Login(ctx, creds[0].Username, "completed warehouse password", "127.0.0.5", "")
	if err != nil {
		t.Fatal("completed login failed")
	}
	accounts, err := s.ListAccounts(ctx, complete)
	if err != nil || len(accounts) != 3 {
		t.Fatal("account directory changed")
	}
	for i, a := range accounts {
		if a.Username != creds[i].Username || !a.Enabled || a.LocationID != i+1 {
			t.Fatal("identity changed")
		}
	}
	operational(complete, http.StatusNoContent, "")
	if _, _, err := s.Login(ctx, creds[1].Username, creds[1].Password, "127.0.0.6", ""); err != nil {
		t.Fatal("operator credential changed")
	}
	before, deadline, err := s.Peek(ctx, complete)
	if err != nil {
		t.Fatal("completed authority unavailable")
	}
	// Rejections preserve existing public credentials, authority and directory.
	for _, bad := range []string{"short", strings.Repeat("x", 129), "nul\x00password value", string([]byte{0xff}) + "long password"} {
		if err := s.RecoverWarehouseCredential(ctx, bad); err == nil {
			t.Fatal("invalid password accepted")
		}
		after, err := s.ListAccounts(ctx, complete)
		if err != nil || !reflect.DeepEqual(after, accounts) {
			t.Fatal("rejection changed directory")
		}
		current, currentDeadline, err := s.Peek(ctx, complete)
		if err != nil || !reflect.DeepEqual(current, before) || !currentDeadline.Equal(deadline) {
			t.Fatal("rejection changed authority")
		}
	}
}

func TestT7RecoveryDoesNotProvision(t *testing.T) {
	ctx := context.Background()
	p := testpg.Open(t)
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal("initialize failed")
	}
	s, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("service failed")
	}
	if err := s.RecoverWarehouseCredential(ctx, "private replacement password"); err == nil {
		t.Fatal("missing warehouse accepted")
	}
	// Existing allocator/provisioner must still accept the untouched empty state.
	creds := []bootstrap.Credentials{{Username: "warehouse", Password: "warehouse password"}, {Username: "operator_a", Password: "operator a password"}, {Username: "operator_b", Password: "operator b password"}}
	if err := bootstrap.Provision(ctx, p, creds); err != nil {
		t.Fatal("recovery created accounts")
	}
}
