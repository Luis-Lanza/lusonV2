// Package suppliers owns the warehouse supplier administration domain. A supplier
// is the counterparty of a stock ingress document and it offers catalogue ENTRIES,
// not variants: a battery is offered as its brand and model and a product as its
// name, while an ingress document keeps naming variants. The database is the
// authority for the two operating rules of the association — a retired supplier
// never gains offers and a retired catalogue entry is never offered again — so this
// package sends the final set and publishes the database's own refusal.
//
// The vertical is money-free: it records who supplied what and no cost, price,
// invoice or account.
package suppliers

import (
	"context"
	"errors"
	"math"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/catalog"
)

var (
	// ErrInvalid is a document, an identity or a filter this contract cannot admit.
	ErrInvalid = errors.New("invalid supplier")
	// ErrForbidden is an identity that is not the warehouse administrator.
	ErrForbidden = errors.New("supplier forbidden")
	// ErrNotFound is an unknown supplier, or an edit of a retired one.
	ErrNotFound = errors.New("supplier not found")
	// ErrConflict is an operating refusal: a duplicate active name, a repeated
	// retirement, or an assignment to a retired supplier.
	ErrConflict = errors.New("supplier conflict")
	// ErrUnavailable is a store or a persisted record this domain cannot publish.
	ErrUnavailable = errors.New("supplier store unavailable")
)

const (
	// Only the warehouse account (id 1) assigned to location 1 administers suppliers,
	// exactly like the rest of the admin surface.
	warehouseAccountID  = 1
	warehouseLocationID = 1
)

const (
	// minName and maxName are the admitted byte length of a supplier name, measured
	// after trimming. The column's own check counts characters, so the byte bound is
	// the stricter of the two and nothing admitted here is refused there.
	minName = 3
	maxName = 64
	// maxContact is the admitted length of the free contact text, counted in
	// characters like the column does. The contact is never trimmed.
	maxContact = 200
	// maxSearch is the free-text bound of the two catalogue reads, counted in runes.
	maxSearch = 128
	// MaxOffers is the admitted size of one supplier's final offer set.
	MaxOffers = 200
	// OfferedVariantsPageSize is what the ingress picker read publishes: twice
	// MaxOffers, because a battery entry expands to its polarities, so every set a
	// supplier may legally offer fits in one read.
	OfferedVariantsPageSize = 500
	// maxEntryID is the catalogue entry identity bound: the column is an integer, so
	// an identity outside it never reaches a statement.
	maxEntryID = math.MaxInt32
)

// MaxPage, DefaultPageSize and the admitted page sizes are the frozen read bounds
// of this contract, checked before any statement.
const (
	MaxPage         = 1_000_000
	DefaultPageSize = 10
	pageSizeSmall   = 10
	pageSizeMedium  = 25
	pageSizeLarge   = 50
)

// Supplier is the created or edited supplier: the allocated identity, the name and
// the free contact text. It never carries the offer set, because an edit changes the
// name and the contact only.
type Supplier struct {
	ID      int64
	Name    string
	Contact string
}

// CreateInput is one supplier creation: the whole editable document.
type CreateInput struct {
	Name    string
	Contact string
}

// EditInput is one replacement of an active supplier. It carries the name and the
// contact and never an id: the id is the path's identity, not an editable field.
type EditInput struct {
	Name    string
	Contact string
}

// Offer is one catalogue ENTRY the supplier offers. The battery attributes and the
// product name are mutually exclusive because the catalogue is: an entry carries one
// shape or the other. Capacity travels as the canonical decimal text and never as a
// float, and an entry carries no polarity, because polarity is a property of a
// variant and the assignment is entry level.
type Offer struct {
	CatalogEntryID int64
	Kind           catalog.Kind
	Brand          string
	Model          string
	Capacity       string
	Name           string
}

// Summary is one row of the suppliers list: the record, its retirement marker, the
// kinds derived from its offers and the exact number of offers.
type Summary struct {
	ID      int64
	Name    string
	Contact string
	Retired bool
	Kinds   []catalog.Kind
	Offers  int64
}

// Page is one page of the suppliers list together with the total of suppliers.
type Page struct {
	Suppliers []Summary
	Page      int
	PageSize  int
	Total     int64
}

// Detail is one supplier with its current offer set. The set is state, not history:
// it is always the whole set the last assignment wrote.
type Detail struct {
	ID      int64
	Name    string
	Contact string
	Retired bool
	Offers  []Offer
	Kinds   []catalog.Kind
}

// EntryQuery is the read filter of the assignable catalogue: the kind, which is
// absent for both kinds, the literal search and the admitted page size. The read has
// no page parameter, so the search is what narrows a long catalogue.
type EntryQuery struct {
	Kind     catalog.Kind
	Search   string
	PageSize int
}

// EntryPage is the first page of the assignable catalogue plus the total of
// matching entries, so a truncated read stays visible.
type EntryPage struct {
	Entries  []Offer
	PageSize int
	Total    int64
}

