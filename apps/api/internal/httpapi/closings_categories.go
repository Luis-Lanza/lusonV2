package httpapi

import (
	"io"
	"math"
	"net/http"
	"strings"

	"luson/api/internal/auth"
	"luson/api/internal/closings"
)

// This file is the administration of the motive catalogue (S3, S4, S5, S7, S9, S10, S13): the
// administrator lists every motive, adds one at the end of the list, renames one, archives one and
// reactivates one. Every route is gated by the same administration identity as /api/administration
// before any method or body work, so a branch session never reaches a statement of this surface.
// The database owns the guards of the archive (LC035 for the catch-all and LC036 for the last offered
// motive), and the store maps its own refusals; nothing of that rule is restated here.
const (
	// closingCashCategoryAdminPath is the catalogue the administration reads and creates into.
	closingCashCategoryAdminPath = "/api/admin/cash-categories"
	// closingCashCategoryAdminRenamePath renames one motive of that catalogue.
	closingCashCategoryAdminRenamePath = closingCashCategoryAdminPath + "/{id}/rename"
	// closingCashCategoryAdminRetirePath archives one motive of that catalogue.
	closingCashCategoryAdminRetirePath = closingCashCategoryAdminPath + "/{id}/retire"
	// closingCashCategoryAdminReactivatePath offers one archived motive again.
	closingCashCategoryAdminReactivatePath = closingCashCategoryAdminPath + "/{id}/reactivate"
)

// cashCategoryAdminRoute reports whether this path belongs to the administration of the catalogue.
func cashCategoryAdminRoute(path string) bool {
	return path == closingCashCategoryAdminPath ||
		strings.HasPrefix(path, closingCashCategoryAdminPath+"/")
}

// adminCashCategoryDTO is one row of the administration's catalogue exactly as the route publishes
// it (S3, S13): the identity, the label and the place of the motive, its state, and the instant and
// the account that archived it. The two retirement keys are always present, as JSON null on an active
// motive, so a reader never has to guess which keys exist.
type adminCashCategoryDTO struct {
	ID        int64   `json:"id"`
	Label     string  `json:"label"`
	SortOrder int16   `json:"sort_order"`
	State     string  `json:"state"`
	RetiredAt *string `json:"retired_at"`
	RetiredBy *string `json:"retired_by"`
}

// adminCashCategoriesDTO is the whole catalogue of the administration, archived motives included.
type adminCashCategoriesDTO struct {
	Categories []adminCashCategoryDTO `json:"categories"`
}

// adminCashCategoryAnswerDTO is the answer of one write: the motive exactly as it now stands.
type adminCashCategoryAnswerDTO struct {
	Category adminCashCategoryDTO `json:"category"`
}

// adminCashCategoryRecord admits one row the administration could have written: a positive identity
// and place, a canonical label, a state that agrees with the retirement, and an instant published as
// the RFC 3339 UTC text of this contract.
func adminCashCategoryRecord(category closings.CatalogueCategory) (adminCashCategoryDTO, error) {
	if category.ID < 1 || category.SortOrder < 1 ||
		(category.RetiredAt == nil) != (category.RetiredBy == nil) {
		return adminCashCategoryDTO{}, closings.ErrUnavailable
	}
	label, ok := closings.CanonicalLabel(category.Label)
	if !ok || label != category.Label {
		return adminCashCategoryDTO{}, closings.ErrUnavailable
	}
	record := adminCashCategoryDTO{ID: category.ID, Label: category.Label,
		SortOrder: category.SortOrder, State: "active"}
	if category.RetiredAt == nil {
		return record, nil
	}
	moment, ok := closingMoment(*category.RetiredAt)
	if !ok || category.RetiredBy == nil {
		return adminCashCategoryDTO{}, closings.ErrUnavailable
	}
	by := *category.RetiredBy
	if by == "" || strings.TrimSpace(by) != by {
		return adminCashCategoryDTO{}, closings.ErrUnavailable
	}
	record.State, record.RetiredAt, record.RetiredBy = "retired", &moment, &by
	return record, nil
}

// adminCashCategoriesRecord admits the whole catalogue in the order it is published: every row is
// the one record shape, no identity or label repeats, and the place order is the one the read
// promises.
func adminCashCategoriesRecord(categories []closings.CatalogueCategory) (adminCashCategoriesDTO, error) {
	record := adminCashCategoriesDTO{Categories: make([]adminCashCategoryDTO, 0, len(categories))}
	seenID := make(map[int64]bool, len(categories))
	seenLabel := make(map[string]bool, len(categories))
	var previousOrder int16
	previousLabel := ""
	for _, category := range categories {
		item, err := adminCashCategoryRecord(category)
		if err != nil || seenID[category.ID] || seenLabel[category.Label] ||
			(len(record.Categories) > 0 && (category.SortOrder < previousOrder ||
				(category.SortOrder == previousOrder && category.Label <= previousLabel))) {
			return adminCashCategoriesDTO{}, closings.ErrUnavailable
		}
		seenID[category.ID], seenLabel[category.Label] = true, true
		previousOrder, previousLabel = category.SortOrder, category.Label
		record.Categories = append(record.Categories, item)
	}
	return record, nil
}

// adminCashCategoryAnswer wraps one written motive in the answer of every write of this surface.
func adminCashCategoryAnswer(category closings.CatalogueCategory) (adminCashCategoryAnswerDTO, error) {
	record, err := adminCashCategoryRecord(category)
	if err != nil {
		return adminCashCategoryAnswerDTO{}, err
	}
	return adminCashCategoryAnswerDTO{Category: record}, nil
}

