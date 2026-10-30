package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"luson/api/internal/auth"
)

// Only public HTTP observations: metadata/direct inventory retirement is slice B.
func branchRetirementDirectory(t *testing.T, f *t5Fixture) string {
	t.Helper()
	w := f.request(f.tokens[0], "GET", "/api/admin/branches", "")
	if w.Code != 200 || len(w.Result().Cookies()) != 0 {
		t.Fatal("branch directory unavailable")
	}
	var rows []struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	}
	d := json.NewDecoder(strings.NewReader(w.Body.String()))
	d.DisallowUnknownFields()
	if d.Decode(&rows) != nil {
		t.Fatal("branch directory changed strict DTO")
	}
	return w.Body.String()
}
func branchRetirementCreate(t *testing.T, f *t5Fixture) {
	t.Helper()
	t5Exact(t, f.request(f.tokens[0], "POST", "/api/admin/branches", `{"name":"Sucursal Retiro"}`), 201, "{\"id\":4,\"name\":\"Sucursal Retiro\"}\n")
}
func branchRetirementBlocked(t *testing.T, f *t5Fixture, path, code string) {
	t.Helper()
	before, stock := f.snapshot(), f.oldInventory()
	directory := branchRetirementDirectory(t, f)
	t5Error(t, f.request(f.tokens[0], "DELETE", path, ""), 409, code)
	if f.snapshot() != before || f.oldInventory() != stock || branchRetirementDirectory(t, f) != directory {
		t.Fatal("blocked retirement changed public directories, stock or counters")
	}
}

func TestBranchRetirementSuccess(t *testing.T) {
	f := t5Setup(t)
	original := branchRetirementDirectory(t, f)
	accounts, stock := f.accounts(), f.oldInventory()
	branchRetirementCreate(t, f)
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/branches/4", ""), 204, "")
	if branchRetirementDirectory(t, f) != original || !reflect.DeepEqual(f.accounts(), accounts) || f.oldInventory() != stock {
		t.Fatal("retirement must omit only target and preserve surviving DTOs/accounts/stock")
	}
	before := f.snapshot()
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/branches/4", ""), 204, "")
	t5Error(t, f.request(f.tokens[0], "DELETE", "/api/admin/branches/99", ""), 404, "not_found")
	t5Error(t, f.request(f.tokens[0], "DELETE", "/api/admin/branches/1", ""), 403, "forbidden")
	if f.snapshot() != before {
		t.Fatal("repeat/unknown/protected retirement changed public state")
	}
	retirementSurvivors(t, f)
}

func TestBranchRetirementAssignedUsers(t *testing.T) {
	f := t5Setup(t)
	original := branchRetirementDirectory(t, f)
	branchRetirementCreate(t, f)
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"location_id":4}`), 204, "")
	branchRetirementBlocked(t, f, "/api/admin/branches/4", "branch_has_users")
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"enabled":false}`), 204, "")
	if list := f.accounts(); len(list) != 3 || list[1].Enabled || list[1].LocationID != 4 {
		t.Fatal("disabled assigned user fixture")
	}
	branchRetirementBlocked(t, f, "/api/admin/branches/4", "branch_has_users")
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/accounts/2", ""), 204, "")
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/branches/4", ""), 204, "")
	if branchRetirementDirectory(t, f) != original {
		t.Fatal("eligible branch stayed in directory")
	}
	if list := f.accounts(); len(list) != 2 || list[0].ID != "1" || list[1].ID != "3" {
		t.Fatal("user retirement directory")
	}
	retirementDetached(t, f, f.tokens[1])
	retirementSurvivors(t, f)
}

func TestBranchRetirementStock(t *testing.T) {
	f := t5Setup(t)
	// LocalTrial seed gives variant 1 at branch 2: (7+22)%31 = 29.
	// Remove its sole user publicly so stock is the only remaining blocker.
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/accounts/2", ""), 204, "")
	t8Stock(t, f, 2, 29, 0)
	branchRetirementBlocked(t, f, "/api/admin/branches/2", "branch_has_stock")
	t8Stock(t, f, 2, 29, 0)
	retirementSurvivors(t, f)
}

