package auth_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
)

func TestR03PeekPostgres(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("passive fixture initialization failed")
	}
	creds := make([]bootstrap.Credentials, 3)
	for i := range creds {
		creds[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, creds) != nil {
		t.Fatal("passive fixture provisioning failed")
	}
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	start := now
	svc, err := auth.New(p, func() time.Time { return now })
	if err != nil {
		t.Fatal("passive service failed")
	}
	tokens := make([]string, 3)
	sessions := make([]auth.Session, 3)
	for i, c := range creds {
		sessions[i], tokens[i], err = svc.Login(ctx, c.Username, c.Password, fmt.Sprintf("127.0.0.%d", i+1), "")
		if err != nil {
			t.Fatal("passive assigned login failed")
		}
	}
	type state struct {
		seen, idle, absolute time.Time
		revoked              *time.Time
	}
	snapshot := func(account int) state {
		t.Helper()
		var row state
		if p.QueryRow(ctx, "SELECT last_seen_at,idle_deadline,absolute_deadline,revoked_at FROM auth_sessions WHERE account_id=$1", account).Scan(&row.seen, &row.idle, &row.absolute, &row.revoked) != nil {
			t.Fatal("passive state snapshot failed")
		}
		return row
	}
	expectFailure := func(service *auth.Service, context context.Context, token string, want error) {
		t.Helper()
		session, deadline, err := service.Peek(context, token)
		if !errors.Is(err, want) || !reflect.DeepEqual(session, auth.Session{}) || !deadline.IsZero() {
			t.Fatal("Peek failure not sanitized and zero")
		}
	}
	for i := range tokens {
		t.Run(fmt.Sprintf("live_account_%d", i+1), func(t *testing.T) {
			before := snapshot(i + 1)
			for probe := 0; probe < 5; probe++ {
				got, deadline, err := svc.Peek(ctx, tokens[i])
				if err != nil || (got.Identity != sessions[i].Identity || !got.ExpiresAt.Equal(sessions[i].ExpiresAt)) || !deadline.Equal(start.Add(auth.IdleTTL)) {
					t.Fatal("live non-touch session validation unavailable")
				}
			}
			if !reflect.DeepEqual(before, snapshot(i+1)) {
				t.Fatal("Peek modified session state")
			}
		})
	}
	t.Run("repeated_probes_do_not_renew", func(t *testing.T) {
		before := snapshot(2)
		for _, elapsed := range []time.Duration{auth.TouchInterval, 5 * time.Minute, 20 * time.Minute, auth.IdleTTL - time.Microsecond} {
			now = start.Add(elapsed)
			got, deadline, err := svc.Peek(ctx, tokens[1])
			if err != nil || !got.ExpiresAt.Equal(start.Add(auth.AbsoluteTTL)) || !deadline.Equal(start.Add(auth.IdleTTL)) || !reflect.DeepEqual(before, snapshot(2)) {
				t.Fatal("passive reconnect/probe changed idle or absolute authority")
			}
		}
		now = start.Add(auth.IdleTTL)
		expectFailure(svc, ctx, tokens[1], auth.ErrSession)
		if !reflect.DeepEqual(before, snapshot(2)) {
			t.Fatal("expired Peek modified state")
		}
	})
	t.Run("ordinary_current_still_renews", func(t *testing.T) {
		now = start.Add(auth.TouchInterval)
		before := snapshot(1)
		session, err := svc.Current(ctx, tokens[0])
		after := snapshot(1)
		if err != nil || !session.ExpiresAt.Equal(before.absolute) || !after.seen.Equal(now) || !after.idle.Equal(now.Add(auth.IdleTTL)) || !after.absolute.Equal(before.absolute) {
			t.Fatal("ordinary Current renewal changed")
		}
		got, deadline, err := svc.Peek(ctx, tokens[0])
		if err != nil || (got.Identity != session.Identity || !got.ExpiresAt.Equal(session.ExpiresAt)) || !deadline.Equal(after.idle) || !reflect.DeepEqual(after, snapshot(1)) {
			t.Fatal("Peek changed renewed authority")
		}
	})
	t.Run("logout_and_revoke", func(t *testing.T) {
		now = start.Add(2 * time.Minute)
		if svc.Logout(ctx, tokens[2]) != nil {
			t.Fatal("passive test logout failed")
		}
		before := snapshot(3)
		expectFailure(svc, ctx, tokens[2], auth.ErrSession)
		if !reflect.DeepEqual(before, snapshot(3)) || before.revoked == nil {
			t.Fatal("revoked authority/state changed")
		}
	})
	t.Run("effective_absolute_ceiling", func(t *testing.T) {
		// Actual Current calls keep account1 active without extending absolute TTL.
		for elapsed := 20 * time.Minute; elapsed < auth.AbsoluteTTL; elapsed += 20 * time.Minute {
			now = start.Add(elapsed)
			if _, err := svc.Current(ctx, tokens[0]); err != nil {
				t.Fatal("active session renewal failed")
			}
		}
		now = start.Add(auth.AbsoluteTTL - time.Minute)
		before := snapshot(1)
		got, deadline, err := svc.Peek(ctx, tokens[0])
		if err != nil || !deadline.Equal(before.absolute) || !got.ExpiresAt.Equal(before.absolute) || !reflect.DeepEqual(before, snapshot(1)) {
			t.Fatal("absolute ceiling or separate effective expiry changed")
		}
		now = start.Add(auth.AbsoluteTTL)
		expectFailure(svc, ctx, tokens[0], auth.ErrSession)
		if !reflect.DeepEqual(before, snapshot(1)) {
			t.Fatal("absolute-expired Peek changed state")
		}
	})
	t.Run("dependencies_and_invalid_tokens", func(t *testing.T) {
		empty, _ := auth.New(nil, nil)
		var missing *auth.Service
		expectFailure(missing, ctx, tokens[0], auth.ErrUnavailable)
		expectFailure(empty, ctx, tokens[0], auth.ErrUnavailable)
		expectFailure(&auth.Service{}, ctx, tokens[0], auth.ErrUnavailable)
		expectFailure(svc, nil, tokens[0], auth.ErrUnavailable)
		for _, token := range []string{"", "invalid", tokens[0] + "="} {
			expectFailure(svc, ctx, token, auth.ErrSession)
		}
		unissued, err := auth.RandomToken()
		if err != nil {
			t.Fatal("unissued token generation failed")
		}
		expectFailure(svc, ctx, unissued, auth.ErrSession)
	})
	t.Run("cancellation_and_unavailable", func(t *testing.T) {
		now = start.Add(2 * time.Minute)
		canceled, stop := context.WithCancel(ctx)
		stop()
		expectFailure(svc, canceled, tokens[0], context.Canceled)
		expired, stop := context.WithDeadline(ctx, time.Unix(1, 0))
		defer stop()
		expectFailure(svc, expired, tokens[0], context.DeadlineExceeded)
		closed := testpg.Open(t)
		closed.Close()
		unavailable, err := auth.New(closed, nil)
		if err != nil {
			t.Fatal("closed-pool service fixture failed")
		}
		expectFailure(unavailable, ctx, tokens[0], auth.ErrUnavailable)
	})
}
