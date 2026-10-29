package httpapi

import (
	"context"
	"errors"
	"net/http"
	"path"
	"strings"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"luson/api/internal/realtime"
	"luson/api/internal/transfers"
)

const (
	passiveHeader      = "X-Luson-Passive"
	eventCheckInterval = time.Second
	eventQueryBudget   = 750 * time.Millisecond
	eventWriteBudget   = 750 * time.Millisecond
)

// NewWithRealtime opts in without registering events on either legacy factory.
func NewWithRealtime(service *auth.Service, cfg config.Auth, stock *inventory.Store, requests *transfers.Store, broker *realtime.Broker) (http.Handler, error) {
	if broker == nil {
		return nil, realtime.ErrUnavailable
	}
	if _, err := NewWithTransfers(service, cfg, stock, requests); err != nil {
		return nil, err
	}
	return compose(service, cfg, stock, requests, broker), nil
}

// Only GET recognizes this selector. Mutation methods keep Current/CSRF policy.
func passiveMode(r *http.Request) (bool, bool) {
	if r.Method != http.MethodGet {
		return false, true
	}
	values := r.Header.Values(passiveHeader)
	if len(values) == 0 {
		return false, true
	}
	return len(values) == 1 && values[0] == "1", len(values) == 1 && values[0] == "1"
}
func (a *API) lookupSession(r *http.Request, token string, passive bool) (auth.Session, error) {
	if passive {
		session, _, err := a.service.Peek(r.Context(), token)
		return session, err
	}
	return a.service.Current(r.Context(), token)
}

// Deny aliases before ServeMux can redirect/clean them; unrelated historical
// auth/inventory and the existing transfer guard retain their own behavior.
func eventsPath(w http.ResponseWriter, r *http.Request) bool {
	clean := path.Clean(r.URL.Path)
	for _, route := range []string{"/api/events", "/api/auth/validate"} {
		if r.URL.Path != route && !strings.HasPrefix(r.URL.Path, route+"/") && clean != route && !strings.HasPrefix(clean, route+"/") {
			continue
		}
		if r.URL.Path != route {
			failure(w, 404, "not_found")
			return false
		}
		if r.URL.EscapedPath() != r.URL.Path {
			failure(w, 400, "invalid_request")
			return false
		}
		return true
	}
	return true
}

// validateSession is cookie-neutral on every branch. Automatic probes must not
// call the cookie-writing session bootstrap or select touching Current.
func (a *API) validateSession(w http.ResponseWriter, r *http.Request) {
	if !method(w, r, http.MethodGet) {
		return
	}
	if _, valid := passiveMode(r); !valid {
		failure(w, 400, "invalid_request")
		return
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		failure(w, 400, "invalid_request")
		return
	}
	if !optionalSameOrigin(r, "Origin", a.cfg.Origin) || !optionalSameOrigin(r, "Sec-Fetch-Site", "same-origin") {
		failure(w, 403, "forbidden")
		return
	}
	token, unique := readCookie(r, sessionCookie)
	if !unique {
		failure(w, 400, "invalid_request")
		return
	}
	if token == "" {
		respond(w, 200, map[string]bool{"authenticated": false})
		return
	}
	session, _, err := a.eventSession(r, token)
	if errors.Is(err, auth.ErrSession) {
		respond(w, 200, map[string]bool{"authenticated": false})
		return
	}
	if err != nil {
		failure(w, 503, "service_unavailable")
		return
	}
	respond(w, 200, map[string]any{"authenticated": true, "identity": session.Identity, "csrf_token": auth.CSRF(token), "expires_at": session.ExpiresAt})
}

func optionalSameOrigin(r *http.Request, name, want string) bool {
	values := r.Header.Values(name)
	return len(values) == 0 || (len(values) == 1 && values[0] == want)
}

