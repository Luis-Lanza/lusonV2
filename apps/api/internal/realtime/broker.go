// Package realtime supplies bounded, participant-private current-state invalidation.
package realtime

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrUnavailable = errors.New("realtime unavailable")
var ErrInvalid = errors.New("invalid realtime subscription")

type Event string

const (
	Resync         Event = "resync"
	Inventory      Event = "inventory"
	Transfers      Event = "transfers"
	channel              = "luson_realtime"
	maxSubscribers       = 128
	queueSize            = 8
)

// Broker never occupies an application-pool slot. The run goroutine alone owns
// its dedicated connection, including LISTEN, snapshots, waits and Close.
type Broker struct {
	cfg                     *pgx.ConnConfig
	mu                      sync.Mutex
	started, stopped, ready bool
	ctx                     context.Context
	cancel                  context.CancelFunc
	done, initial           chan struct{}
	initialOnce             sync.Once
	next                    uint64
	subscribers             map[uint64]*Subscription
	versions                map[string]int64
}
type Subscription struct {
	Events   <-chan Event
	queue    chan Event
	owner    *Broker
	id       uint64
	location int
}

func New(pool *pgxpool.Pool) (*Broker, error) {
	if pool == nil {
		return nil, ErrUnavailable
	}
	return newBroker(pool.Config().ConnConfig)
}
func newBroker(cfg *pgx.ConnConfig) (*Broker, error) {
	if cfg == nil {
		return nil, ErrUnavailable
	}
	return &Broker{cfg: cfg.Copy(), subscribers: make(map[uint64]*Subscription)}, nil
}

// Start is single-use and waits for committed LISTEN plus a fresh validated
// snapshot. Cancellation controls the whole broker lifetime, not just startup.
func (b *Broker) Start(ctx context.Context) error {
	if b == nil || ctx == nil || ctx.Err() != nil {
		return ErrUnavailable
	}
	b.mu.Lock()
	if b.cfg == nil || b.started || b.stopped {
		b.mu.Unlock()
		return ErrUnavailable
	}
	b.started = true
	b.ctx, b.cancel = context.WithCancel(ctx)
	b.done = make(chan struct{})
	b.initial = make(chan struct{})
	if b.subscribers == nil {
		b.subscribers = make(map[uint64]*Subscription)
	}
	done, initial := b.done, b.initial
	b.mu.Unlock()
	go b.run()
	select {
	case <-initial:
		b.mu.Lock()
		ready := b.ready && !b.stopped && b.ctx.Err() == nil
		b.mu.Unlock()
		if ready {
			return nil
		}
		return ErrUnavailable
	case <-done:
		return ErrUnavailable
	case <-ctx.Done():
		return ErrUnavailable
	}
}

// Subscribe takes a server-resolved assigned location, not client authority.
// Every new subscription begins with a generic resync, never private versions.
func (b *Broker) Subscribe(location int) (*Subscription, error) {
	if location < 1 || location > 3 {
		return nil, ErrInvalid
	}
	if b == nil {
		return nil, ErrUnavailable
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.ready || b.stopped || b.ctx == nil || b.ctx.Err() != nil || len(b.subscribers) >= maxSubscribers {
		return nil, ErrUnavailable
	}
	b.next++
	queue := make(chan Event, queueSize)
	s := &Subscription{Events: queue, queue: queue, owner: b, id: b.next, location: location}
	queue <- Resync
	b.subscribers[s.id] = s
	return s, nil
}
func (s *Subscription) Close() {
	if s == nil || s.owner == nil {
		return
	}
	b := s.owner
	b.mu.Lock()
	defer b.mu.Unlock()
	if current, ok := b.subscribers[s.id]; ok && current == s {
		close(s.queue)
		delete(b.subscribers, s.id)
	}
}
func (b *Broker) closeSubscribersLocked() {
	for id, s := range b.subscribers {
		close(s.queue)
		delete(b.subscribers, id)
	}
}
func (b *Broker) unavailable() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.ready = false
	b.closeSubscribersLocked()
}