// VariantQuery is the read filter of the ingress picker: the kind, absent for both,
// and the literal search. The read is bounded by OfferedVariantsPageSize.
type VariantQuery struct {
	Kind   catalog.Kind
	Search string
}

// Variant is one variant a supplier offers, with the typed catalogue identity every
// warehouse screen already reads. It carries no stock number at all.
type Variant struct {
	catalog.Identity
	CatalogEntryID int64
}

// VariantPage is one bounded page of the variants a supplier offers.
type VariantPage struct {
	Items    []Variant
	PageSize int
}

// CanonicalName admits a supplier name and returns the trimmed form the column
// holds. A name that is invalid UTF-8, or that still carries a control character or
// a NUL after trimming, or is shorter than 3 or longer than 64 bytes after trimming
// is refused, so no untrimmed, control-bearing or over-long name ever reaches the
// database.
func CanonicalName(value string) (string, error) {
	if !utf8.ValidString(value) {
		return "", ErrInvalid
	}
	name := strings.TrimSpace(value)
	if !validText(name) {
		return "", ErrInvalid
	}
	if len(name) < minName || len(name) > maxName {
		return "", ErrInvalid
	}
	return name, nil
}

// CanonicalContact admits the free contact text and returns it exactly as typed: it
// is free text, so it is never trimmed, and the empty contact is the absence of one.
// The bounds are the column's own — 200 characters — and a control character never
// belongs to a contact.
func CanonicalContact(value string) (string, error) {
	if !utf8.ValidString(value) || !validText(value) {
		return "", ErrInvalid
	}
	if utf8.RuneCountInString(value) > maxContact {
		return "", ErrInvalid
	}
	return value, nil
}

// validText admits text without a NUL or a control character.
func validText(value string) bool {
	for _, r := range value {
		if r == 0 || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// CanonicalCreate decides the whole creation: the name and the contact.
func CanonicalCreate(in CreateInput) (CreateInput, error) {
	name, err := CanonicalName(in.Name)
	if err != nil {
		return CreateInput{}, err
	}
	contact, err := CanonicalContact(in.Contact)
	if err != nil {
		return CreateInput{}, err
	}
	return CreateInput{Name: name, Contact: contact}, nil
}

// CanonicalEdit decides the whole replacement: the name and the contact, never a
// partial document and never the offer set.
func CanonicalEdit(in EditInput) (EditInput, error) {
	name, err := CanonicalName(in.Name)
	if err != nil {
		return EditInput{}, err
	}
	contact, err := CanonicalContact(in.Contact)
	if err != nil {
		return EditInput{}, err
	}
	return EditInput{Name: name, Contact: contact}, nil
}

// CanonicalOffers decides the final offer set before any statement runs: every
// identity inside the catalogue bound, no more than MaxOffers, and the set reduced to
// its ascending, unrepeated order, because the list is the whole set and neither
// order nor repetition carries meaning. The caller's slice is never modified.
func CanonicalOffers(ids []int64) ([]int32, error) {
	if len(ids) > MaxOffers {
		return nil, ErrInvalid
	}
	seen := make(map[int32]bool, len(ids))
	set := make([]int32, 0, len(ids))
	for _, id := range ids {
		if id < 1 || id > maxEntryID {
			return nil, ErrInvalid
		}
		entry := int32(id)
		if seen[entry] {
			continue
		}
		seen[entry] = true
		set = append(set, entry)
	}
	// The set is stored and published in ascending order, so every reader states it
	// the same way and every writer inserts in the same order.
	slices.Sort(set)
	return set, nil
}

// ValidPage admits only the page and page size of the frozen read contract, so every
// other value is refused before the database is touched.
func ValidPage(page, pageSize int) bool {
	return page >= 1 && page <= MaxPage &&
		(pageSize == pageSizeSmall || pageSize == pageSizeMedium || pageSize == pageSizeLarge)
}

// ValidEntryQuery admits the assignable catalogue filter: one of the three admitted
// page sizes, the absent or one of the two catalogue kinds, and a search inside the
// database's own text bounds. The absent kind lists both kinds, so "all" is not an
// alias here.
func ValidEntryQuery(q EntryQuery) bool {
	return validKind(q.Kind) && validSearch(q.Search) &&
		(q.PageSize == pageSizeSmall || q.PageSize == pageSizeMedium || q.PageSize == pageSizeLarge)
}

// ValidVariantQuery admits the ingress picker filter: the absent or one of the two
// catalogue kinds and a search inside the database's own text bounds.
func ValidVariantQuery(q VariantQuery) bool {
	return validKind(q.Kind) && validSearch(q.Search)
}

func validKind(kind catalog.Kind) bool {
	return kind == "" || kind == catalog.BatteryKind || kind == catalog.OtherKind
}

func validSearch(search string) bool {
	return utf8.ValidString(search) && !strings.ContainsRune(search, 0) &&
		utf8.RuneCountInString(search) <= maxSearch
}

// Kinds derives the kinds a supplier offers from its own offer set, in the
// catalogue's order — battery first, then other — so every surface states them the
// same way. A supplier with no offer has an empty list, never a null one.
func Kinds(offers []Offer) []catalog.Kind {
	kinds := []catalog.Kind{}
	var battery, other bool
	for _, offer := range offers {
		switch offer.Kind {
		case catalog.BatteryKind:
			battery = true
		case catalog.OtherKind:
			other = true
		}
	}
	if battery {
		kinds = append(kinds, catalog.BatteryKind)
	}
	if other {
		kinds = append(kinds, catalog.OtherKind)
	}
	return kinds
}

// WarehouseAdmin admits only the completed warehouse administrator identity: account
// 1 assigned to location 1 with no pending password change.
func WarehouseAdmin(actor auth.Identity) bool {
	return actor.AccountID == warehouseAccountID && actor.Location.ID == warehouseLocationID &&
		!actor.MustChangePassword
}

// Store is the supplier administration store. It holds the pool and rechecks the
// warehouse administrator authority inside every operation, so a caller outside the
// HTTP surface cannot write either.
type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// Authorize applies the warehouse administrator gate and its provisioned-account
// binding, so the HTTP surface can refuse every other identity before any method,
// framing or body work, exactly like the rest of the admin surface.
func (s *Store) Authorize(ctx context.Context, actor auth.Identity) error {
	if ctx == nil || s == nil || s.pool == nil {
		return ErrUnavailable
	}
	if !WarehouseAdmin(actor) {
		return ErrForbidden
	}
	return checkAssignment(ctx, s.pool, actor)
}

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// checkAssignment reuses creation's provisioned-account binding: a positive location
// id alone is not evidence that this account is assigned to it.
func checkAssignment(ctx context.Context, q querier, actor auth.Identity) error {
	var provisioned bool
	if err := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM auth_accounts WHERE id=$1 AND location_id=$2)",
		actor.AccountID, actor.Location.ID).Scan(&provisioned); err != nil {
		return fail(ctx)
	}
	if !provisioned {
		return ErrForbidden
	}
	return nil
}