// ResponseController walks Unwrap without a depth bound. Preflight both targets
// through at most32 wrappers so unsupported/cyclic chains cannot hang or flush
// headers merely to discover a missing capability.
func eventCapabilities(w http.ResponseWriter) bool {
	flush, deadline := false, false
	for depth := 0; depth < 32 && w != nil; depth++ {
		if _, ok := w.(interface{ FlushError() error }); ok {
			flush = true
		}
		if _, ok := w.(http.Flusher); ok {
			flush = true
		}
		if _, ok := w.(interface{ SetWriteDeadline(time.Time) error }); ok {
			deadline = true
		}
		if flush && deadline {
			return true
		}
		unwrap, ok := w.(interface{ Unwrap() http.ResponseWriter })
		if !ok {
			return false
		}
		w = unwrap.Unwrap()
	}
	return false
}
func (a *API) eventSession(r *http.Request, token string) (auth.Session, time.Time, error) {
	ctx, cancel := context.WithTimeout(r.Context(), eventQueryBudget)
	defer cancel()
	session, deadline, err := a.service.Peek(ctx, token)
	if err == nil && session.Identity.MustChangePassword {
		return auth.Session{}, time.Time{}, auth.ErrSession
	}
	return session, deadline, err
}
func eventAuthFailure(w http.ResponseWriter, err error) {
	if errors.Is(err, auth.ErrSession) {
		failure(w, 401, "unauthenticated")
	} else {
		failure(w, 503, "service_unavailable")
	}
}
func streamFlush(rc *http.ResponseController) bool {
	if rc.Flush() != nil {
		return false
	}
	return rc.SetWriteDeadline(time.Time{}) == nil
}
func streamWrite(w http.ResponseWriter, rc *http.ResponseController, frame string) bool {
	if rc.SetWriteDeadline(time.Now().Add(eventWriteBudget)) != nil {
		return false
	}
	n, err := w.Write([]byte(frame))
	if err != nil || n != len(frame) {
		return false
	}
	return streamFlush(rc)
}
func (a *API) registerEvents(mux *http.ServeMux, broker *realtime.Broker) {
	mux.HandleFunc("/api/auth/validate", a.validateSession)
	mux.HandleFunc("/api/events", func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		if _, valid := passiveMode(r); !valid {
			failure(w, 400, "invalid_request")
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		if !optionalSameOrigin(r, "Origin", a.cfg.Origin) || !optionalSameOrigin(r, "Sec-Fetch-Site", "same-origin") {
			failure(w, 403, "forbidden")
			return
		}
		// Last-Event-ID is never authority/cursor. Bound even ignored reconnect input.
		if values := r.Header.Values("Last-Event-ID"); len(values) > 1 || (len(values) == 1 && len(values[0]) > 128) {
			failure(w, 400, "invalid_request")
			return
		}
		token, unique := readCookie(r, sessionCookie)
		if !unique {
			failure(w, 400, "invalid_request")
			return
		}
		if token == "" {
			failure(w, 401, "unauthenticated")
			return
		}
		session, expiry, err := a.eventSession(r, token)
		if err != nil {
			eventAuthFailure(w, err)
			return
		}
		if session.Identity.AccountID != session.Identity.Location.ID || session.Identity.Location.ID < 1 || session.Identity.Location.ID > 3 {
			failure(w, 403, "forbidden")
			return
		}
		if !eventCapabilities(w) {
			failure(w, 503, "service_unavailable")
			return
		}
		rc := http.NewResponseController(w)
		if rc.SetWriteDeadline(time.Time{}) != nil {
			failure(w, 503, "service_unavailable")
			return
		}
		sub, err := broker.Subscribe(session.Identity.Location.ID)
		if err != nil {
			failure(w, 503, "service_unavailable")
			return
		}
		defer sub.Close()
		// Revalidate even before the empty probe flush. No event bytes precede a
		// successful transport probe; failure after headers only ends the stream.
		_, expiry, err = a.eventSession(r, token)
		if err != nil {
			eventAuthFailure(w, err)
			return
		}
		if rc.SetWriteDeadline(time.Now().Add(eventWriteBudget)) != nil {
			failure(w, 503, "service_unavailable")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store, no-transform")
		if !streamFlush(rc) {
			return
		}
		timer := time.NewTimer(time.Second)
		defer timer.Stop()
		for {
			delay := time.Until(expiry)
			if delay <= 0 {
				return
			}
			if delay > eventCheckInterval {
				delay = eventCheckInterval
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(delay)
			frame := ""
			select {
			case <-r.Context().Done():
				return
			case event, ok := <-sub.Events:
				if !ok {
					return
				}
				switch event {
				case realtime.Resync, realtime.Inventory, realtime.Transfers:
					frame = "event: " + string(event) + "\ndata: {}\n\n"
				default:
					return
				}
			case <-timer.C:
				frame = ": heartbeat\n\n"
			}
			_, expiry, err = a.eventSession(r, token)
			if err != nil || !expiry.After(time.Now()) {
				return
			}
			if !streamWrite(w, rc, frame) {
				return
			}
		}
	})
}
