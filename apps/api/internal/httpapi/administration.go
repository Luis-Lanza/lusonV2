package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"luson/api/internal/auth"
)

func (a *API) registerAdministration(mux *http.ServeMux) {
	mux.HandleFunc("/api/admin/", a.administration)
}

func administrationFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, auth.ErrSession):
		failure(w, 401, "unauthenticated")
	case errors.Is(err, auth.ErrAdminForbidden):
		failure(w, 403, "forbidden")
	case errors.Is(err, auth.ErrAdminInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, auth.ErrAdminNotFound):
		failure(w, 404, "not_found")
	case errors.Is(err, auth.ErrBranchStock):
		failure(w, 409, "branch_has_stock")
	case errors.Is(err, auth.ErrBranchUsers):
		failure(w, 409, "branch_has_users")
	case errors.Is(err, auth.ErrBranchPending):
		failure(w, 409, "branch_has_pending_operations")
	case errors.Is(err, auth.ErrAdminConflict):
		failure(w, 409, "conflict")
	case errors.Is(err, auth.ErrLimited):
		w.Header().Set("Retry-After", "60")
		failure(w, 429, "rate_limited")
	default:
		failure(w, 503, "service_unavailable")
	}
}

// A bounded flat scalar object: no aliases, duplicates, nulls, unknown fields,
// arrays or nested objects. Tokens preserve integer grammar and password bytes.
func administrationFields(r *http.Request, allowed ...string) (map[string]any, error) {
	if len(r.Header.Values("Content-Type")) != 1 {
		return nil, auth.ErrAdminInvalid
	}
	kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || kind != "application/json" {
		return nil, auth.ErrAdminInvalid
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4097))
	if err != nil || len(body) > 4096 || !utf8.Valid(body) {
		return nil, auth.ErrAdminInvalid
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.UseNumber()
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return nil, auth.ErrAdminInvalid
	}
	fields := map[string]any{}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return nil, auth.ErrAdminInvalid
		}
		name, ok := key.(string)
		if !ok {
			return nil, auth.ErrAdminInvalid
		}
		known := false
		for _, field := range allowed {
			known = known || name == field
		}
		if _, duplicate := fields[name]; !known || duplicate {
			return nil, auth.ErrAdminInvalid
		}
		value, err := decoder.Token()
		if err != nil || value == nil {
			return nil, auth.ErrAdminInvalid
		}
		switch value.(type) {
		case string, bool, json.Number:
		default:
			return nil, auth.ErrAdminInvalid
		}
		fields[name] = value
	}
	last, err := decoder.Token()
	if err != nil || last != json.Delim('}') {
		return nil, auth.ErrAdminInvalid
	}
	if _, err = decoder.Token(); err != io.EOF {
		return nil, auth.ErrAdminInvalid
	}
	return fields, nil
}
func administrationText(fields map[string]any, key string) (string, bool) {
	value, ok := fields[key].(string)
	return value, ok
}
func administrationLocation(fields map[string]any) (int, bool) {
	value, ok := fields["location_id"].(json.Number)
	if !ok {
		return 0, false
	}
	text := value.String()
	n, err := strconv.ParseInt(text, 10, 16)
	return int(n), err == nil && n > 1 && strconv.FormatInt(n, 10) == text
}
func administrationID(raw string) (int64, bool) {
	n, err := strconv.ParseInt(raw, 10, 64)
	return n, err == nil && n > 0 && strconv.FormatInt(n, 10) == raw
}