// adminCashCategoryIdentity is the surface gate of this catalogue: the same administration authority
// /api/administration and the warehouse catalog already use, applied before any method, payload or
// body work. Authorization therefore precedes everything else, and a refused caller never reaches a
// statement or the mutation guard.
func (a *API) adminCashCategoryIdentity(w http.ResponseWriter, r *http.Request) (auth.Identity, bool) {
	token, unique := readCookie(r, sessionCookie)
	if !unique {
		failure(w, 400, "invalid_request")
		return auth.Identity{}, false
	}
	if token == "" {
		failure(w, 401, "unauthenticated")
		return auth.Identity{}, false
	}
	if err := a.service.Administrator(r.Context(), token); err != nil {
		administrationFailure(w, err)
		return auth.Identity{}, false
	}
	session, err := a.service.Current(r.Context(), token)
	if err != nil {
		administrationFailure(w, err)
		return auth.Identity{}, false
	}
	return session.Identity, true
}

// adminCashCategories serves the administration's catalogue: the whole list, archived motives
// included, and the creation of one motive at the end of it.
func (a *API) adminCashCategories(store *closings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := a.adminCashCategoryIdentity(w, r)
		if !ok {
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, POST")
			failure(w, 405, "method_not_allowed")
			return
		}
		if !closingQueryAbsent(w, r) {
			return
		}
		if r.Method == http.MethodGet {
			categories, err := store.CashCategoryCatalogue(r.Context(), actor)
			if err != nil {
				closingFailure(w, err)
				return
			}
			record, err := adminCashCategoriesRecord(categories)
			if err != nil {
				closingFailure(w, err)
				return
			}
			respond(w, 200, record)
			return
		}
		if !a.closingMutation(w, r) {
			return
		}
		label, err := decodeAdminCashCategoryLabel(r)
		if err != nil {
			closingFailure(w, err)
			return
		}
		category, err := store.CreateCashCategory(r.Context(), actor, label)
		if err != nil {
			closingFailure(w, err)
			return
		}
		record, err := adminCashCategoryAnswer(category)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 201, record)
	}
}

// adminCashCategoryRename changes the label of one motive (S4). The movements that already named it
// keep their own copy, so no history is rewritten.
func (a *API) adminCashCategoryRename(store *closings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := a.adminCashCategoryIdentity(w, r)
		if !ok {
			return
		}
		if !method(w, r, http.MethodPost) {
			return
		}
		if !closingQueryAbsent(w, r) || !a.closingMutation(w, r) {
			return
		}
		id, err := closingPathID(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			closingFailure(w, err)
			return
		}
		label, err := decodeAdminCashCategoryLabel(r)
		if err != nil {
			closingFailure(w, err)
			return
		}
		category, err := store.RenameCashCategory(r.Context(), actor, id, label)
		if err != nil {
			closingFailure(w, err)
			return
		}
		record, err := adminCashCategoryAnswer(category)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// adminCashCategoryRetire archives one motive (S3): the database stamps the instant and the API adds
// the acting account name, and the guard of the database refuses the pinned and the last offered
// motive with their own codes.
func (a *API) adminCashCategoryRetire(store *closings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := a.adminCashCategoryIdentity(w, r)
		if !ok {
			return
		}
		if !method(w, r, http.MethodPost) {
			return
		}
		if !closingQueryAbsent(w, r) || !a.closingMutation(w, r) {
			return
		}
		id, err := closingPathID(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			closingFailure(w, err)
			return
		}
		if err := closingEmptyBody(r); err != nil {
			closingFailure(w, err)
			return
		}
		category, err := store.RetireCashCategory(r.Context(), actor, id)
		if err != nil {
			closingFailure(w, err)
			return
		}
		record, err := adminCashCategoryAnswer(category)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// adminCashCategoryReactivate offers one archived motive again (S3): both retirement facts are
// cleared and the motive is an option of the screen once more.
func (a *API) adminCashCategoryReactivate(store *closings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := a.adminCashCategoryIdentity(w, r)
		if !ok {
			return
		}
		if !method(w, r, http.MethodPost) {
			return
		}
		if !closingQueryAbsent(w, r) || !a.closingMutation(w, r) {
			return
		}
		id, err := closingPathID(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			closingFailure(w, err)
			return
		}
		if err := closingEmptyBody(r); err != nil {
			closingFailure(w, err)
			return
		}
		category, err := store.ReactivateCashCategory(r.Context(), actor, id)
		if err != nil {
			closingFailure(w, err)
			return
		}
		record, err := adminCashCategoryAnswer(category)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// decodeAdminCashCategoryLabel reads the one key of a catalogue write: a label this domain could have
// written, exactly as it is stored. An unknown key, a duplicate key, a missing label and a padded one
// are all the malformed request they are, never a silently trimmed or ignored value.
func decodeAdminCashCategoryLabel(r *http.Request) (string, error) {
	d, err := closingDecoder(r)
	if err != nil || !closingDelimiter(d, '{') {
		return "", closings.ErrInvalid
	}
	label := ""
	seen := false
	for d.More() {
		key, err := closingString(d)
		if err != nil || key != "label" || seen {
			return "", closings.ErrInvalid
		}
		seen = true
		label, err = closingString(d)
		if err != nil {
			return "", closings.ErrInvalid
		}
	}
	if !seen || !closingDelimiter(d, '}') {
		return "", closings.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return "", closings.ErrInvalid
	}
	canonical, ok := closings.CanonicalLabel(label)
	if !ok || canonical != label {
		return "", closings.ErrInvalid
	}
	return label, nil
}
