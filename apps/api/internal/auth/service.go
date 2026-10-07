package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	AbsoluteTTL    = 8 * time.Hour
	IdleTTL        = 30 * time.Minute
	TouchInterval  = time.Minute
	ThrottleWindow = time.Minute
	IPLimit        = 10
	UserLimit      = 10
	GlobalLimit    = 60
)

var (
	ErrCredentials = errors.New("invalid credentials")
	ErrSession     = errors.New("session unavailable")
	ErrLimited     = errors.New("login rate limited")
)

type Location struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}
type Identity struct {
	AccountID int      `json:"account_id"`
	Username  string   `json:"username"`
	Location  Location `json:"location"`
}
type Session struct {
	Identity  Identity
	ExpiresAt time.Time
}
type Service struct {
	pool    *pgxpool.Pool
	now     func() time.Time
	dummy   string
	hashing chan struct{}
}

func New(pool *pgxpool.Pool, clock func() time.Time) (*Service, error) {
	if clock == nil {
		clock = time.Now
	}
	secret, err := RandomToken()
	if err != nil {
		return nil, err
	}
	dummy, err := HashPassword(secret)
	if err != nil {
		return nil, err
	}
	return &Service{pool: pool, now: clock, dummy: dummy, hashing: make(chan struct{}, 2)}, nil
}

func RandomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func validToken(token string) bool {
	b, err := base64.RawURLEncoding.Strict().DecodeString(token)
	return err == nil && len(b) == 32 && len(token) == 43
}
func tokenHash(token string) []byte { sum := sha256.Sum256([]byte(token)); return sum[:] }