func TestBranchRetirementPendingHistory(t *testing.T) {
	f := t5Setup(t)
	original := branchRetirementDirectory(t, f)
	branchRetirementCreate(t, f)
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"location_id":4}`), 204, "")
	token := retirementLogin(t, f, 1)
	// Seed warehouse variant 1 has 18 available; this requests just 2.
	t8Stock(t, f, 1, 18, 0)
	t8Stock(t, f, 4, 0, 0)
	created := t8Decode(t, f.request(token, "POST", "/api/transfers", t8Body("request_stock", 1, "branch-retirement-pending-01")), 201)
	if created.Status != "pending" || created.Origin != 1 || created.Destination != 4 || len(created.Activity) != 1 {
		t.Fatal("pending request fixture")
	}
	actor := created.Activity[0]
	if actor.Action != "create" || actor.Actor.AccountID != "2" || actor.Actor.Username != f.creds[1].Username || actor.Actor.DisplayName != "Persona" || actor.LocationID != 4 || actor.LocationName != "Sucursal Retiro" {
		t.Fatal("creation personal actor/location snapshot")
	}
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/accounts/2", ""), 204, "")
	path := "/api/transfers/" + created.ID
	beforeDetail := f.request(f.tokens[0], "GET", path, "")
	if beforeDetail.Code != 200 {
		t.Fatal("warehouse pending detail unavailable")
	}
	branchRetirementBlocked(t, f, "/api/admin/branches/4", "branch_has_pending_operations")
	t5Exact(t, f.request(f.tokens[0], "GET", path, ""), 200, beforeDetail.Body.String())
	t8Stock(t, f, 4, 0, 0)
	rejected := t8Decode(t, f.request(f.tokens[0], "POST", path+"/reject", "{}"), 200)
	if rejected.Status != "rejected" || rejected.ID != created.ID || len(rejected.Activity) != 2 || !reflect.DeepEqual(rejected.Activity[0], actor) {
		t.Fatal("resolution changed immutable creation evidence")
	}
	settled := f.request(f.tokens[0], "GET", path, "")
	if settled.Code != 200 {
		t.Fatal("resolved detail unavailable")
	}
	history := f.request(f.tokens[0], "GET", "/api/transfers?status=rejected", "")
	var page struct {
		Records []t8Record `json:"records"`
		Total   string     `json:"total_count"`
	}
	if history.Code != 200 || json.Unmarshal(history.Body.Bytes(), &page) != nil || page.Total != "1" || len(page.Records) != 1 || page.Records[0].ID != created.ID {
		t.Fatal("resolved history membership")
	}
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/branches/4", ""), 204, "")
	if branchRetirementDirectory(t, f) != original {
		t.Fatal("resolved branch not omitted")
	}
	// Full detail equality pins IDs, names, items, actors and immutable activity.
	t5Exact(t, f.request(f.tokens[0], "GET", path, ""), 200, settled.Body.String())
	t5Exact(t, f.request(f.tokens[0], "GET", "/api/transfers?status=rejected", ""), 200, history.Body.String())
	t8Stock(t, f, 1, 18, 0)
	retirementDetached(t, f, token)
	retirementSurvivors(t, f)
}

func TestBranchRetirementGuards(t *testing.T) {
	f := t5Setup(t)
	before, stock := f.snapshot(), f.oldInventory()
	for _, tc := range []struct {
		name, token, method, origin, csrf, fetch, id string
		status                                       int
		code                                         string
	}{
		{"anonymous", "", "DELETE", "http://localhost:8080", "", "", "2", 401, "unauthenticated"},
		{"operator", f.tokens[1], "DELETE", "http://localhost:8080", auth.CSRF(f.tokens[1]), "", "2", 403, "forbidden"},
		{"authority before method", f.tokens[1], "PUT", "http://localhost:8080", auth.CSRF(f.tokens[1]), "", "2", 403, "forbidden"},
		{"origin", f.tokens[0], "DELETE", "https://evil.test", auth.CSRF(f.tokens[0]), "", "2", 403, "forbidden"},
		{"csrf", f.tokens[0], "DELETE", "http://localhost:8080", "", "", "2", 403, "forbidden"},
		{"fetch site", f.tokens[0], "DELETE", "http://localhost:8080", auth.CSRF(f.tokens[0]), "cross-site", "2", 403, "forbidden"},
		{"protected warehouse", f.tokens[0], "DELETE", "http://localhost:8080", auth.CSRF(f.tokens[0]), "", "1", 403, "forbidden"},
		{"canonical ID", f.tokens[0], "DELETE", "http://localhost:8080", auth.CSRF(f.tokens[0]), "", "02", 400, "invalid_request"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &t5Unread{}
			r := httptest.NewRequest(tc.method, "/api/admin/branches/"+tc.id, b)
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("X-CSRF-Token", tc.csrf)
			r.Header.Set("Sec-Fetch-Site", tc.fetch)
			if tc.token != "" {
				r.AddCookie(&http.Cookie{Name: "luson_session", Value: tc.token})
			}
			w := httptest.NewRecorder()
			f.h.ServeHTTP(w, r)
			t5Error(t, w, tc.status, tc.code)
			if b.read {
				t.Fatal("rejected retirement read body")
			}
			if f.snapshot() != before || f.oldInventory() != stock {
				t.Fatal("guard rejection changed public state/stock/counters")
			}
		})
	}
	retirementSurvivors(t, f)
	if w := f.request(f.tokens[1], "GET", "/api/inventory?location_id=2", ""); w.Code != 200 {
		t.Fatal("guard rejection retired assigned user")
	}
}