// fail retains cancellation semantics but never driver/config/SQL details.
func fail(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrUnavailable
}

func pgError(err error) *pgconn.PgError {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg
	}
	return nil
}

// writeError publishes the database's own refusal of a creation or an edit: a
// duplicate active name is a conflict, and a name the shape refuses is an invalid
// request.
func writeError(err error) error {
	if pg := pgError(err); pg != nil {
		switch pg.Code {
		case "23505":
			return ErrConflict
		case "23503", "23514", "22001", "22003", "22P02":
			return ErrInvalid
		}
	}
	return err
}

// offerError publishes the database's own refusal of an assignment. The two
// retirement guards are the database's: LV002 is an unknown or retired catalogue
// entry, which is a rejected request, and LV001 is an unknown or retired supplier,
// which the pre-check normally answers precisely and the trigger answers as a
// conflict.
func offerError(err error) error {
	if pg := pgError(err); pg != nil {
		switch pg.Code {
		case "LV002":
			return ErrInvalid
		case "LV001":
			return ErrConflict
		case "23503", "23505", "23514", "22001", "22003", "22P02":
			return ErrInvalid
		}
	}
	return err
}

// storedSupplier validates one persisted supplier row and returns it in the shape
// this contract publishes. A row this contract could not publish is a store failure,
// never a supplier with an untrimmed name or an over-long contact.
func storedSupplier(id int64, name, contact string) (Supplier, error) {
	canonical, err := CanonicalName(name)
	if err != nil || canonical != name || id < 1 {
		return Supplier{}, ErrUnavailable
	}
	if _, err := CanonicalContact(contact); err != nil {
		return Supplier{}, ErrUnavailable
	}
	return Supplier{ID: id, Name: canonical, Contact: contact}, nil
}

// storedOffer validates one persisted catalogue entry row and returns the offer
// shape this contract publishes: the battery attributes of a battery entry and the
// free name of a product entry, never both and never the other one invented.
func storedOffer(id int64, kind, brand, model, capacity, name string) (Offer, error) {
	if id < 1 || id > maxEntryID {
		return Offer{}, ErrUnavailable
	}
	offer := Offer{CatalogEntryID: id}
	switch catalog.Kind(kind) {
	case catalog.BatteryKind:
		// A numeric column never travels as a float: its own text is parsed back into
		// the canonical decimal of the contract.
		decimal, err := catalog.ParseDecimal(capacity)
		if err != nil || !validText(brand) || !validText(model) ||
			brand == "" || model == "" || name != "" {
			return Offer{}, ErrUnavailable
		}
		offer.Kind = catalog.BatteryKind
		offer.Brand, offer.Model, offer.Capacity = brand, model, string(decimal)
	case catalog.OtherKind:
		if name == "" || strings.TrimSpace(name) != name || !validText(name) ||
			brand != "" || model != "" || capacity != "" {
			return Offer{}, ErrUnavailable
		}
		offer.Kind = catalog.OtherKind
		offer.Name = name
	default:
		return Offer{}, ErrUnavailable
	}
	return offer, nil
}