// CSRF is derived from a secret cookie, never from caller identity/location.
// Domain separation keeps it distinct from the database session hash.
func CSRF(token string) string {
	sum := sha256.Sum256([]byte("luson-csrf-v1:" + token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func bucket(value string, offset int) int {
	sum := sha256.Sum256([]byte(value))
	return int(binary.BigEndian.Uint32(sum[:4])%4096) + offset
}

// Fixed cardinality and transaction serialization bound database limiter state.
// Collisions fail conservatively; counters are persisted across process restarts.
func (s *Service) limit(ctx context.Context, ip, user string, now time.Time) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	for _, item := range []struct{ id, max int }{{-1, GlobalLimit}, {bucket(ip, 0), IPLimit}, {bucket(user, 4096), UserLimit}} {
		var attempts int
		err := tx.QueryRow(ctx, `INSERT INTO auth_throttle(bucket,window_start,attempts) VALUES($1,$2,1)
   ON CONFLICT(bucket) DO UPDATE SET
   window_start=CASE WHEN auth_throttle.window_start <= $2-$3::interval THEN $2 ELSE auth_throttle.window_start END,
   attempts=CASE WHEN auth_throttle.window_start <= $2-$3::interval THEN 1 ELSE auth_throttle.attempts+1 END
   WHERE auth_throttle.window_start <= $2-$3::interval OR auth_throttle.attempts<$4
   RETURNING attempts`, item.id, now, "60 seconds", item.max).Scan(&attempts)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrLimited
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Service) Login(ctx context.Context, user, password, ip, previous string) (Session, string, error) {
	now := s.now().UTC()
	if err := s.limit(ctx, ip, user, now); err != nil {
		return Session{}, "", err
	}
	// Additional process-local concurrency cap; reject rather than queue hashes.
	select {
	case s.hashing <- struct{}{}:
		defer func() { <-s.hashing }()
	default:
		return Session{}, "", ErrLimited
	}
	var identity Identity
	var encoded string
	err := s.pool.QueryRow(ctx, `SELECT a.location_id,a.username,l.id,l.name,a.password_hash
 FROM auth_accounts a JOIN locations l ON l.id=a.location_id WHERE a.username=$1`, user).Scan(&identity.AccountID, &identity.Username, &identity.Location.ID, &identity.Location.Name, &encoded)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Session{}, "", err
	}
	found := err == nil
	if !found {
		encoded = s.dummy
	}
	// Even missing or invalid credentials perform the same bounded dummy hash.
	candidate := password
	valid := ValidCredentials(user, password)
	if !valid {
		candidate = "invalid bounded credential"
		encoded = s.dummy
	}
	verified := VerifyPassword(encoded, candidate)
	if !found || !valid || !verified {
		return Session{}, "", ErrCredentials
	}
	token, err := RandomToken()
	if err != nil {
		return Session{}, "", err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, "", err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if validToken(previous) {
		if _, err := tx.Exec(ctx, "UPDATE auth_sessions SET revoked_at=$2 WHERE token_hash=$1 AND revoked_at IS NULL", tokenHash(previous), now); err != nil {
			return Session{}, "", err
		}
	}
	// Expired sessions carry no authority; bounded opportunistic retention cleanup.
	if _, err := tx.Exec(ctx, `DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE absolute_deadline<$1 ORDER BY absolute_deadline LIMIT 100)`, now.Add(-24*time.Hour)); err != nil {
		return Session{}, "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO auth_sessions(token_hash,account_id,created_at,last_seen_at,absolute_deadline,idle_deadline) VALUES($1,$2,$3,$3,$4,$5)`, tokenHash(token), identity.AccountID, now, now.Add(AbsoluteTTL), now.Add(IdleTTL)); err != nil {
		return Session{}, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, "", err
	}
	return Session{identity, now.Add(AbsoluteTTL)}, token, nil
}

func (s *Service) Current(ctx context.Context, token string) (Session, error) {
	if !validToken(token) {
		return Session{}, ErrSession
	}
	now := s.now().UTC()
	var session Session
	// One conditional statement: logout and expiry cannot be undone by a touch.
	err := s.pool.QueryRow(ctx, `WITH live AS (
 UPDATE auth_sessions SET
 last_seen_at=CASE WHEN last_seen_at <= $2-$3::interval THEN $2 ELSE last_seen_at END,
 idle_deadline=CASE WHEN last_seen_at <= $2-$3::interval THEN LEAST(absolute_deadline,$2+$4::interval) ELSE idle_deadline END
 WHERE token_hash=$1 AND revoked_at IS NULL AND absolute_deadline>$2 AND idle_deadline>$2
 RETURNING account_id,absolute_deadline)
 SELECT a.location_id,a.username,l.id,l.name,live.absolute_deadline FROM live
 JOIN auth_accounts a ON a.location_id=live.account_id JOIN locations l ON l.id=a.location_id`, tokenHash(token), now, "60 seconds", "1800 seconds").Scan(&session.Identity.AccountID, &session.Identity.Username, &session.Identity.Location.ID, &session.Identity.Location.Name, &session.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrSession
	}
	return session, err
}

func (s *Service) Logout(ctx context.Context, token string) error {
	if !validToken(token) {
		return nil
	}
	_, err := s.pool.Exec(ctx, "UPDATE auth_sessions SET revoked_at=$2 WHERE token_hash=$1 AND revoked_at IS NULL", tokenHash(token), s.now().UTC())
	return err
}

type identityKey struct{}

func IdentityFrom(ctx context.Context) (Identity, bool) {
	identity, ok := ctx.Value(identityKey{}).(Identity)
	return identity, ok
}

// Middleware provides reusable server-resolved identity for later inventory.
// Future mutation handlers must additionally apply the HTTP origin/CSRF guard.
func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookies := r.CookiesNamed("luson_session")
		if len(cookies) != 1 {
			http.Error(w, "unauthenticated", 401)
			return
		}
		session, err := s.Current(r.Context(), cookies[0].Value)
		if err != nil {
			if errors.Is(err, ErrSession) {
				http.Error(w, "unauthenticated", 401)
			} else {
				http.Error(w, "service unavailable", 503)
			}
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey{}, session.Identity)))
	})
}