func (a *API) administration(w http.ResponseWriter, r *http.Request) {
	token, unique := readCookie(r, sessionCookie)
	if !unique {
		failure(w, 400, "invalid_request")
		return
	}
	if token == "" {
		failure(w, 401, "unauthenticated")
		return
	}
	// Authorization precedes method, payload and hashing work; no cookie writes or
	// idle renewal occur on rejected administration requests.
	if err := a.service.Administrator(r.Context(), token); err != nil {
		administrationFailure(w, err)
		return
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.EscapedPath() != r.URL.Path {
		failure(w, 400, "invalid_request")
		return
	}
	if r.Method == http.MethodGet {
		if _, valid := passiveMode(r); !valid {
			failure(w, 400, "invalid_request")
			return
		}
		if !optionalSameOrigin(r, "Origin", a.cfg.Origin) || !optionalSameOrigin(r, "Sec-Fetch-Site", "same-origin") {
			failure(w, 403, "forbidden")
			return
		}
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/admin/")
	switch path {
	case "accounts":
		if r.Method == http.MethodGet {
			accounts, err := a.service.ListAccounts(r.Context(), token)
			if err != nil {
				administrationFailure(w, err)
				return
			}
			respond(w, 200, accounts)
			return
		}
		if !method(w, r, http.MethodPost) || !a.GuardMutation(w, r) {
			return
		}
		fields, err := administrationFields(r, "username", "display_name", "location_id", "temporary_password")
		if err != nil {
			administrationFailure(w, err)
			return
		}
		username, u := administrationText(fields, "username")
		display, d := administrationText(fields, "display_name")
		password, p := administrationText(fields, "temporary_password")
		location, l := administrationLocation(fields)
		if len(fields) != 4 || !u || !d || !p || !l {
			failure(w, 400, "invalid_request")
			return
		}
		account, err := a.service.CreateOperator(r.Context(), token, auth.NewOperator{Username: username, DisplayName: display, LocationID: location, TemporaryPassword: password})
		if err != nil {
			administrationFailure(w, err)
			return
		}
		respond(w, 201, account)
	case "branches":
		if r.Method == http.MethodGet {
			branches, err := a.service.ListBranches(r.Context(), token)
			if err != nil {
				administrationFailure(w, err)
				return
			}
			respond(w, 200, branches)
			return
		}
		if !method(w, r, http.MethodPost) || !a.GuardMutation(w, r) {
			return
		}
		fields, err := administrationFields(r, "name")
		if err != nil {
			administrationFailure(w, err)
			return
		}
		name, ok := administrationText(fields, "name")
		if !ok || len(fields) != 1 {
			failure(w, 400, "invalid_request")
			return
		}
		branch, err := a.service.CreateBranch(r.Context(), token, name)
		if err != nil {
			administrationFailure(w, err)
			return
		}
		respond(w, 201, branch)
	default:
		parts := strings.Split(path, "/")
		if len(parts) == 2 && parts[0] == "branches" {
			id, ok := administrationID(parts[1])
			if !ok || id > 32767 {
				failure(w, 400, "invalid_request")
				return
			}
			if !method(w, r, http.MethodDelete) || !a.GuardMutation(w, r) {
				return
			}
			if err := a.service.RetireBranch(r.Context(), token, id); err != nil {
				administrationFailure(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if (len(parts) != 2 && len(parts) != 3) || parts[0] != "accounts" || (len(parts) == 3 && parts[2] != "password") {
			failure(w, 404, "not_found")
			return
		}
		id, ok := administrationID(parts[1])
		if !ok {
			failure(w, 400, "invalid_request")
			return
		}
		if len(parts) == 3 {
			if !method(w, r, http.MethodPost) || !a.GuardMutation(w, r) {
				return
			}
			if id == 1 {
				failure(w, 403, "forbidden")
				return
			}
			fields, err := administrationFields(r, "temporary_password")
			if err != nil {
				administrationFailure(w, err)
				return
			}
			password, ok := administrationText(fields, "temporary_password")
			if !ok || len(fields) != 1 {
				failure(w, 400, "invalid_request")
				return
			}
			if err = a.service.ResetOperatorPassword(r.Context(), token, id, password); err != nil {
				administrationFailure(w, err)
				return
			}
		} else if r.Method == http.MethodDelete {
			if !a.GuardMutation(w, r) {
				return
			}
			if err := a.service.RetireOperator(r.Context(), token, id); err != nil {
				administrationFailure(w, err)
				return
			}
		} else {
			if r.Method != http.MethodPatch {
				w.Header().Set("Allow", "PATCH, DELETE")
				failure(w, 405, "method_not_allowed")
				return
			}
			if !a.GuardMutation(w, r) {
				return
			}
			fields, err := administrationFields(r, "display_name", "location_id", "enabled")
			if err != nil {
				administrationFailure(w, err)
				return
			}
			update := auth.OperatorUpdate{}
			for key := range fields {
				switch key {
				case "display_name":
					value, ok := administrationText(fields, key)
					if !ok {
						failure(w, 400, "invalid_request")
						return
					}
					update.DisplayName = &value
				case "location_id":
					value, ok := administrationLocation(fields)
					if !ok {
						failure(w, 400, "invalid_request")
						return
					}
					update.LocationID = &value
				case "enabled":
					value, ok := fields[key].(bool)
					if !ok {
						failure(w, 400, "invalid_request")
						return
					}
					update.Enabled = &value
				}
			}
			if err = a.service.UpdateOperator(r.Context(), token, id, update); err != nil {
				administrationFailure(w, err)
				return
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