// Shutdown disconnects synchronously, cancels network work and joins with a
// maximum five-second bound even if the caller supplies an unbounded context.
func (b *Broker) Shutdown(ctx context.Context) error {
	if b == nil || ctx == nil {
		return ErrUnavailable
	}
	b.mu.Lock()
	b.stopped = true
	b.ready = false
	b.closeSubscribersLocked()
	cancel, done := b.cancel, b.done
	b.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done == nil {
		return nil
	}
	ctx, finish := context.WithTimeout(ctx, 5*time.Second)
	defer finish()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func parsePayload(payload string) (Event, int, bool) {
	// Exact tiny grammar: neither arbitrary JSON nor untrusted bytes go public.
	switch payload {
	case "inventory:0":
		return Inventory, 0, true
	case "transfers:1":
		return Transfers, 1, true
	case "transfers:2":
		return Transfers, 2, true
	case "transfers:3":
		return Transfers, 3, true
	default:
		return "", 0, false
	}
}
func readRevisions(ctx context.Context, conn *pgx.Conn) (map[string]int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	rows, err := conn.Query(ctx, "SELECT scope,revision FROM realtime_revisions ORDER BY scope")
	if err != nil {
		return nil, ErrUnavailable
	}
	defer rows.Close()
	versions := make(map[string]int64, 4)
	for rows.Next() {
		var scope string
		var revision int64
		if rows.Scan(&scope, &revision) != nil || revision < 0 {
			return nil, ErrUnavailable
		}
		if scope != "inventory" && scope != "transfers:1" && scope != "transfers:2" && scope != "transfers:3" {
			return nil, ErrUnavailable
		}
		if _, exists := versions[scope]; exists {
			return nil, ErrUnavailable
		}
		versions[scope] = revision
	}
	if rows.Err() != nil || len(versions) != 4 {
		return nil, ErrUnavailable
	}
	return versions, nil
}
func (b *Broker) install(versions map[string]int64, event Event, audience int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stopped || b.ctx.Err() != nil {
		return false
	}
	for key, old := range b.versions {
		if versions[key] < old {
			return false
		}
	}
	b.versions = versions
	if event == Resync {
		b.ready = true
		b.initialOnce.Do(func() { close(b.initial) })
		return true
	}
	if !b.ready {
		return false
	}
	for id, s := range b.subscribers {
		if event == Transfers && s.location != audience {
			continue
		}
		select {
		case s.queue <- event:
		default:
			close(s.queue)
			delete(b.subscribers, id)
		}
	}
	return true
}
func (b *Broker) listen(conn *pgx.Conn) error {
	ctx, cancel := context.WithTimeout(b.ctx, 5*time.Second)
	defer cancel()
	tx, err := conn.Begin(ctx)
	if err != nil {
		return ErrUnavailable
	}
	if _, err = tx.Exec(ctx, "LISTEN "+channel); err != nil {
		return ErrUnavailable
	}
	if tx.Commit(ctx) != nil {
		return ErrUnavailable
	}
	// LISTEN commit precedes the fresh snapshot. Notifications during/after the
	// query remain queued, closing the startup race; duplicate resyncs are safe.
	versions, err := readRevisions(ctx, conn)
	if err != nil || !b.install(versions, Resync, 0) {
		return ErrUnavailable
	}
	return nil
}
func (b *Broker) wait(conn *pgx.Conn) error {
	for {
		notification, err := conn.WaitForNotification(b.ctx)
		if err != nil {
			return ErrUnavailable
		}
		event, audience, valid := parsePayload(notification.Payload)
		if notification.Channel != channel || !valid {
			return ErrUnavailable
		}
		versions, err := readRevisions(b.ctx, conn)
		if err != nil || !b.install(versions, event, audience) {
			return ErrUnavailable
		}
	}
}
func (b *Broker) run() {
	defer close(b.done)
	defer func() { b.mu.Lock(); b.stopped = true; b.ready = false; b.closeSubscribersLocked(); b.mu.Unlock() }()
	delay := 100 * time.Millisecond
	for b.ctx.Err() == nil {
		connectCtx, cancel := context.WithTimeout(b.ctx, 5*time.Second)
		conn, err := pgx.ConnectConfig(connectCtx, b.cfg.Copy())
		cancel()
		if err == nil {
			if b.listen(conn) == nil {
				delay = 100 * time.Millisecond
				_ = b.wait(conn)
			}
			// Close subscribers before potentially slow network connection cleanup.
			b.unavailable()
			closeCtx, finish := context.WithTimeout(context.Background(), 3*time.Second)
			_ = conn.Close(closeCtx)
			finish()
		} else {
			b.unavailable()
		}
		timer := time.NewTimer(delay)
		select {
		case <-b.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if delay < 2*time.Second {
			delay *= 2
			if delay > 2*time.Second {
				delay = 2 * time.Second
			}
		}
	}
}
